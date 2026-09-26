const {
  LIMITS,
  CALLING_CODES,
  COUNTRY_ALIASES,
  STATE_ALIASES,
  NAME_ABBREVIATIONS,
  ROLE_CODES,
} = require('./limits');

const NORMALIZATION_VERSION = 1;
const PHONE_DELIMITERS = /(?:\s*(?:;|\||\n|\r| \/ )\s*)/;

function collapse(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function fold(value) {
  return collapse(value).toLowerCase();
}

function clip(value, max) {
  const text = collapse(value);
  if (!text) return '';
  return text.length > max ? text.slice(0, max) : text;
}

function strictSchoolName(value) {
  let text = collapse(value).toLowerCase();
  text = text.replace(/[’']/g, '');
  text = text.replace(/[—–−-]/g, ' ');
  text = text.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  return text.replace(/\s+/g, ' ').trim();
}

function looseSchoolName(value) {
  const strict = strictSchoolName(value);
  if (!strict) return '';
  const tokens = strict.split(' ').flatMap((token) => {
    const mapped = NAME_ABBREVIATIONS[token];
    return mapped ? mapped.split(' ') : [token];
  });
  return tokens.join(' ');
}

function countryCode(value) {
  const raw = collapse(value);
  if (!raw) return { raw: '', code: null, recognized: false };
  const folded = fold(raw);
  const code = COUNTRY_ALIASES[folded] || (/^[A-Za-z]{2}$/.test(raw) ? raw.toUpperCase() : null);
  return { raw, code: code && CALLING_CODES[code] ? code : code, recognized: Boolean(code && CALLING_CODES[code]) };
}

function adminName(kind, value, country) {
  const raw = collapse(value);
  if (!raw) return { raw: '', normalized: null, recognized: false };
  const folded = fold(raw);
  const table = kind === 'state' ? STATE_ALIASES[country] : null;
  const normalized = table?.[folded] || folded;
  return { raw, normalized, recognized: Boolean(table?.[folded]) };
}

function locationKey(parts) {
  if (!parts.country || !parts.countryRecognized) return null;
  const pieces = [parts.state, parts.district, parts.city, parts.locality, parts.postal].filter(Boolean);
  if (!pieces.length) return null;
  return [parts.country, parts.state || '', parts.district || '', parts.city || '', parts.locality || '', parts.postal || ''].join('|');
}

function normalizeLocation(input = {}) {
  const country = countryCode(input.country || input.country_code);
  const state = adminName('state', input.state, country.code);
  const district = { raw: collapse(input.district), normalized: fold(input.district) || null };
  const city = { raw: collapse(input.city || input.town), normalized: fold(input.city || input.town) || null };
  const locality = { raw: clip(input.locality, LIMITS.locality), normalized: fold(input.locality) || null };
  const mandal = { raw: clip(input.mandal, LIMITS.mandal), normalized: fold(input.mandal) || null };
  const postalRaw = collapse(input.postal_code || input.postal || input.pincode);
  const postal = postalRaw.replace(/\s+/g, '');
  const key = locationKey({
    country: country.code,
    countryRecognized: country.recognized,
    state: state.normalized,
    district: district.normalized,
    city: city.normalized,
    locality: locality.normalized,
    postal: postal || null,
  });
  return {
    country_code: country.code,
    country_raw: country.raw || null,
    country_recognized: country.recognized,
    state_raw: state.raw || null,
    state_normalized: state.normalized,
    state_recognized: state.recognized,
    district_raw: district.raw || null,
    district_normalized: district.normalized,
    city_raw: city.raw || null,
    city_normalized: city.normalized,
    locality_raw: locality.raw || null,
    locality_normalized: locality.normalized,
    mandal_raw: mandal.raw || null,
    mandal_normalized: mandal.normalized,
    address_line_1: clip(input.address_line_1 || input.address, LIMITS.address) || null,
    address_line_2: clip(input.address_line_2, LIMITS.address) || null,
    postal_code: postal || null,
    location_key: key,
    location_complete: Boolean(key),
  };
}

function decodeXml(text) {
  return String(text)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function splitChannels(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return [];
  if (/[,，]/.test(raw) && !PHONE_DELIMITERS.test(raw)) {
    return [{ ok: false, code: 'AMBIGUOUS_CHANNEL_LIST', display: raw }];
  }
  return raw.split(PHONE_DELIMITERS).map((part) => part.trim()).filter(Boolean).map((part) => ({ ok: true, display: part }));
}

function extractExtension(value) {
  const match = String(value).match(/^(.*?)(?:\s*(?:ext\.?|extension|x)\s*(\d{1,8}))\s*$/i);
  if (!match) return { body: String(value), extension: null };
  return { body: match[1], extension: match[2] };
}

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizePhone(value, countryInput) {
  const country = countryCode(countryInput);
  const original = collapse(value);
  if (!original) return { ok: false, code: 'PHONE_EMPTY' };
  if (original.length > LIMITS.phoneDisplay) return { ok: false, code: 'PHONE_TOO_LONG', display: original };
  const { body, extension } = extractExtension(original);
  const compact = body.replace(/[\s().-]/g, '');
  if (!/^\+?\d+$/.test(compact)) return { ok: false, code: 'PHONE_INVALID', display: original };
  let national = compact;
  let calling = null;
  if (compact.startsWith('+')) {
    national = compact.slice(1);
    if (!country.recognized) {
      const inferred = Object.entries(CALLING_CODES).find(([, code]) => national.startsWith(code) && national.length > code.length + 6);
      if (!inferred) return { ok: false, code: 'COUNTRY_REQUIRED', display: original };
    }
  } else if (!country.recognized) {
    return { ok: false, code: 'COUNTRY_REQUIRED', display: original };
  }
  if (country.recognized) calling = CALLING_CODES[country.code];
  if (compact.startsWith('+')) {
    if (country.recognized && !national.startsWith(calling)) {
      return { ok: false, code: 'COUNTRY_MISMATCH', display: original };
    }
    if (!country.recognized) {
      const match = Object.entries(CALLING_CODES).find(([, code]) => national.startsWith(code));
      if (!match) return { ok: false, code: 'PHONE_INVALID', display: original };
      calling = match[1];
    }
    national = national.slice(calling.length);
  } else if (country.code === 'IN') {
    if (/^0[6-9]\d{9}$/.test(national)) national = national.slice(1);
    else if (/^0\d+$/.test(national)) return { ok: false, code: 'AMBIGUOUS_LANDLINE', display: original };
  } else if (country.code === 'US' || country.code === 'CA') {
    if (national.length === 11 && national.startsWith('1')) national = national.slice(1);
  }
  if (country.code === 'IN' || calling === '91') {
    if (!/^[6-9]\d{9}$/.test(national)) return { ok: false, code: 'PHONE_INVALID', display: original };
    calling = '91';
  } else if ((country.code === 'US' || country.code === 'CA') && calling === '1') {
    if (!/^[2-9]\d{9}$/.test(national)) return { ok: false, code: 'PHONE_INVALID', display: original };
  } else if (!/^\d{6,14}$/.test(national) || !calling) {
    return { ok: false, code: 'PHONE_INVALID', display: original };
  }
  const e164 = `+${calling}${national}`;
  if (digitsOnly(e164).length < 8 || digitsOnly(e164).length > 15) {
    return { ok: false, code: 'PHONE_INVALID', display: original };
  }
  return {
    ok: true,
    display: original,
    normalized: e164,
    extension: extension || null,
    country_code: country.code || Object.entries(CALLING_CODES).find(([, code]) => code === calling)?.[0] || null,
  };
}

function normalizeEmail(value) {
  const display = collapse(value);
  if (!display) return { ok: false, code: 'EMAIL_EMPTY' };
  if (display.length > LIMITS.email) return { ok: false, code: 'EMAIL_TOO_LONG', display };
  const match = display.match(/^([^@\s]+)@([^@\s]+)$/);
  if (!match) return { ok: false, code: 'EMAIL_INVALID', display };
  const local = match[1];
  const domain = match[2];
  if (local.length > 64 || domain.length > 253 || !domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) {
    return { ok: false, code: 'EMAIL_INVALID', display };
  }
  if (/[^\x21-\x7E]/.test(local) || /[^a-zA-Z0-9.-]/.test(domain)) {
    return { ok: false, code: 'EMAIL_INVALID', display };
  }
  return { ok: true, display, normalized: `${local}@${domain.toLowerCase()}` };
}

function normalizeUdise(value, meta = {}) {
  if (value == null || value === '') return { ok: true, udise: null, valid: false };
  const raw = String(value);
  if (meta.formula) return { ok: false, code: 'FORMULA_IDENTIFIER', display: raw };
  if (meta.numeric) return { ok: false, code: 'ROUNDED_IDENTIFIER', display: raw };
  const text = raw.normalize('NFKC').trim();
  if (/[eE][+-]?\d+/.test(text) || /[.,]/.test(text)) {
    return { ok: false, code: 'AMBIGUOUS_IDENTIFIER', display: text };
  }
  if (!/^\d{11}$/.test(text)) return { ok: false, code: 'UDISE_INVALID', display: text };
  return { ok: true, udise: text, valid: true, display: text };
}

function roleCode(value) {
  const raw = collapse(value);
  if (!raw) return { role_code: null, role_title: null };
  const folded = fold(raw).replace(/[_-]+/g, ' ');
  const map = {
    principal: 'PRINCIPAL',
    headmaster: 'PRINCIPAL',
    headmistress: 'PRINCIPAL',
    'head master': 'PRINCIPAL',
    correspondent: 'CORRESPONDENT',
    owner: 'OWNER',
    trustee: 'OWNER',
    'owner trustee': 'OWNER',
    administrator: 'ADMINISTRATOR',
    admin: 'ADMINISTRATOR',
    accounts: 'ACCOUNTS',
    finance: 'ACCOUNTS',
    'accounts finance': 'ACCOUNTS',
    it: 'IT',
    'it coordinator': 'IT',
    admissions: 'ADMISSIONS',
    other: 'OTHER',
  };
  const code = map[folded] || 'OTHER';
  if (!ROLE_CODES.includes(code)) return { role_code: 'OTHER', role_title: clip(raw, LIMITS.roleTitle) };
  return { role_code: code, role_title: code === 'OTHER' ? clip(raw, LIMITS.roleTitle) : clip(raw, LIMITS.roleTitle) };
}

function personName(value, explicitUnknown = false) {
  const raw = collapse(value);
  if (explicitUnknown) {
    if (raw) return { ok: false, code: 'UNKNOWN_NAME_NOT_EMPTY' };
    return { ok: true, name_status: 'UNKNOWN', full_name: null, display_name: 'Name unknown' };
  }
  if (!raw || raw.length < 2) return { ok: false, code: 'NAME_REQUIRED' };
  if (raw.length > LIMITS.personName) return { ok: false, code: 'NAME_TOO_LONG' };
  return { ok: true, name_status: 'VERIFIED', full_name: raw, display_name: raw };
}

function normalizeSchool(input = {}, defaults = {}) {
  const name = clip(input.school_name || input.name, LIMITS.schoolName);
  const strict = strictSchoolName(name);
  const loose = looseSchoolName(name);
  const countryDefault = defaults.country_code || defaults.country || null;
  const location = normalizeLocation({ ...input, country: input.country || input.country_code || countryDefault });
  const udise = normalizeUdise(input.udise_code ?? input.udise, { formula: input.udise_formula, numeric: input.udise_numeric });
  const phoneParts = input.phone || input.organization_phone ? splitChannels(input.phone || input.organization_phone) : [];
  const emailParts = input.email || input.organization_email ? splitChannels(input.email || input.organization_email) : [];
  const phones = phoneParts.map((part) => (part.ok === false ? part : normalizePhone(part.display, location.country_code)));
  const emails = emailParts.map((part) => (part.ok === false ? part : normalizeEmail(part.display)));
  const errors = [];
  if (!strict) errors.push({ code: 'SCHOOL_NAME_REQUIRED', field: 'school_name' });
  if (udise.ok === false) errors.push({ code: udise.code, field: 'udise' });
  phones.filter((item) => item.ok === false && item.code !== 'PHONE_EMPTY').forEach((item) => errors.push({ code: item.code, field: 'phone' }));
  emails.filter((item) => item.ok === false && item.code !== 'EMAIL_EMPTY').forEach((item) => errors.push({ code: item.code, field: 'email' }));
  const students = input.estimated_student_count;
  let estimated = null;
  if (students != null && students !== '') {
    if (!/^\d+$/.test(String(students).trim()) || Number(students) > LIMITS.estimatedStudentsMax) {
      errors.push({ code: 'BAD_STUDENT_COUNT', field: 'estimated_student_count' });
    } else estimated = Number(students);
  }
  return {
    normalization_version: NORMALIZATION_VERSION,
    school_name: name || null,
    school_name_normalized: strict || null,
    school_name_loose: loose || null,
    udise_code: udise.ok && udise.valid ? udise.udise : null,
    udise_valid: Boolean(udise.ok && udise.valid),
    location,
    phones: phones.filter((item) => item.ok),
    emails: emails.filter((item) => item.ok),
    board: clip(input.board, 80) || null,
    management_type: clip(input.management_type, 80) || null,
    website: clip(input.website, 200) || null,
    estimated_student_count: estimated,
    notes: clip(input.notes, LIMITS.notes) || null,
    errors,
    valid: errors.length === 0 && Boolean(strict),
  };
}

function normalizeContact(input = {}, country) {
  const unknown = input.name_status === 'UNKNOWN' || input.explicit_unknown_name === true;
  const name = personName(input.full_name || input.name, unknown);
  const role = roleCode(input.role || input.role_title || input.role_code);
  const phones = (input.phones || [input.phone].filter(Boolean)).flatMap((value) => {
    const parts = splitChannels(value);
    return parts.map((part) => (part.ok === false ? part : normalizePhone(part.display, country)));
  });
  const emails = (input.emails || [input.email].filter(Boolean)).flatMap((value) => {
    const parts = splitChannels(value);
    return parts.map((part) => (part.ok === false ? part : normalizeEmail(part.display)));
  });
  const whatsapp = input.whatsapp ? [normalizePhone(input.whatsapp, country)].map((item) => (item.ok ? { ...item, method_type: 'WHATSAPP' } : item)) : [];
  const errors = [];
  if (!name.ok) errors.push({ code: name.code, field: 'full_name' });
  [...phones, ...emails, ...whatsapp].filter((item) => item && item.ok === false).forEach((item) => errors.push({ code: item.code, field: 'channel' }));
  return {
    normalization_version: NORMALIZATION_VERSION,
    name_status: name.ok ? name.name_status : null,
    full_name: name.ok ? name.full_name : null,
    display_name: name.ok ? name.display_name : null,
    role_code: role.role_code,
    role_title: role.role_title,
    is_decision_maker: Boolean(input.is_decision_maker),
    department: clip(input.department, 80) || null,
    preferred_language: clip(input.preferred_language, 40) || null,
    preferred_channel: ['PHONE', 'EMAIL', 'WHATSAPP', 'IN_APP'].includes(input.preferred_channel) ? input.preferred_channel : null,
    notes: clip(input.notes, LIMITS.notes) || null,
    phones: phones.filter((item) => item.ok).map((item) => ({ ...item, method_type: 'PHONE' })),
    emails: emails.filter((item) => item.ok).map((item) => ({ ...item, method_type: 'EMAIL' })),
    whatsapp: whatsapp.filter((item) => item.ok),
    errors,
    valid: errors.length === 0,
  };
}

module.exports = {
  NORMALIZATION_VERSION,
  collapse,
  fold,
  strictSchoolName,
  looseSchoolName,
  countryCode,
  normalizeLocation,
  normalizePhone,
  normalizeEmail,
  normalizeUdise,
  normalizeSchool,
  normalizeContact,
  roleCode,
  personName,
  splitChannels,
  decodeXml,
};
