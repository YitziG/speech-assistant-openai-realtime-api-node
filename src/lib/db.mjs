// src/lib/db.mjs
import dotenv from 'dotenv';
dotenv.config();

let sequelize = null;
let Contact = null;
let UserActivity = null;

function pickDbUri() {
  const candidates = [
    ['DB_URI', process.env.DB_URI],
    ['DATABASE_URL', process.env.DATABASE_URL],
    ['POSTGRES_URL', process.env.POSTGRES_URL],
    ['PG_URL', process.env.PG_URL],
    ['SUPABASE_DB_URL', process.env.SUPABASE_DB_URL],
  ];
  for (const [key, val] of candidates) {
    const trimmed = (val || '').trim();
    if (trimmed) return { uri: trimmed, source: key };
  }
  return { uri: '', source: '' };
}

function buildDialectOptions() {
  // DB_SSL can be: 'require' | 'true' | 'disable' | 'false'
  const DB_SSL = String(process.env.DB_SSL || 'require').toLowerCase();
  if (DB_SSL === 'disable' || DB_SSL === 'false' || DB_SSL === 'off' ) return {};

  // Optional custom certs
  const ca = process.env.DB_SSL_CA;
  const cert = process.env.DB_SSL_CERT;
  const key = process.env.DB_SSL_KEY;
  const base = { require: true, rejectUnauthorized: false };
  if (ca || cert || key) {
    return { ssl: { ...base, ca, cert, key } };
  }
  return { ssl: base };
}

function redactUri(uri) {
  try {
    const u = new URL(uri);
    const out = `${u.protocol}//${u.hostname}:${u.port || '5432'}${u.pathname}`;
    return out;
  } catch {
    return uri ? '<unparsed>' : '';
  }
}

function normalizeUri(input) {
  let s = String(input || '').trim();
  // Drop surrounding quotes and whitespace/newlines
  s = s.replace(/^['"]|['"]$/g, '');
  s = s.replace(/\s+/g, '');
  // Normalize common scheme variants and minor typos
  s = s.replace(/^postgresql:\/\//i, 'postgres://');
  s = s.replace(/^postgre:\/\//i, 'postgres://');
  return s;
}

async function initDb() {
  if (sequelize && Contact) {
    return { ok: true, already: true };
  }
  const picked = pickDbUri();
  const rawUri = picked.uri;
  if (!rawUri) {
    console.warn('[DB] DB_URI not set; skipping DB init. Contacts sharing disabled.');
    return { ok: false, reason: 'missing DB_URI' };
  }
  const normalized = normalizeUri(rawUri);
  const source = picked.source || 'DB_URI';
  const redacted = redactUri(normalized);
  console.log(`[DB] Attempting connection (source=${source}) DSN=${redacted}`);

  // Lazy import to avoid dependency errors if user hasn't installed yet
  const { Sequelize, DataTypes } = await import('sequelize');

  const dialectOptions = buildDialectOptions();
  sequelize = new Sequelize(normalized, {
    logging: false,
    dialect: 'postgres',
    dialectOptions
  });

  // Define ONLY the Contacts model to match `aibot/db/schema/schema.mjs`
  Contact = sequelize.define(
    'Contact',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      wid: { type: DataTypes.STRING, allowNull: false, unique: true },
      is_blocked: DataTypes.BOOLEAN,
      is_business: DataTypes.BOOLEAN,
      is_enterprise: DataTypes.BOOLEAN,
      is_group: DataTypes.BOOLEAN,
      is_me: DataTypes.BOOLEAN,
      is_my_contact: DataTypes.BOOLEAN,
      is_user: DataTypes.BOOLEAN,
      is_wa_contact: DataTypes.BOOLEAN,
      name: DataTypes.STRING,
      number: DataTypes.STRING,
      gender: {
        type: DataTypes.ENUM('Male', 'Female', 'Unset(use your best guess)'),
        allowNull: false,
        defaultValue: 'Unset(use your best guess)'
      },
      pushname: DataTypes.STRING,
      short_name: DataTypes.STRING,
      is_unlimited: { type: DataTypes.BOOLEAN, defaultValue: false },
      license_key: { type: DataTypes.STRING, allowNull: true },
      rbt: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 80 },
      streak: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }
    },
    { tableName: 'Contacts', timestamps: true }
  );

  // Minimal UserActivity model for logging usage; matches aibot schema
  UserActivity = sequelize.define(
    'UserActivity',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      contactId: { type: DataTypes.STRING, allowNull: false },
      timestamp: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      action_type: { type: DataTypes.STRING, allowNull: false },
      action_outcome: { type: DataTypes.STRING, allowNull: false },
      rbt_change: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      user_level: { type: DataTypes.INTEGER, allowNull: true },
      contextual_info: { type: DataTypes.JSONB, allowNull: true }
    },
    { tableName: 'UserActivities', underscored: true }
  );

  // Do NOT sync/alter — we share the existing table managed by `aibot` migrations
  await sequelize.authenticate();
  console.log('[DB] Connected. Contacts table is now shared with aibot. DSN:', redactUri(normalized));
  return { ok: true };
}

export { sequelize, Contact, UserActivity, initDb };
