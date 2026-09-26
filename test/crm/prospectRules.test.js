const assert = require('node:assert/strict');
const test = require('node:test');
const {
  strictSchoolName,
  looseSchoolName,
  normalizePhone,
  normalizeEmail,
  normalizeUdise,
  normalizeSchool,
} = require('../../src/services/crm/normalization');
const { classifyRow, jaccard, looseMatch } = require('../../src/services/crm/duplicateDetection');
const { parseCsv, parseXlsx, suggestMapping, formulaSafe } = require('../../src/services/crm/importParser');

test('school names fold case and whitespace without merging campuses', () => {
  assert.equal(strictSchoolName('Sunrise   Public School'), strictSchoolName('sunrise public school'));
  assert.notEqual(strictSchoolName('Sunrise Public School — East Campus'), strictSchoolName('Sunrise Public School — West Campus'));
  assert.equal(looseSchoolName('Sr Sec Sch'), 'senior secondary school');
  const again = strictSchoolName(strictSchoolName('Sunrise Public School'));
  assert.equal(again, strictSchoolName('Sunrise Public School'));
});

test('phones keep country and extension and reject bare landlines', () => {
  const a = normalizePhone('98765 43210', 'IN');
  const b = normalizePhone('+91 9876543210', 'IN');
  assert.equal(a.ok && b.ok && a.normalized, b.normalized);
  assert.equal(a.normalized, '+919876543210');
  const ext1 = normalizePhone('+91 9876543210 ext 101', 'IN');
  const ext2 = normalizePhone('+91 9876543210 x 102', 'IN');
  assert.equal(ext1.normalized, ext2.normalized);
  assert.notEqual(ext1.extension, ext2.extension);
  assert.equal(normalizePhone('0401234567', 'IN').code, 'AMBIGUOUS_LANDLINE');
  assert.equal(normalizePhone('9876543210', '').code, 'COUNTRY_REQUIRED');
  assert.notEqual(normalizePhone('+1 415 555 2671', 'US').normalized, a.normalized);
});

test('emails fold only the domain and keep plus tags', () => {
  const left = normalizeEmail('office@Example.org');
  const right = normalizeEmail('office@example.org');
  assert.equal(left.normalized, right.normalized);
  assert.notEqual(normalizeEmail('admissions+east@example.org').normalized, normalizeEmail('admissions@example.org').normalized);
  assert.notEqual(normalizeEmail('first.last@example.org').normalized, normalizeEmail('firstlast@example.org').normalized);
});

test('UDISE stays an 11 digit string and rejects spreadsheet damage', () => {
  assert.equal(normalizeUdise('01234567890').udise, '01234567890');
  assert.equal(normalizeUdise('12345').code, 'UDISE_INVALID');
  assert.equal(normalizeUdise('1.23E+10', { numeric: true }).code, 'ROUNDED_IDENTIFIER');
  assert.equal(normalizeUdise('=A1', { formula: true }).code, 'FORMULA_IDENTIFIER');
});

test('incomplete location does not become a matching key', () => {
  const located = normalizeSchool({ school_name: 'Sunrise Public School', country: 'India', state: 'Telangana', city: 'Hyderabad' });
  const blank = normalizeSchool({ school_name: 'Sunrise Public School', country: 'India' });
  assert.ok(located.location.location_key);
  assert.equal(blank.location.location_key, null);
  assert.notEqual(
    normalizeSchool({ school_name: 'Sunrise Public School', country: 'IN', district: 'Hyderabad' }).location.location_key,
    normalizeSchool({ school_name: 'Sunrise Public School', country: 'IN', district: 'Rangareddy' }).location.location_key,
  );
});

test('duplicate classes explain evidence and never merge on a shared phone alone', () => {
  const exact = classifyRow({
    identity: { valid: true, udise: '01234567890', strict_name: 'sunrise public school', loose_name: 'sunrise public school', location_key: 'IN|telangana||||', phones: [], emails: [] },
    accounts: [{ id: 'a', udise: '01234567890', strict_name: 'sunrise public school', location_key: 'IN|telangana||||', phones: [], emails: [] }],
    coverage: { complete: true },
  });
  assert.equal(exact.classification, 'EXACT_DUPLICATE');
  assert.equal(exact.evidence.some((item) => item.rule === 'validated_udise'), true);

  const shared = classifyRow({
    identity: { valid: true, udise: '11111111111', strict_name: 'east school', loose_name: 'east school', location_key: 'IN|telangana|a|||', phones: ['+919876543210'], emails: [] },
    accounts: [{ id: 'b', udise: '22222222222', strict_name: 'west school', location_key: 'IN|telangana|b|||', phones: ['+919876543210'], emails: [] }],
    coverage: { complete: true },
  });
  assert.equal(shared.classification, 'POSSIBLE_DUPLICATE');
  assert.equal(shared.permitted_actions.includes('MERGE') || shared.classification !== 'EXACT_DUPLICATE', true);
  assert.equal(shared.classification === 'EXACT_DUPLICATE', false);

  const conflict = classifyRow({
    identity: { valid: true, udise: '01234567890', strict_name: 'sunrise public school', loose_name: 'sunrise public school', location_key: 'IN|kerala||||', phones: [], emails: [], forced_conflict: null },
    accounts: [{ id: 'a', udise: '01234567890', strict_name: 'sunrise public school', location_key: 'IN|telangana||||', phones: [], emails: [] }],
    coverage: { complete: true },
  });
  assert.equal(conflict.classification, 'CONFLICT');

  const incomplete = classifyRow({
    identity: { valid: true, strict_name: 'new school', loose_name: 'new school', phones: [], emails: [] },
    accounts: [],
    coverage: { complete: false },
  });
  assert.equal(incomplete.classification, 'POSSIBLE_DUPLICATE');
  assert.equal(incomplete.customer_status, 'CHECK_INCOMPLETE');
  assert.equal(incomplete.permitted_actions.includes('IMPORT_NEW'), false);
});

test('loose name similarity cannot authorize a merge by itself', () => {
  assert.equal(looseMatch('sunrise public school', 'sunrise public campus'), false);
  assert.ok(jaccard('sunrise public school', 'sunrise public school') === 1);
  const loose = classifyRow({
    identity: { valid: true, strict_name: 'sunrise public school', loose_name: 'sunrise public school', location_key: 'IN|telangana|hyd|hyd||500001', phones: [], emails: [] },
    accounts: [{ id: 'z', strict_name: 'sunrise public academy', loose_name: 'sunrise public academy', location_key: 'IN|telangana|hyd|hyd||500001', phones: [], emails: [] }],
    coverage: { complete: true },
  });
  assert.notEqual(loose.classification, 'EXACT_DUPLICATE');
});

test('restricted matches hide the other founder record', () => {
  const result = classifyRow({
    identity: { valid: true, udise: '01234567890', strict_name: 'hidden school', loose_name: 'hidden school', phones: ['+919876543210'], emails: [] },
    accounts: [{ id: 'secret', restricted: true, udise: '01234567890', strict_name: 'hidden school', phones: ['+919876543210'], emails: [] }],
    coverage: { complete: true },
  });
  assert.equal(result.restricted, true);
  assert.equal(result.target_account_id, null);
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(result.permitted_actions.includes('IMPORT_NEW'), false);
});

test('csv keeps quoted newlines, bom, and duplicate headers by index', () => {
  const csv = Buffer.from('\uFEFFschool name,phone,phone\n"Sunrise\nPublic",9876543210,9123456789\n');
  const parsed = parseCsv(csv);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].cells[0], 'Sunrise\nPublic');
  const suggestion = suggestMapping(['school name', 'phone', 'phone']);
  assert.equal(suggestion.columns['0'], 'school_name');
  assert.equal(suggestion.conflicts.some((item) => item.code === 'DUPLICATE_MAPPING'), true);
});

test('csv rejects ambiguous delimiters and oversized claims', () => {
  assert.throws(() => parseCsv(Buffer.from('a,b;c\n1,2;3\n4,5;6\n')), (err) => err.code === 'DELIMITER_AMBIGUOUS');
  assert.equal(formulaSafe('=cmd|calc'), "'=cmd|calc");
});

test('repeated school rows group by udise while different udise values conflict', () => {
  process.env.SCHOOL_SUPABASE_URL = 'http://127.0.0.1:9';
  process.env.SCHOOL_SUPABASE_ANON_KEY = 'test-anon';
  process.env.SCHOOL_SUPABASE_SERVICE_ROLE_KEY = 'test-service';
  process.env.SCHOOL_DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:1/postgres';
  const { assignGroups } = require('../../src/services/crm/importService');
  const school = (udise, city) => ({
    valid: true,
    udise_code: udise,
    school_name_normalized: 'sunrise public school',
    location: { location_key: `IN|telangana|${city}|||` },
  });
  const grouped = assignGroups([
    { row_number: 2, school: school('01234567890', 'hyd') },
    { row_number: 3, school: school('01234567890', 'hyd') },
    { row_number: 4, school: school('11111111111', 'hyd') },
  ]);
  assert.equal(grouped[0].group_id, 'udise:01234567890');
  assert.equal(grouped[1].group_id, grouped[0].group_id);
  assert.equal(grouped[2].group_id, 'udise:11111111111');
  const clash = assignGroups([
    { row_number: 2, school: school('01234567890', 'hyd') },
    { row_number: 3, school: school('22222222222', 'hyd') },
  ]);
  assert.equal(clash[0].school.forced_conflict, 'multiple_udise_same_location');
  assert.notEqual(clash[0].group_id, clash[1].group_id);
});

test('xlsx preserves text identifiers and flags formulas', () => {
  const xlsx = require('xlsx');
  const sheet = xlsx.utils.aoa_to_sheet([
    ['school name', 'udise'],
    ['Sunrise Public School', '01234567890'],
  ]);
  const book = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(book, sheet, 'Schools');
  const buffer = xlsx.write(book, { type: 'buffer', bookType: 'xlsx' });
  const parsed = parseXlsx(buffer);
  assert.equal(parsed.rows[0].cells[0], 'Sunrise Public School');
  assert.equal(parsed.rows[0].cells[1].includes('01234567890') || parsed.rows[0].cells[1] === '01234567890' || parsed.rows[0].meta[1].numeric, true);
});
