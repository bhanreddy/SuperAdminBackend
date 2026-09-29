const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeDossier, evaluateDossier, suggestCode } = require('../src/services/schoolIntakeIntelligence');

const cluster = { cluster_id: 'cluster_telangana', label: 'Telangana', school_count: 4, max_schools: 40 };

function readyInput() {
  return {
    name: 'Sunrise Public School',
    city: 'Hyderabad',
    state: 'Telangana',
    address: '12 Lake Road',
    pincode: '500001',
    board: 'CBSE',
    principal_name: 'Anita Rao',
    principal_phone: '9876543210',
    principal_email: 'anita@sunrise.edu',
    admin_first_name: 'Anita',
    admin_last_name: 'Rao',
    admin_email: 'admin@sunrise.edu',
    estimated_students: 840,
    primary_color: '#1A73E8',
  };
}

test('a complete dossier is ready and the code is suggested', () => {
  const dossier = normalizeDossier(readyInput());
  assert.equal(dossier.code, suggestCode('Sunrise Public School'));
  assert.equal(dossier.android_package, 'com.nexsyrus.schoolims.sunrisepublicschool');
  const report = evaluateDossier({ dossier, cluster });
  assert.equal(report.grade, 'READY');
  assert.equal(report.blockers.length, 0);
  assert.ok(report.score >= 90);
  assert.match(report.brief, /Sunrise Public School/);
  assert.equal(report.cluster.headroom, 36);
});

test('a live school with the same code blocks onboarding', () => {
  const dossier = normalizeDossier({ ...readyInput(), code: 'SUN' });
  const report = evaluateDossier({
    dossier,
    cluster,
    liveSchools: [{ id: 9, name: 'Sun Valley', code: 'SUN', cluster_id: 'cluster_a' }],
  });
  assert.equal(report.grade, 'BLOCKED');
  assert.ok(report.blockers.some((item) => item.code === 'DUPLICATE'));
});

test('a similar name warns without blocking', () => {
  const dossier = normalizeDossier(readyInput());
  const report = evaluateDossier({
    dossier,
    cluster,
    liveSchools: [{ id: 3, name: 'Sunrise Public School Junior', code: 'SUNJ', cluster_id: 'cluster_a' }],
  });
  assert.notEqual(report.grade, 'BLOCKED');
  assert.ok(report.warnings.some((item) => item.code === 'SIMILAR'));
});

test('invalid admin email and a short name are blockers', () => {
  const dossier = normalizeDossier({ name: 'A', admin_email: 'not-an-email', code: 'A' });
  const report = evaluateDossier({ dossier, cluster });
  assert.equal(report.grade, 'BLOCKED');
  assert.ok(report.blockers.some((item) => item.code === 'NAME' || item.code === 'CODE'));
  assert.ok(report.blockers.some((item) => item.code === 'ADMIN_EMAIL'));
});

test('the same intake is not treated as its own duplicate', () => {
  const dossier = normalizeDossier({ ...readyInput(), code: 'SUN' });
  const report = evaluateDossier({
    dossier,
    cluster,
    excludeIntakeId: 'abc',
    openIntakes: [{ id: 'abc', name: 'Sunrise Public School', code: 'SUN' }],
  });
  assert.equal(report.duplicates.length, 0);
});
