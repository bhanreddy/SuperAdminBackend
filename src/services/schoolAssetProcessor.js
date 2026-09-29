const { classifyImage } = require('./schoolConfiguration');

const LIMITS = {
  logo: { min: 512, maxEdge: 1024 },
  app_icon: { min: 1024, square: true, size: 1024 },
  splash: { min: 512, maxEdge: 2048 },
  adaptive_foreground: { min: 1024, square: true, size: 1024 },
  notification_icon: { min: 96, square: true, size: 96 },
  favicon: { min: 48, square: true, size: 48 },
  campus_photo: { min: 320, maxEdge: 1600 },
};

function loadSharp() {
  try {
    return require('sharp');
  } catch (err) {
    const error = new Error('Image processing is unavailable on this server');
    error.status = 503;
    error.code = 'IMAGE_PROCESSOR_UNAVAILABLE';
    throw error;
  }
}

function clampCrop(crop, width, height) {
  if (!crop) return null;
  const x = Math.max(0, Math.min(0.95, Number(crop.x) || 0));
  const y = Math.max(0, Math.min(0.95, Number(crop.y) || 0));
  const w = Math.max(0.05, Math.min(1 - x, Number(crop.width) || 1));
  const h = Math.max(0.05, Math.min(1 - y, Number(crop.height) || 1));
  return {
    left: Math.round(x * width),
    top: Math.round(y * height),
    width: Math.max(1, Math.round(w * width)),
    height: Math.max(1, Math.round(h * height)),
  };
}

async function processImageSlot(bytes, declaredType, slot, crop) {
  const kind = classifyImage(bytes, declaredType);
  if (!kind.ok) {
    const error = new Error(kind.error);
    error.status = 415;
    error.code = 'UNSUPPORTED_MEDIA';
    throw error;
  }
  if (bytes.length > 8 * 1024 * 1024) {
    const error = new Error('Image must be 8 MB or smaller');
    error.status = 413;
    error.code = 'FILE_TOO_LARGE';
    throw error;
  }
  const sharp = loadSharp();
  const rule = LIMITS[slot] || LIMITS.logo;
  let pipeline = sharp(bytes, { failOn: 'error' }).rotate();
  const meta = await pipeline.metadata();
  if (!meta.width || !meta.height) {
    const error = new Error('Image dimensions could not be read');
    error.status = 422;
    error.code = 'IMAGE_DIMENSIONS';
    throw error;
  }
  if (meta.width < rule.min || meta.height < rule.min) {
    const error = new Error(`${slot} must be at least ${rule.min}px on each side`);
    error.status = 422;
    error.code = 'IMAGE_TOO_SMALL';
    throw error;
  }
  const region = clampCrop(crop, meta.width, meta.height);
  if (region) pipeline = sharp(bytes).rotate().extract(region);
  if (rule.square) pipeline = pipeline.resize(rule.size, rule.size, { fit: 'cover' });
  else if (rule.maxEdge) pipeline = pipeline.resize(rule.maxEdge, rule.maxEdge, { fit: 'inside', withoutEnlargement: true });
  const output = await pipeline.png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true });
  return {
    buffer: output.data,
    mime: 'image/png',
    width: output.info.width,
    height: output.info.height,
  };
}

async function deriveVariants(appIconPng) {
  const sharp = loadSharp();
  const favicon = await sharp(appIconPng).resize(48, 48).png().toBuffer({ resolveWithObject: true });
  const notification = await sharp(appIconPng).resize(96, 96).png().toBuffer({ resolveWithObject: true });
  return {
    favicon: { buffer: favicon.data, mime: 'image/png', width: favicon.info.width, height: favicon.info.height },
    notification_icon: { buffer: notification.data, mime: 'image/png', width: notification.info.width, height: notification.info.height },
    adaptive_foreground: { buffer: appIconPng, mime: 'image/png', width: 1024, height: 1024 },
  };
}

module.exports = { processImageSlot, deriveVariants, LIMITS };
