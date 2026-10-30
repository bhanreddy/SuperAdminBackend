const { inflateRawSync } = require('node:zlib');
const { createHash } = require('node:crypto');
const { ConnectError } = require('./service');
const MAX_BYTES = 8 * 1024 * 1024;
const TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
function check(ok, message) {
  if (!ok) throw new ConnectError(message);
}
function validateOffice(buffer, extension) {
  // Inspect the ZIP central directory BEFORE any decompression; then verify each
  // member's actual expanded size under a hard aggregate budget.
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--)
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  check(end >= 0, 'Invalid Office document');
  const count = buffer.readUInt16LE(end + 10),
    size = buffer.readUInt32LE(end + 12),
    offset = buffer.readUInt32LE(end + 16);
  check(
    count > 0 &&
      count <= 2000 &&
      buffer.readUInt16LE(end + 4) === 0 &&
      buffer.readUInt16LE(end + 6) === 0 &&
      count === buffer.readUInt16LE(end + 8) &&
      offset + size === end,
    'Unsupported Office archive',
  );
  let pos = offset,
    total = 0;
  const names = new Set();
  for (let i = 0; i < count; i++) {
    check(
      pos + 46 <= end && buffer.readUInt32LE(pos) === 0x02014b50,
      'Invalid Office directory',
    );
    const flags = buffer.readUInt16LE(pos + 8),
      method = buffer.readUInt16LE(pos + 10),
      compressed = buffer.readUInt32LE(pos + 20),
      expanded = buffer.readUInt32LE(pos + 24);
    const nameLength = buffer.readUInt16LE(pos + 28),
      extraLength = buffer.readUInt16LE(pos + 30),
      commentLength = buffer.readUInt16LE(pos + 32),
      local = buffer.readUInt32LE(pos + 42);
    check(
      pos + 46 + nameLength + extraLength + commentLength <= end,
      'Invalid Office entry',
    );
    const name = buffer
      .subarray(pos + 46, pos + 46 + nameLength)
      .toString('utf8');
    check(
      !names.has(name) &&
        !name.includes('..') &&
        !/[\\\x00]/.test(name) &&
        !name.startsWith('/') &&
        !/vba|macros|embeddings\//i.test(name),
      'Unsafe Office content',
    );
    names.add(name);
    total += expanded;
    check(
      !(flags & 0x41) &&
        [0, 8].includes(method) &&
        expanded <= 16 * 1024 * 1024 &&
        total <= 32 * 1024 * 1024 &&
        expanded <= Math.max(1024, compressed * 80),
      'Office archive exceeds safe expansion limits',
    );
    check(
      local + 30 <= offset && buffer.readUInt32LE(local) === 0x04034b50,
      'Invalid Office member',
    );
    const start =
      local +
      30 +
      buffer.readUInt16LE(local + 26) +
      buffer.readUInt16LE(local + 28);
    check(
      buffer.readUInt16LE(local + 8) === method &&
        buffer.readUInt16LE(local + 6) === flags &&
        buffer
          .subarray(local + 30, local + 30 + buffer.readUInt16LE(local + 26))
          .toString('utf8') === name,
      'Office local/central directory mismatch',
    );
    check(start + compressed <= offset, 'Invalid Office compressed range');
    const source = buffer.subarray(start, start + compressed);
    let decoded;
    try {
      decoded =
        method === 0
          ? source
          : inflateRawSync(source, {
              maxOutputLength: Math.min(expanded + 1, 16 * 1024 * 1024 + 1),
            });
    } catch {
      throw new ConnectError('Invalid or oversized compressed Office member');
    }
    check(decoded.length === expanded, 'Office expanded size mismatch');
    if (name === '[Content_Types].xml')
      check(
        !/macroEnabled|vbaProject|<!ENTITY|<!DOCTYPE/i.test(
          decoded.toString('utf8'),
        ),
        'Active Office content is not allowed',
      );
    pos += 46 + nameLength + extraLength + commentLength;
  }
  const main = {
    docx: 'word/document.xml',
    xlsx: 'xl/workbook.xml',
    pptx: 'ppt/presentation.xml',
  }[extension];
  check(
    pos === end && names.has('[Content_Types].xml') && names.has(main),
    'Office type does not match the file extension',
  );
}
function validateFile(file) {
  check(
    file &&
      Buffer.isBuffer(file.buffer) &&
      file.buffer.length > 0 &&
      file.buffer.length <= MAX_BYTES,
    'Choose a file up to 8 MB',
  );
  const filename = String(file.originalname || '')
    .replace(/[^\p{L}\p{N}._ -]/gu, '_')
    .slice(-120);
  const extension = filename.split('.').pop().toLowerCase(),
    mime = TYPES[extension];
  check(
    mime && file.mimetype === mime,
    'Supported files: PNG, JPEG, PDF, DOCX, XLSX and PPTX',
  );
  const b = file.buffer;
  if (extension === 'png')
    check(
      b.length >= 24 &&
        b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
      'Invalid PNG signature',
    );
  else if (['jpg', 'jpeg'].includes(extension))
    check(
      b.length >= 4 && b[0] === 255 && b[1] === 216 && b[2] === 255,
      'Invalid JPEG signature',
    );
  else if (extension === 'pdf') {
    check(
      b.subarray(0, 5).toString() === '%PDF-' &&
        b.subarray(-2048).includes(Buffer.from('%%EOF')),
      'Invalid PDF signature',
    );
    check(
      !/\/(JavaScript|JS|Launch|EmbeddedFile|RichMedia|OpenAction)\b/i.test(
        b.toString('latin1'),
      ),
      'Active PDF content is not allowed',
    );
  } else validateOffice(b, extension);
  return {
    filename,
    mime,
    byte_size: b.length,
    sha256: createHash('sha256').update(b).digest('hex'),
    extension,
  };
}
function supabaseConnectStorage(client) {
  const bucket = 'nexsyrus-connect';
  async function privateBucket() {
    const { data, error } = await client.storage.getBucket(bucket);
    if (error || !data || data.public)
      throw new ConnectError(
        'File storage is temporarily unavailable. Contact a company administrator.',
        503,
      );
    return client.storage.from(bucket);
  }
  return {
    async put(key, bytes, mime) {
      const b = await privateBucket();
      const { error } = await b.upload(key, bytes, {
        contentType: mime,
        upsert: false,
      });
      if (error) throw new ConnectError('Attachment upload failed', 503);
    },
    async get(key) {
      const b = await privateBucket();
      const { data, error } = await b.download(key);
      if (error || !data) throw new ConnectError('Attachment unavailable', 503);
      return Buffer.from(await data.arrayBuffer());
    },
    async remove(key) {
      const b = await privateBucket();
      const { error } = await b.remove([key]);
      if (error) throw new ConnectError('Attachment cleanup failed', 503);
    },
  };
}
module.exports = { validateFile, supabaseConnectStorage, MAX_BYTES, TYPES };
