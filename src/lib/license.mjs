// src/lib/license.mjs
const proUsers = new Set();           // userId → has paid
const licenseByUser = new Map();      // userId → license_key

// Entitlements (seconds)
const entitlements = new Map();       // userId → { trialLeft, paidLeft }
const TRIAL_S = Number(process.env.TRIAL_SECONDS || '300') || 0;
const RBT_TO_SECONDS = Number(process.env.RBT_TO_SECONDS || '60') || 60; // 1 RBT = 60 seconds by default
const UNLIMITED_SECONDS = Number(process.env.UNLIMITED_SECONDS || String(10 * 365 * 24 * 60 * 60)); // 10 years

function id(u) { return String(u || ''); }

export function ensureEntitlement(userId) {
  const key = id(userId);
  if (!entitlements.has(key)) entitlements.set(key, { trialLeft: TRIAL_S, paidLeft: 0 });
  return entitlements.get(key);
}

export function totalSecondsLeft(userId) {
  const e = ensureEntitlement(userId);
  return Math.max(0, (e.trialLeft || 0) + (e.paidLeft || 0));
}

export function deductSeconds(userId, seconds) {
  const e = ensureEntitlement(userId);
  let remaining = Math.max(0, Number(seconds) || 0);
  if (e.trialLeft > 0) {
    const useTrial = Math.min(e.trialLeft, remaining);
    e.trialLeft -= useTrial; remaining -= useTrial;
  }
  if (remaining > 0 && e.paidLeft > 0) {
    e.paidLeft = Math.max(0, e.paidLeft - remaining);
  }
  return e;
}

export function addPaidSeconds(userId, seconds) {
  const e = ensureEntitlement(userId);
  e.paidLeft = Math.max(0, e.paidLeft + Math.max(0, Number(seconds) || 0));
  return e;
}

/** “Pro” flag + (optional) license tracking */
export function grantPro(userId, licenseKey) {
  const key = id(userId);
  proUsers.add(key);
  if (licenseKey) licenseByUser.set(key, licenseKey);
  return true;
}

export function isPro(userId) { return proUsers.has(id(userId)); }
export function getUserLicense(userId) { return licenseByUser.get(id(userId)); }

// Use a Contact row to boost entitlements for a caller
// - If contact.is_unlimited → grant large paidLeft and mark pro
// - Else if contact.rbt > 0 → set paidLeft at least rbt * RBT_TO_SECONDS (non‑destructive top‑up)
export function upgradeEntitlementFromContact(userId, contact) {
  if (!contact) return ensureEntitlement(userId);
  const key = id(userId);
  const e = ensureEntitlement(key);
  try {
    if (contact.is_unlimited) {
      e.paidLeft = Math.max(e.paidLeft || 0, UNLIMITED_SECONDS);
      proUsers.add(key);
      if (contact.license_key) licenseByUser.set(key, contact.license_key);
      return e;
    }
    const rbt = Number(contact.rbt ?? 0) || 0;
    if (rbt > 0) {
      const secondsFromRbt = Math.max(0, rbt) * RBT_TO_SECONDS;
      if ((e.paidLeft || 0) < secondsFromRbt) e.paidLeft = secondsFromRbt;
    }
  } catch {}
  return e;
}
