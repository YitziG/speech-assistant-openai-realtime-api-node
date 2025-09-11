// src/lib/contacts.mjs
// Thin helper for looking up/creating Contacts by caller phone number.
import dotenv from 'dotenv';
dotenv.config();

// Dynamic imports to avoid hard dependency if DB isn't configured
async function ensureDb() {
  const db = await import('./db.mjs');
  // Kick off init if needed
  try {
    await db.initDb();
  } catch (e) {
    console.warn('[Contacts] DB init failed:', e?.message || e);
  }
  return db;
}

function normalizeDigits(input) {
  if (!input) return '';
  const s = String(input);
  // Twilio E.164 like +15551234567 or possible sip: or client: formats
  const match = s.match(/\+?([0-9]{6,})/); // take longest digit sequence
  const digits = (match ? match[1] : s).replace(/\D/g, '');
  return digits;
}

function candidateWidsFromDigits(digits) {
  if (!digits) return [];
  return [
    `${digits}@c.us`,
    `${digits}@s.whatsapp.net`,
    digits
  ];
}

export async function findContactByPhone(phone) {
  const { Contact } = await ensureDb();
  if (!Contact) {
    console.warn('[Contacts] No Contact model (missing DB_URI?).');
    return { ok: false, contact: null, reason: 'no-db' };
  }
  const { Op } = await import('sequelize');
  const digits = normalizeDigits(phone);
  const widCands = candidateWidsFromDigits(digits);

  console.log('[Contacts] Lookup start', { phone, digits, widCands });
  const contact = await Contact.findOne({
    where: {
      [Op.or]: [
        { number: digits },
        { wid: { [Op.in]: widCands } }
      ]
    }
  });
  if (contact) {
    console.log('[Contacts] Found', { id: contact.id, wid: contact.wid, number: contact.number });
    return { ok: true, contact };
  }
  console.log('[Contacts] Not found');
  return { ok: true, contact: null };
}

export async function findOrCreateByPhone(phone) {
  const { Contact } = await ensureDb();
  if (!Contact) {
    console.warn('[Contacts] No Contact model (missing DB_URI?).');
    return { ok: false, contact: null, created: false, reason: 'no-db' };
  }
  const digits = normalizeDigits(phone);
  const exists = await findContactByPhone(phone);
  if (exists.contact) return { ok: true, contact: exists.contact, created: false };

  // Default to WhatsApp-style JID to maximize future match in aibot
  const wid = `${digits}@c.us`;
  try {
    const contact = await Contact.create({ wid, number: digits });
    console.log('[Contacts] Created', { id: contact.id, wid: contact.wid, number: contact.number });
    return { ok: true, contact, created: true };
  } catch (e) {
    console.error('[Contacts] Create failed', { error: e?.message || String(e), wid, digits });
    return { ok: false, contact: null, created: false, reason: e?.message || 'create-failed' };
  }
}

export { normalizeDigits };

export async function getContactByWid(wid) {
  const { Contact } = await ensureDb();
  if (!Contact) return null;
  if (!wid) return null;
  return await Contact.findOne({ where: { wid } });
}
