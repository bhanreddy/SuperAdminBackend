const QRCode = require('qrcode');
const { CrmError } = require('./errors');
const { currentTrackingConfig } = require('./trackingConfig');

const MAX_SVG_BYTES = 20000;

async function renderQr(url, format, size) {
  const px = Number(size || 512);
  if (!Number.isInteger(px) || px < 128 || px > 1024) throw new CrmError(400, 'QR size must be from 128 to 1024', 'BAD_QR');
  const kind = String(format || 'png').toLowerCase();
  if (kind === 'svg') {
    const svg = await QRCode.toString(url, {
      type: 'svg',
      errorCorrectionLevel: 'Q',
      margin: 4,
      color: { dark: '#000000', light: '#FFFFFF' },
    });
    if (svg.length > MAX_SVG_BYTES || /<script|foreignObject|<!ENTITY|javascript:/i.test(svg)) {
      throw new CrmError(500, 'QR image was rejected', 'BAD_QR');
    }
    return { body: svg, contentType: 'image/svg+xml; charset=utf-8', filename: 'link.svg' };
  }
  if (kind !== 'png') throw new CrmError(400, 'QR format must be png or svg', 'BAD_QR');
  const png = await QRCode.toBuffer(url, {
    errorCorrectionLevel: 'Q',
    margin: 4,
    width: px,
    color: { dark: '#000000', light: '#FFFFFF' },
  });
  if (png.length > 500000) throw new CrmError(500, 'QR image was rejected', 'BAD_QR');
  return { body: png, contentType: 'image/png', filename: 'link.png' };
}

function qrUrl(shortCode) {
  const origin = currentTrackingConfig().publicOrigin;
  if (!origin) throw new CrmError(503, 'TRACKING_PUBLIC_ORIGIN is not configured', 'TRACK_UNCONFIGURED');
  return `${origin}/d/${shortCode}`;
}

module.exports = { renderQr, qrUrl };
