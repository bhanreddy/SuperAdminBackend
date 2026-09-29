/**
 * Pure checks for a school dossier before a tenant exists.
 * Nothing here writes a school. Founder approval is the only path that provisions one.
 */

const BOARDS = ['CBSE', 'ICSE', 'STATE', 'IB', 'IGCSE', 'OTHER'];
const STOP_WORDS = new Set(['SCHOOL', 'PUBLIC', 'HIGH', 'THE', 'OF', 'AND', 'VIDYALAYA', 'ACADEMY']);

function clip(value, max) {
  return String(value || '').trim().slice(0, max);
}

function digits(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function validPhone(phone) {
  if (!phone) return true;
  const d = digits(phone);
  return d.length === 10 || (d.length === 12 && d.startsWith('91'));
}

function validEmail(email) {
  if (!email) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(school|public|high|the|of|and|vidyalaya|academy)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function suggestCode(name) {
  const words = String(name || '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((word) => word && !STOP_WORDS.has(word));
  let code = words.map((word) => word[0]).join('');
  if (code.length < 3) {
    code = (words[0] || String(name || '').toUpperCase().replace(/[^A-Z0-9]/g, '')).slice(0, 8);
  }
  return code.slice(0, 12);
}

function suggestPackage(name) {
  const sanitized = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!sanitized) return '';
  return `com.nexsyrus.schoolims.${sanitized}`.slice(0, 120);
}

function normalizeDossier(input = {}) {
  const name = clip(input.name, 160);
  const typedCode = clip(input.code, 16).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const code = (typedCode || suggestCode(name)).slice(0, 12);
  const board = clip(input.board, 16).toUpperCase();
  const adminEmail = clip(input.admin_email, 160).toLowerCase();
  const principalEmail = clip(input.principal_email, 160).toLowerCase();
  const colorRaw = clip(input.primary_color, 16);
  const color = /^#[0-9A-Fa-f]{6}$/.test(colorRaw) ? colorRaw.toUpperCase() : '#1A73E8';
  const packageRaw = clip(input.android_package, 120).toLowerCase();
  const iosRaw = clip(input.ios_bundle_id, 120).toLowerCase();
  const androidPackage = packageRaw || suggestPackage(name);
  const iosBundle = iosRaw || androidPackage;
  let students = null;
  if (input.estimated_students !== '' && input.estimated_students != null) {
    const parsed = Number(input.estimated_students);
    students = Number.isFinite(parsed) ? Math.round(parsed) : NaN;
  }
  const documents = (Array.isArray(input.documents) ? input.documents : [])
    .slice(0, 6)
    .map((doc) => ({
      label: clip(doc?.label, 80),
      url: clip(doc?.url, 400),
    }))
    .filter((doc) => doc.label || doc.url);

  return {
    name,
    code,
    board: BOARDS.includes(board) ? board : (board ? 'OTHER' : ''),
    board_note: BOARDS.includes(board) || !board ? '' : board,
    address: clip(input.address, 300),
    city: clip(input.city, 80),
    state: clip(input.state, 80),
    pincode: clip(input.pincode, 12).replace(/\D/g, '').slice(0, 6),
    principal_name: clip(input.principal_name, 120),
    principal_phone: clip(input.principal_phone, 20),
    principal_email: principalEmail,
    admin_first_name: clip(input.admin_first_name, 80),
    admin_last_name: clip(input.admin_last_name, 80),
    admin_email: adminEmail,
    admin_phone: clip(input.admin_phone, 20),
    estimated_students: students,
    logo_url: clip(input.logo_url, 400),
    android_package: androidPackage,
    ios_bundle_id: iosBundle,
    primary_color: color,
    color_was_invalid: Boolean(colorRaw) && !/^#[0-9A-Fa-f]{6}$/.test(colorRaw),
    notes: clip(input.notes, 2000),
    documents,
  };
}

function evaluateDossier({ dossier, liveSchools = [], openIntakes = [], cluster = null, excludeIntakeId = null }) {
  const blockers = [];
  const warnings = [];
  const checks = [];
  const push = (list, code, message) => list.push({ code, message });

  if (!dossier.name || dossier.name.length < 3) {
    push(blockers, 'NAME', 'School name needs at least 3 characters.');
  }
  if (!/^[A-Z0-9]{2,12}$/.test(dossier.code || '')) {
    push(blockers, 'CODE', 'School code must be 2–12 letters or numbers.');
  }
  if (dossier.board && !BOARDS.includes(dossier.board)) {
    push(warnings, 'BOARD', 'Board was not recognized and will be stored as Other.');
  }
  if (!validEmail(dossier.principal_email)) push(blockers, 'PRINCIPAL_EMAIL', 'Principal email is not valid.');
  if (!validEmail(dossier.admin_email)) push(blockers, 'ADMIN_EMAIL', 'First admin email is not valid.');
  if (!validPhone(dossier.principal_phone)) push(blockers, 'PRINCIPAL_PHONE', 'Principal phone should be a 10-digit mobile number.');
  if (!validPhone(dossier.admin_phone)) push(blockers, 'ADMIN_PHONE', 'Admin phone should be a 10-digit mobile number.');
  if (dossier.pincode && !/^\d{6}$/.test(dossier.pincode)) {
    push(warnings, 'PINCODE', 'PIN code should be 6 digits.');
  }
  if (Number.isNaN(dossier.estimated_students)) {
    push(blockers, 'STUDENTS', 'Estimated students must be a number.');
  } else if (dossier.estimated_students != null && (dossier.estimated_students < 1 || dossier.estimated_students > 100000)) {
    push(blockers, 'STUDENTS', 'Estimated students looks outside a real school range.');
  }
  if (dossier.logo_url && !/^https?:\/\//i.test(dossier.logo_url)) {
    push(warnings, 'LOGO', 'Logo link should start with http:// or https://.');
  }
  if (dossier.android_package && !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(dossier.android_package)) {
    push(blockers, 'PACKAGE', 'Android package name is not a valid bundle id.');
  }
  dossier.documents.forEach((doc, index) => {
    if (!doc.label || !doc.url) push(warnings, `DOC_${index}`, `Document ${index + 1} needs both a label and a link.`);
    else if (!/^https?:\/\//i.test(doc.url)) push(warnings, `DOC_${index}`, `${doc.label} should be an http(s) link.`);
  });
  if (dossier.color_was_invalid) push(warnings, 'COLOR', 'Brand color was not a hex value, so #1A73E8 will be used.');

  const nameKey = normalizeName(dossier.name);
  const duplicates = [];
  const consider = (source, id, name, code, extra = {}) => {
    if (!id || (excludeIntakeId && String(id) === String(excludeIntakeId))) return;
    const sameCode = code && dossier.code && String(code).toUpperCase() === dossier.code;
    const otherName = normalizeName(name);
    const sameName = nameKey && otherName && nameKey === otherName;
    const closeName = nameKey && otherName && nameKey.length > 6 && (nameKey.includes(otherName) || otherName.includes(nameKey));
    if (sameCode) {
      duplicates.push({ source, id, name, code, reason: 'Same school code', severity: 'block', ...extra });
    } else if (sameName) {
      duplicates.push({ source, id, name, code, reason: 'Same school name', severity: 'block', ...extra });
    } else if (closeName) {
      duplicates.push({ source, id, name, code, reason: 'Very similar school name', severity: 'warn', ...extra });
    }
  };

  liveSchools.forEach((school) => consider('live', school.id, school.name, school.code, { cluster_id: school.cluster_id }));
  openIntakes.forEach((item) => consider('intake', item.id, item.name, item.code));

  duplicates.filter((item) => item.severity === 'block').forEach((item) => {
    push(blockers, 'DUPLICATE', `${item.reason}: ${item.name} (${item.code || 'no code'}) is already ${item.source === 'live' ? 'a live school' : 'in the founder queue'}.`);
  });
  duplicates.filter((item) => item.severity === 'warn').forEach((item) => {
    push(warnings, 'SIMILAR', `${item.name} looks similar. Confirm this is a different school before the founder approves.`);
  });

  if (!dossier.city || !dossier.state) push(warnings, 'LOCATION', 'City and state help the founder place the school.');
  if (!dossier.principal_name || !dossier.principal_phone) push(warnings, 'PRINCIPAL', 'Principal name and phone are missing.');
  if (!dossier.admin_email || !dossier.admin_first_name) {
    push(warnings, 'ADMIN', 'First admin is incomplete, so approval will create the school without an admin login.');
  }
  if (!dossier.board) push(warnings, 'BOARD_MISSING', 'Board is not set.');
  if (!cluster) push(warnings, 'CLUSTER', 'No cluster has free capacity right now. Approval will wait until one does.');

  const points = [
    ['Identity', dossier.name.length >= 3 && /^[A-Z0-9]{2,12}$/.test(dossier.code), 20],
    ['Location', Boolean(dossier.address && dossier.city && dossier.state), 15],
    ['Board', Boolean(dossier.board), 10],
    ['Principal', Boolean(dossier.principal_name && dossier.principal_phone), 15],
    ['First admin', Boolean(dossier.admin_email && dossier.admin_first_name && dossier.admin_last_name), 15],
    ['Size', dossier.estimated_students > 0, 10],
    ['Brand', Boolean(dossier.logo_url || dossier.primary_color), 5],
    ['Unique', !duplicates.some((item) => item.severity === 'block'), 10],
  ];
  const score = points.reduce((sum, [, ok, weight]) => sum + (ok ? weight : 0), 0);
  points.forEach(([label, ok]) => {
    checks.push({ label, status: ok ? 'pass' : 'warn' });
  });
  blockers.forEach((item) => {
    const existing = checks.find((check) => check.label === 'Identity' && (item.code === 'NAME' || item.code === 'CODE'));
    if (existing) existing.status = 'fail';
  });

  let grade = 'READY';
  if (blockers.length) grade = 'BLOCKED';
  else if (warnings.length || score < 70) grade = 'REVIEW';

  const place = [dossier.city, dossier.state].filter(Boolean).join(', ');
  const clusterLine = cluster
    ? `${cluster.label} has room for ${Math.max(cluster.max_schools - cluster.school_count, 0)} more schools.`
    : 'No cluster has free capacity.';
  const adminLine = dossier.admin_email && dossier.admin_first_name
    ? 'Approval will create the tenant, assign it to the executive, and provision the first admin automatically.'
    : 'Approval will create the tenant and assign it to the executive. A first admin can be added later.';
  const brief = blockers.length
    ? `${dossier.name || 'This dossier'} cannot be onboarded yet. ${blockers[0].message}`
    : `${dossier.name || 'This school'}${dossier.code ? ` (${dossier.code})` : ''}${place ? ` in ${place}` : ''} is ${score}% complete. ${clusterLine} ${adminLine}`;

  return {
    score,
    grade,
    blockers,
    warnings,
    duplicates,
    checks,
    brief,
    cluster: cluster
      ? {
        cluster_id: cluster.cluster_id,
        label: cluster.label,
        school_count: cluster.school_count,
        max_schools: cluster.max_schools,
        headroom: Math.max(cluster.max_schools - cluster.school_count, 0),
      }
      : null,
    auto_steps: [
      'Pick the cluster with the most free capacity',
      'Create the school tenant',
      'Assign the school back to the sales executive',
      dossier.admin_email && dossier.admin_first_name ? 'Provision the first admin with a one-time password' : 'Skip first admin until a complete admin is provided',
      'Seed default roles for the new school',
    ],
  };
}

module.exports = {
  BOARDS,
  normalizeName,
  suggestCode,
  suggestPackage,
  normalizeDossier,
  evaluateDossier,
};
