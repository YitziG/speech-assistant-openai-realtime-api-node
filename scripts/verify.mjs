#!/usr/bin/env node
// Simple deploy verification: checks root and /db/health

import dotenv from 'dotenv';
dotenv.config();

function ensureHttp(u) {
  if (!u) return u;
  if (u.startsWith('http://') || u.startsWith('https://')) return u;
  return `https://${u}`;
}

const base = ensureHttp(
  process.env.VERIFY_BASE_URL ||
  process.env.RAILWAY_URL ||
  process.env.RAILWAY_PUBLIC_DOMAIN
) || `http://localhost:${process.env.PORT || 5050}`;

const to = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));

async function getJson(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: res.status, ok: res.ok, json };
  } finally {
    clearTimeout(t);
  }
}

(async () => {
  try {
    console.log(`[verify] Base = ${base}`);
    const root = await getJson(`${base}/`);
    console.log('[verify] GET /', root.status, root.ok, root.json);

    const db = await getJson(`${base}/db/health`);
    console.log('[verify] GET /db/health', db.status, db.ok, db.json);

    if (!db.ok || db.json?.ok !== true || db.json?.connected !== true) {
      console.error('[verify] DB health failed');
      process.exit(2);
    }

    console.log('[verify] OK');
  } catch (e) {
    console.error('[verify] Error', e?.message || e);
    process.exit(1);
  }
})();

