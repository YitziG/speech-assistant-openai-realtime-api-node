// src/lib/license.mjs — DB-backed entitlements
import { Contact, UserActivity, initDb, sequelize } from './db.mjs';
import { findContactByPhone, normalizeDigits } from './contacts.mjs';

const RBT_TO_SECONDS = Number(process.env.RBT_TO_SECONDS || '3') || 3; // 1 RBT = 60 seconds
const UNLIMITED_SECONDS = Number(process.env.UNLIMITED_SECONDS || String(10 * 365 * 24 * 60 * 60)); // 10 years
const TRIAL_INIT_SECONDS = Number(process.env.TRIAL_INIT_SECONDS || process.env.TRIAL_SECONDS || '300') || 0;

function id(u) { return String(u || ''); }

async function getOrCreateContactForUser(userId) {
  await initDb();
  const res = await findContactByPhone(userId);
  if (res?.contact) return res.contact;
  // Create a minimal contact using normalized phone digits
  const digits = normalizeDigits(userId);
  const wid = `${digits}@c.us`;
  return await Contact.create({ wid, number: digits });
}

// Non-persistent view of remaining seconds based on DB state
export async function ensureEntitlement(userId) {
  const c = await getOrCreateContactForUser(userId);
  if (!c) return { trialLeft: 0, paidLeft: 0 };
  if (c.is_unlimited) return { trialLeft: 0, paidLeft: UNLIMITED_SECONDS };
  const rbt = Math.max(0, Number(c.rbt ?? 0) || 0);
  const paidLeft = rbt * RBT_TO_SECONDS;
  return { trialLeft: 0, paidLeft };
}

export async function totalSecondsLeft(userId) {
  const e = await ensureEntitlement(userId);
  return Math.max(0, (e.trialLeft || 0) + (e.paidLeft || 0));
}

// Deducts usage from DB (unlimited → no-op). For non-unlimited, decrements rbt by ceil(seconds/RBT_TO_SECONDS)
export async function deductSeconds(userId, seconds, opts = {}) {
  const reason = opts.reason || 'usage';
  const c = await getOrCreateContactForUser(userId);
  if (!c) return { trialLeft: 0, paidLeft: 0 };
  if (c.is_unlimited) {
    // Log activity but don't decrement
    try {
      await UserActivity?.create?.({
        contactId: c.wid,
        action_type: 'voice_call',
        action_outcome: 'unlimited',
        rbt_change: 0,
        contextual_info: { seconds: Math.max(0, Number(seconds)||0), reason }
      });
    } catch {}
    return ensureEntitlement(userId);
  }
  const secs = Math.max(0, Number(seconds) || 0);
  const tokens = Math.ceil(secs / RBT_TO_SECONDS);
  if (tokens <= 0) return ensureEntitlement(userId);
  const before = Math.max(0, Number(c.rbt ?? 0) || 0);
  const after = Math.max(0, before - tokens);
  try {
    await Contact.update({ rbt: after }, { where: { wid: c.wid } });
    await UserActivity?.create?.({
      contactId: c.wid,
      action_type: 'voice_call',
      action_outcome: 'deduct',
      rbt_change: -tokens, // negative tokens spent
      contextual_info: { seconds: secs, tokens, reason }
    });
    console.log('[Billing][DB] Deduct', { wid: c.wid, seconds: secs, tokens, rbt_before: before, rbt_after: after });
  } catch (e) {
    console.warn('[Billing][DB] Deduct failed', e?.message || e);
  }
  return ensureEntitlement(userId);
}

// Converts seconds to tokens and increments Contact.rbt
export async function addPaidSeconds(userId, seconds) {
  const c = await getOrCreateContactForUser(userId);
  if (!c) return { ok: false };
  const secs = Math.max(0, Number(seconds) || 0);
  const tokens = Math.ceil(secs / RBT_TO_SECONDS);
  if (tokens <= 0) return { ok: true };
  const before = Math.max(0, Number(c.rbt ?? 0) || 0);
  const after = before + tokens;
  try {
    await Contact.update({ rbt: after }, { where: { wid: c.wid } });
    await UserActivity?.create?.({
      contactId: c.wid,
      action_type: 'topup',
      action_outcome: 'seconds_to_rbt',
      rbt_change: tokens,
      contextual_info: { seconds: secs, tokens }
    });
    console.log('[Billing][DB] Top-up', { wid: c.wid, seconds: secs, tokens, rbt_before: before, rbt_after: after });
  } catch (e) {
    console.warn('[Billing][DB] Top-up failed', e?.message || e);
  }
  return { ok: true };
}

// Set unlimited and store license_key
export async function grantPro(userId, licenseKey) {
  const c = await getOrCreateContactForUser(userId);
  if (!c) return false;
  try {
    await Contact.update({ is_unlimited: true, license_key: licenseKey || c.license_key }, { where: { wid: c.wid } });
    await UserActivity?.create?.({
      contactId: c.wid,
      action_type: 'license',
      action_outcome: 'grant_pro',
      rbt_change: 0,
      contextual_info: { license_key: licenseKey || null }
    });
    console.log('[Billing][DB] Grant pro', { wid: c.wid });
    return true;
  } catch (e) {
    console.warn('[Billing][DB] Grant pro failed', e?.message || e);
    return false;
  }
}

export async function isPro(userId) {
  const c = await getOrCreateContactForUser(userId);
  return !!c?.is_unlimited;
}

export async function getUserLicense(userId) {
  const c = await getOrCreateContactForUser(userId);
  return c?.license_key || null;
}

// Backward-compat stub: compute view from contact (no in-memory boost)
export async function upgradeEntitlementFromContact(userId /*, contact */) {
  return ensureEntitlement(userId);
}

// One-time initial trial: top up RBT for a first-time caller
export async function ensureInitialTrialTopup(userId, seconds = TRIAL_INIT_SECONDS) {
  try {
    await initDb();
    const c = await getOrCreateContactForUser(userId);
    if (!c) return { ok: false, reason: 'no-contact' };
    if (c.is_unlimited) return { ok: false, reason: 'unlimited' };
    const secs = Math.max(0, Number(seconds) || 0);
    if (secs <= 0) return { ok: false, reason: 'disabled' };

    // If we already granted a trial topup, skip
    const prior = await UserActivity?.findOne?.({ where: { contactId: c.wid, action_type: 'trial_topup' } });
    if (prior) return { ok: false, reason: 'already-granted' };

    const tokens = Math.ceil(secs / RBT_TO_SECONDS);
    if (tokens <= 0) return { ok: false, reason: 'zero' };
    const before = Math.max(0, Number(c.rbt ?? 0) || 0);
    const after = before + tokens;
    await Contact.update({ rbt: after }, { where: { wid: c.wid } });
    await UserActivity?.create?.({
      contactId: c.wid,
      action_type: 'trial_topup',
      action_outcome: 'grant',
      rbt_change: tokens,
      contextual_info: { seconds: secs, tokens }
    });
    console.log('[Billing][DB] Trial top-up', { wid: c.wid, seconds: secs, tokens, rbt_before: before, rbt_after: after });
    return { ok: true, seconds: secs, tokens };
  } catch (e) {
    console.warn('[Billing][DB] Trial top-up failed', e?.message || e);
    return { ok: false, reason: 'error' };
  }
}
