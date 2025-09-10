// src/lib/license.mjs
const proUsers = new Set();           // userId → has paid
const licenseByUser = new Map();      // userId → license_key

// Entitlements (seconds)
const entitlements = new Map();       // userId → { trialLeft, paidLeft }
const TRIAL_S = Number(process.env.TRIAL_SECONDS || '300') || 0;

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
