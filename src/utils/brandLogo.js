/**
 * Bundled NexSyrus brand mark, exposed as a base64 data URI so billing documents
 * stay fully self-contained (they print/share offline with no asset hosting).
 *
 * Read + encoded once, then cached. Fails safe to null if the asset is missing so
 * a document still renders (it falls back to the text monogram).
 *
 * Override per deployment with billing_config.supplier_logo_url (an https URL or a
 * data: URI) — that takes precedence over this default.
 */
const fs = require('fs');
const path = require('path');

const LOGO_PATH = path.join(__dirname, '..', 'assets', 'brand-logo.png');

let cached;

function defaultLogoDataUri() {
  if (cached !== undefined) return cached;
  try {
    const buf = fs.readFileSync(LOGO_PATH);
    cached = `data:image/png;base64,${buf.toString('base64')}`;
  } catch (err) {
    console.error(`[billing] brand logo unavailable at ${LOGO_PATH}: ${err.message}`);
    cached = null;
  }
  return cached;
}

module.exports = { defaultLogoDataUri };
