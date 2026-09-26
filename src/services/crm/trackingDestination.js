const { CrmError } = require('./errors');
const { currentTrackingConfig } = require('./trackingConfig');

const PRIVATE_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i;

function reject(message) {
  throw new CrmError(400, message, 'UNSAFE_DESTINATION');
}

function isIp(host) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  if (host.includes(':')) return true;
  return false;
}

function isPrivateIpv4(host) {
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => part > 255)) return false;
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function ownedOriginSet(config) {
  const origins = new Set(config.ownedOrigins.map((origin) => origin.replace(/\/$/, '').toLowerCase()));
  if (config.publicOrigin) origins.add(config.publicOrigin.toLowerCase());
  return origins;
}

function classify(url, config) {
  const host = url.hostname.toLowerCase();
  const origin = url.origin.toLowerCase();
  if (ownedOriginSet(config).has(origin)) return 'OWNED_SITE';
  if (host === 'play.google.com' && url.pathname === '/store/apps/details') return 'PLAY_STORE';
  if (host === 'apps.apple.com' && url.pathname.startsWith('/')) return 'APP_STORE';
  if (config.allowedHosts.includes(host) && /\.(pdf|png|jpe?g|webp)$/i.test(url.pathname)) return 'DOCUMENT';
  if (config.allowedHosts.includes(host)) return 'WEBSITE';
  return null;
}

function validateDestination(raw) {
  const text = String(raw || '').trim();
  if (!text || text.length > 2000) reject('Destination URL is required');
  if (/[\u0000-\u001f\u007f]/.test(text)) reject('Destination URL contains control characters');
  if (/^(javascript|data|file|intent|sms|tel):/i.test(text)) reject('Destination scheme is not allowed');
  let url;
  try {
    url = new URL(text);
  } catch {
    reject('Destination URL is invalid');
  }
  if (url.protocol !== 'https:') reject('Destination must be https');
  if (url.username || url.password) reject('Destination must not include userinfo');
  if (url.port) reject('Destination must use the default https port');
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host !== url.hostname.toLowerCase().replace(/\.$/, '')) reject('Destination host is invalid');
  if (host.includes('%') || host.includes('\\') || text.includes('@')) reject('Destination host is invalid');
  if (PRIVATE_HOST.test(host) || isIp(host) || isPrivateIpv4(host)) reject('Destination host is not public');
  const params = [...url.searchParams.keys()].map((key) => key.toLowerCase());
  if (params.some((key) => ['next', 'redirect', 'url', 'return', 'continue', 'dest'].includes(key))) {
    reject('Destination must not nest another redirect');
  }
  if (url.pathname.includes('..') || url.pathname.includes('\\')) reject('Destination path is invalid');
  const config = currentTrackingConfig();
  const destinationClass = classify(url, config);
  if (!destinationClass) reject('Destination host is not on the allowlist');
  if (destinationClass === 'PLAY_STORE') {
    const id = url.searchParams.get('id') || '';
    if (!/^[A-Za-z0-9_.]+$/.test(id)) reject('Play Store URL must use a canonical app id');
  }
  if (destinationClass === 'APP_STORE' && url.pathname === '/') reject('App Store URL is incomplete');
  return {
    url: url.toString(),
    destinationClass,
    coverage: destinationClass === 'OWNED_SITE' ? 'owned_site' : 'unavailable',
  };
}

module.exports = { validateDestination };
