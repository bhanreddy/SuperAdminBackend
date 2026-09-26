const crypto = require('crypto');
const zlib = require('zlib');
const { LIMITS, PRIVILEGED_FIELDS } = require('./limits');
const { decodeXml } = require('./normalization');

const PARSER_VERSION = 1;
const ALIAS_VERSION = 1;

const FIELD_ALIASES = {
  school_name: ['school name', 'school', 'institution', 'institution name', 'name of school', 'name of the school'],
  udise: ['udise', 'udise code', 'udise no', 'udise number', 'udise+'],
  country: ['country', 'country code'],
  state: ['state', 'state name'],
  district: ['district'],
  city: ['city', 'town', 'city town'],
  locality: ['locality', 'area', 'neighbourhood', 'neighborhood'],
  address_line_1: ['address', 'address line 1', 'address1'],
  address_line_2: ['address line 2', 'address2'],
  postal_code: ['postal code', 'pincode', 'pin code', 'zip', 'zip code'],
  organization_phone: ['phone', 'school phone', 'office phone', 'organization phone', 'contact number'],
  organization_email: ['email', 'school email', 'office email', 'organization email'],
  board: ['board', 'school board'],
  management_type: ['management', 'management type'],
  website: ['website', 'url'],
  estimated_student_count: ['students', 'student count', 'estimated students'],
  notes: ['notes', 'remarks'],
};

for (let n = 1; n <= 5; n += 1) {
  FIELD_ALIASES[`contact_${n}_name`] = [`contact ${n} name`, `contact${n} name`];
  FIELD_ALIASES[`contact_${n}_role`] = [`contact ${n} role`, `contact ${n} designation`];
  FIELD_ALIASES[`contact_${n}_phone`] = [`contact ${n} phone`, `contact ${n} mobile`];
  FIELD_ALIASES[`contact_${n}_email`] = [`contact ${n} email`];
  FIELD_ALIASES[`contact_${n}_whatsapp`] = [`contact ${n} whatsapp`];
  FIELD_ALIASES[`contact_${n}_decision_maker`] = [`contact ${n} decision maker`];
}
FIELD_ALIASES.contact_1_name.push('principal name', 'principal');
FIELD_ALIASES.contact_1_role.push('principal role');
FIELD_ALIASES.contact_1_phone.push('principal phone', 'principal mobile');
FIELD_ALIASES.contact_1_email.push('principal email');

function limitOf(overrides, key) {
  const value = overrides?.[key];
  return Number.isFinite(value) ? Math.min(value, LIMITS[key]) : LIMITS[key];
}

function suggestMapping(headers) {
  const used = new Set();
  const columns = {};
  const conflicts = [];
  headers.forEach((header, index) => {
    const label = String(header || '').trim().toLowerCase();
    if (!label) return;
    const match = Object.entries(FIELD_ALIASES).find(([, aliases]) => aliases.includes(label));
    if (!match) return;
    const field = match[0];
    if (PRIVILEGED_FIELDS.has(field)) {
      conflicts.push({ index, field, code: 'PRIVILEGED_FIELD' });
      return;
    }
    if (used.has(field)) {
      conflicts.push({ index, field, code: 'DUPLICATE_MAPPING' });
      return;
    }
    used.add(field);
    columns[String(index)] = field;
  });
  const unmapped = headers.map((header, index) => ({ index, header })).filter((item) => columns[String(item.index)] == null && String(item.header || '').trim());
  return { alias_version: ALIAS_VERSION, columns, unmapped, conflicts, review_required: true };
}

function assertMapping(mapping) {
  const columns = mapping?.columns || {};
  const values = Object.values(columns);
  const errors = [];
  values.forEach((field) => {
    if (PRIVILEGED_FIELDS.has(String(field))) errors.push({ code: 'PRIVILEGED_FIELD', field });
  });
  const seen = new Set();
  values.forEach((field) => {
    if (seen.has(field)) errors.push({ code: 'DUPLICATE_MAPPING', field });
    seen.add(field);
  });
  if (!values.includes('school_name')) errors.push({ code: 'SCHOOL_NAME_MAPPING_REQUIRED', field: 'school_name' });
  return errors;
}

function detectDelimiter(text) {
  const sample = text.split(/\r?\n/).slice(0, 20).join('\n');
  const counts = [
    [',', (sample.match(/,/g) || []).length],
    [';', (sample.match(/;/g) || []).length],
    ['\t', (sample.match(/\t/g) || []).length],
  ].sort((a, b) => b[1] - a[1]);
  if (counts[0][1] === 0) return { delimiter: ',', ambiguous: false };
  if (counts[1][1] > 0 && counts[0][1] < counts[1][1] * 1.5) return { delimiter: null, ambiguous: true, choices: counts.filter((item) => item[1] > 0).map((item) => item[0]) };
  return { delimiter: counts[0][0], ambiguous: false };
}

function parseCsv(buffer, options = {}) {
  const limits = options.limits || {};
  const maxRows = limitOf(limits, 'maxRows');
  const maxColumns = limitOf(limits, 'maxColumns');
  const maxCells = limitOf(limits, 'maxCells');
  const maxCell = limitOf(limits, 'maxCellBytes');
  const maxRow = limitOf(limits, 'maxRowBytes');
  let text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer || '');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (!text.trim()) {
    const error = new Error('The file has no rows.');
    error.code = 'EMPTY_FILE';
    throw error;
  }
  const detected = options.delimiter ? { delimiter: options.delimiter, ambiguous: false } : detectDelimiter(text);
  if (detected.ambiguous) {
    const error = new Error('Choose a delimiter. Comma, semicolon, and tab all appear often enough to be ambiguous.');
    error.code = 'DELIMITER_AMBIGUOUS';
    error.choices = detected.choices;
    throw error;
  }
  const delimiter = detected.delimiter;
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let cells = 0;
  const pushCell = () => {
    if (Buffer.byteLength(cell) > maxCell) {
      const error = new Error('A cell exceeds the 8 KiB limit. Split the sheet or shorten that value.');
      error.code = 'CELL_TOO_LARGE';
      throw error;
    }
    row.push(cell);
    cell = '';
    cells += 1;
    if (cells > maxCells) {
      const error = new Error('The file exceeds 1,000,000 populated cells. Split it into smaller files.');
      error.code = 'TOO_MANY_CELLS';
      throw error;
    }
  };
  const pushRow = () => {
    if (row.length === 1 && row[0] === '' && rows.length === 0) {
      row = [];
      return;
    }
    const size = row.reduce((sum, value) => sum + Buffer.byteLength(value), 0);
    if (size > maxRow) {
      const error = new Error('A row exceeds the 64 KiB limit. Split that row.');
      error.code = 'ROW_TOO_LARGE';
      throw error;
    }
    if (row.length > maxColumns) {
      const error = new Error('The file exceeds 100 columns. Remove unused columns and upload again.');
      error.code = 'TOO_MANY_COLUMNS';
      throw error;
    }
    if (row.some((value) => value !== '')) rows.push(row);
    if (rows.length > maxRows + 1) {
      const error = new Error('The file exceeds 50,000 data rows. Split it and import the parts separately.');
      error.code = 'TOO_MANY_ROWS';
      throw error;
    }
    row = [];
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === delimiter) {
      pushCell();
      continue;
    }
    if (ch === '\n') {
      pushCell();
      pushRow();
      continue;
    }
    if (ch === '\r') continue;
    cell += ch;
  }
  if (quoted) {
    const error = new Error('The CSV has an unterminated quoted value.');
    error.code = 'MALFORMED_CSV';
    throw error;
  }
  if (cell.length || row.length) {
    pushCell();
    pushRow();
  }
  const headerIndex = Math.max(0, Number(options.headerRow || 1) - 1);
  const headers = rows[headerIndex] || [];
  const data = rows.slice(headerIndex + 1).map((values, offset) => ({
    sheet_name: options.sheetName || '',
    row_number: headerIndex + offset + 2,
    cells: values,
  }));
  return { format: 'csv', delimiter, sheets: [{ name: options.sheetName || 'CSV', headers, header_row: headerIndex + 1 }], rows: data };
}

function readZip(buffer, limits) {
  const maxEntries = limitOf(limits, 'maxZipEntries');
  const maxExpanded = limitOf(limits, 'xlsxExpandedMaxBytes');
  const maxRatio = limitOf(limits, 'maxCompressionRatio');
  if (buffer.length < 22 || buffer.readUInt32LE(0) !== 0x04034b50) {
    const error = new Error('The workbook is not a valid xlsx archive.');
    error.code = 'MALFORMED_ARCHIVE';
    throw error;
  }
  let eocd = -1;
  const start = Math.max(0, buffer.length - 22 - 65535);
  for (let i = buffer.length - 22; i >= start; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    const error = new Error('The workbook archive is incomplete.');
    error.code = 'MALFORMED_ARCHIVE';
    throw error;
  }
  const count = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  if (count > maxEntries) {
    const error = new Error('The workbook has too many archive entries.');
    error.code = 'ARCHIVE_LIMIT';
    throw error;
  }
  const files = new Map();
  let expanded = 0;
  for (let n = 0; n < count; n += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      const error = new Error('The workbook central directory is malformed.');
      error.code = 'MALFORMED_ARCHIVE';
      throw error;
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const compressed = buffer.readUInt32LE(cursor + 20);
    const uncompressed = buffer.readUInt32LE(cursor + 24);
    const nameLen = buffer.readUInt16LE(cursor + 28);
    const extraLen = buffer.readUInt16LE(cursor + 30);
    const commentLen = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.slice(cursor + 46, cursor + 46 + nameLen).toString('utf8');
    if (name.includes('..') || name.startsWith('/') || name.includes('\\')) {
      const error = new Error('The workbook contains an unsafe path.');
      error.code = 'MALFORMED_ARCHIVE';
      throw error;
    }
    if (uncompressed > maxExpanded || compressed > 0 && uncompressed / compressed > maxRatio) {
      const error = new Error('The workbook expands too far for this importer. Split the file.');
      error.code = 'ARCHIVE_BOMB';
      throw error;
    }
    expanded += uncompressed;
    if (expanded > maxExpanded) {
      const error = new Error('The workbook expands past 64 MiB. Split the file.');
      error.code = 'ARCHIVE_BOMB';
      throw error;
    }
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const slice = buffer.slice(dataStart, dataStart + compressed);
    let body;
    try {
      if (method === 0) body = slice;
      else if (method === 8) body = zlib.inflateRawSync(slice);
      else {
        const error = new Error('The workbook uses an unsupported compression method.');
        error.code = 'UNSUPPORTED_WORKBOOK';
        throw error;
      }
    } catch (err) {
      if (err.code === 'UNSUPPORTED_WORKBOOK') throw err;
      const error = new Error('The workbook could not be decompressed.');
      error.code = 'MALFORMED_ARCHIVE';
      throw error;
    }
    if (body.length !== uncompressed && uncompressed !== 0) {
      const error = new Error('The workbook entry size does not match its directory.');
      error.code = 'MALFORMED_ARCHIVE';
      throw error;
    }
    files.set(name, body.toString('utf8'));
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function columnIndex(ref) {
  const letters = String(ref || '').match(/^[A-Z]+/);
  if (!letters) return 0;
  let n = 0;
  for (const ch of letters[0]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function sharedStrings(xml) {
  if (!xml) return [];
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    const error = new Error('The workbook contains unsupported XML entities.');
    error.code = 'UNSUPPORTED_WORKBOOK';
    throw error;
  }
  const values = [];
  const items = xml.match(/<si\b[\s\S]*?<\/si>/g) || [];
  items.forEach((item) => {
    const texts = [...item.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((match) => decodeXml(match[1]));
    values.push(texts.join(''));
  });
  return values;
}

function parseSheet(xml, strings, limits) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml || '')) {
    const error = new Error('The workbook contains unsupported XML entities.');
    error.code = 'UNSUPPORTED_WORKBOOK';
    throw error;
  }
  const maxRows = limitOf(limits, 'maxRows');
  const maxColumns = limitOf(limits, 'maxColumns');
  const maxCells = limitOf(limits, 'maxCells');
  const rows = [];
  let cells = 0;
  const rowXml = xml.match(/<row\b[^>]*>[\s\S]*?<\/row>/g) || [];
  if (rowXml.length > maxRows + 5) {
    const error = new Error('The sheet exceeds 50,000 data rows. Split it and import the parts separately.');
    error.code = 'TOO_MANY_ROWS';
    throw error;
  }
  rowXml.forEach((block) => {
    const rowNumber = Number(block.match(/\br="(\d+)"/)?.[1] || rows.length + 1);
    const values = [];
    const meta = [];
    const cellXml = block.match(/<c\b[^>]*(?:\/>|>[\s\S]*?<\/c>)/g) || [];
    cellXml.forEach((cell) => {
      const ref = cell.match(/\br="([A-Z]+\d+)"/)?.[1] || '';
      const index = columnIndex(ref);
      if (index >= maxColumns) {
        const error = new Error('The sheet exceeds 100 columns. Remove unused columns and upload again.');
        error.code = 'TOO_MANY_COLUMNS';
        throw error;
      }
      const type = cell.match(/\bt="([^"]+)"/)?.[1] || 'n';
      const formula = /<f\b/.test(cell);
      const inline = cell.match(/<is>\s*<t[^>]*>([\s\S]*?)<\/t>/);
      const raw = cell.match(/<v>([\s\S]*?)<\/v>/);
      let value = '';
      if (inline) value = decodeXml(inline[1]);
      else if (type === 's' && raw) value = strings[Number(decodeXml(raw[1]))] || '';
      else if (raw) value = decodeXml(raw[1]);
      values[index] = value;
      meta[index] = { type, formula, numeric: type === 'n' && !formula };
      cells += 1;
      if (cells > maxCells) {
        const error = new Error('The workbook exceeds 1,000,000 populated cells. Split it.');
        error.code = 'TOO_MANY_CELLS';
        throw error;
      }
    });
    for (let i = 0; i < values.length; i += 1) if (values[i] == null) values[i] = '';
    rows.push({ row_number: rowNumber, cells: values, meta });
  });
  return rows;
}

function sheetNames(workbookXml, relsXml) {
  const rels = new Map();
  for (const match of relsXml.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)) rels.set(match[1], match[2]);
  const sheets = [];
  for (const match of workbookXml.matchAll(/<sheet\b[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"[^>]*\/?>/g)) {
    const target = rels.get(match[2]) || '';
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\.\//, '')}`;
    sheets.push({ name: decodeXml(match[1]), path });
  }
  if (!sheets.length) {
    for (const match of workbookXml.matchAll(/<sheet\b[^>]*r:id="([^"]+)"[^>]*name="([^"]+)"[^>]*\/?>/g)) {
      const target = rels.get(match[1]) || '';
      sheets.push({ name: decodeXml(match[2]), path: `xl/${target}` });
    }
  }
  return sheets;
}

function parseXlsx(buffer, options = {}) {
  const limits = options.limits || {};
  const files = readZip(buffer, limits);
  if ([...files.keys()].some((name) => /encryption/i.test(name))) {
    const error = new Error('Encrypted workbooks are not supported. Remove the password and upload xlsx again.');
    error.code = 'ENCRYPTED_WORKBOOK';
    throw error;
  }
  const workbook = files.get('xl/workbook.xml');
  const rels = files.get('xl/_rels/workbook.xml.rels');
  if (!workbook || !rels) {
    const error = new Error('The workbook is missing its sheet catalog.');
    error.code = 'MALFORMED_ARCHIVE';
    throw error;
  }
  const sheets = sheetNames(workbook, rels);
  if (sheets.length > limitOf(limits, 'maxSheets')) {
    const error = new Error('The workbook has too many sheets. Keep the school list on one sheet.');
    error.code = 'TOO_MANY_SHEETS';
    throw error;
  }
  const strings = sharedStrings(files.get('xl/sharedStrings.xml'));
  const selected = options.sheetName ? sheets.filter((sheet) => sheet.name === options.sheetName) : sheets.slice(0, 1);
  if (!selected.length) {
    const error = new Error('The selected sheet was not found.');
    error.code = 'SHEET_NOT_FOUND';
    throw error;
  }
  const parsed = [];
  const described = [];
  selected.forEach((sheet) => {
    const xml = files.get(sheet.path) || files.get(sheet.path.replace(/^xl\//, 'xl/'));
    if (!xml) {
      const error = new Error('A worksheet could not be read.');
      error.code = 'MALFORMED_ARCHIVE';
      throw error;
    }
    const rows = parseSheet(xml, strings, limits);
    const headerRow = Math.max(1, Number(options.headerRow || 1));
    const header = rows.find((row) => row.row_number === headerRow) || rows[0];
    described.push({ name: sheet.name, headers: header?.cells || [], header_row: header?.row_number || 1 });
    rows.filter((row) => row.row_number > (header?.row_number || 1)).forEach((row) => {
      if (row.cells.some((value) => value !== '')) parsed.push({ sheet_name: sheet.name, ...row });
    });
  });
  return { format: 'xlsx', sheets: described, rows: parsed, sheet_catalog: sheets.map((sheet) => sheet.name) };
}

function inspectUpload(buffer, filename) {
  const name = String(filename || '').toLowerCase();
  if (buffer.slice(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    const error = new Error('Legacy .xls workbooks are not supported. Save the file as .xlsx or .csv.');
    error.code = 'UNSUPPORTED_FORMAT';
    throw error;
  }
  const zip = buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50;
  if (name.endsWith('.csv') && zip) {
    const error = new Error('This file is a spreadsheet archive, not a CSV. Upload it as .xlsx.');
    error.code = 'UNSUPPORTED_FORMAT';
    throw error;
  }
  if (zip || name.endsWith('.xlsx')) return 'xlsx';
  if (name.endsWith('.csv') || name.endsWith('.txt')) return 'csv';
  const error = new Error('Upload a .csv or .xlsx file. Other formats are rejected.');
  error.code = 'UNSUPPORTED_FORMAT';
  throw error;
}

function checksum(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function formulaSafe(value) {
  const text = value == null ? '' : String(value);
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

module.exports = {
  PARSER_VERSION,
  ALIAS_VERSION,
  FIELD_ALIASES,
  suggestMapping,
  assertMapping,
  parseCsv,
  parseXlsx,
  inspectUpload,
  checksum,
  formulaSafe,
  detectDelimiter,
};
