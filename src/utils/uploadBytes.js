const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'text/plain']);

function imageKind(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg' };
  }
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { mime: 'image/png', ext: 'png' };
  }
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp' };
  }
  return null;
}

function isPdf(bytes) {
  return bytes.length >= 5 && bytes.toString('ascii', 0, 5) === '%PDF-';
}

function isPlainText(bytes) {
  if (!bytes.length || bytes.includes(0)) return false;
  const text = bytes.toString('utf8');
  if (text.includes('\uFFFD')) return false;
  const sample = text.slice(0, 400).trim().toLowerCase();
  if (sample.startsWith('<') || sample.startsWith('<?xml')) return false;
  if (/<\s*(script|html|svg|iframe|object|embed)\b/.test(sample) || sample.includes('javascript:')) return false;
  return true;
}

function declaredMime(value) {
  return String(value || '').toLowerCase().split(';')[0].trim();
}

/**
 * Accept only a declared type whose bytes match that type.
 * A client-supplied Content-Type is not evidence of the file contents.
 */
function classifyUpload(bytes, declaredType) {
  const type = declaredMime(declaredType);
  if (!ALLOWED.has(type)) {
    return { ok: false, error: 'File type is not allowed' };
  }
  if (type === 'image/jpeg' || type === 'image/png' || type === 'image/webp') {
    const kind = imageKind(bytes);
    if (!kind || kind.mime !== type) return { ok: false, error: 'File contents do not match the declared image type' };
    return { ok: true, ...kind };
  }
  if (type === 'application/pdf') {
    if (!isPdf(bytes)) return { ok: false, error: 'File contents are not a PDF' };
    return { ok: true, mime: type, ext: 'pdf' };
  }
  if (!isPlainText(bytes)) return { ok: false, error: 'Text attachments cannot contain active content' };
  return { ok: true, mime: 'text/plain', ext: 'txt' };
}

function safeDownloadName(name) {
  const cleaned = String(name || 'document').replace(/[^\w.\- ()]+/g, '_').replace(/^\.+/, '').slice(0, 180);
  return cleaned || 'document';
}

module.exports = {
  ALLOWED,
  classifyUpload,
  imageKind,
  safeDownloadName,
};
