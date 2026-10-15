import crypto from 'node:crypto';

export const WRITE_SCOPES = ['write_products', 'write_inventory'];
export const safeEqual = (a, b) => typeof a === 'string' && typeof b === 'string' &&
  Buffer.byteLength(a) === Buffer.byteLength(b) && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function cookieValue(req, name) {
  const entry = (req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`));
  if (!entry) return null;
  try {return decodeURIComponent(entry.slice(name.length + 1));} catch {return null;}
}
const signature = (data, secret) => crypto.createHmac('sha256', secret).update(`pnlstore-owner:${data}`).digest('base64url');
export function ownerToken(shop, secret, now = Date.now()) {
  const data = Buffer.from(JSON.stringify({shop, expires:now + 12 * 60 * 60 * 1000})).toString('base64url');
  return `${data}.${signature(data, secret)}`;
}
export function verifyOwnerToken(token, shop, secret, now = Date.now()) {
  if (!token || !secret) return false;
  try {
    const [data, mac, extra] = token.split('.');
    if (extra || !safeEqual(signature(data, secret), mac)) return false;
    const claims = JSON.parse(Buffer.from(data, 'base64url').toString());
    return claims.shop === shop && claims.expires > now;
  } catch {return false;}
}
export function editingAccess(req, shop, scope, secret) {
  const granted = new Set(String(scope || '').split(','));
  const missingScopes = WRITE_SCOPES.filter(s => !granted.has(s));
  const authenticated = verifyOwnerToken(cookieValue(req, 'pnl_owner'), shop, secret);
  return {allowed:authenticated && !missingScopes.length, authenticated, missingScopes,
    authUrl:`/auth?shop=${encodeURIComponent(shop || '')}&edit=1`};
}
