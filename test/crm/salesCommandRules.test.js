const assert = require('node:assert/strict');
const test = require('node:test');
const { classifyFollowUp, agingBucket, changeRatio, percentRatio, attentionPriority } = require('../../src/services/crm/salesCommandRules');
const { bindPeriod, parseSalesCommandQuery } = require('../../src/services/crm/salesCommandFilters');

const NOW = new Date('2026-09-26T10:00:00.000Z');
const MIDNIGHT = new Date('2026-09-26T18:30:00.000Z');

test('follow-up boundaries use now, 72 hours, and local midnight', () => {
  const base = { status: 'OPEN', parentOpen: true, assigneeActive: true, dueValid: true, now: NOW, nextLocalMidnight: MIDNIGHT };
  assert.equal(classifyFollowUp({ ...base, dueAt: NOW }), 'DUE_TODAY');
  assert.equal(classifyFollowUp({ ...base, dueAt: new Date(NOW.getTime() - 1) }), 'OVERDUE');
  assert.equal(classifyFollowUp({ ...base, dueAt: new Date(NOW.getTime() - 72 * 3600 * 1000) }), 'SEVERELY_OVERDUE');
  assert.equal(classifyFollowUp({ ...base, dueAt: new Date(NOW.getTime() - 72 * 3600 * 1000 + 1000) }), 'OVERDUE');
  assert.equal(classifyFollowUp({ ...base, dueAt: new Date(MIDNIGHT.getTime() - 1) }), 'DUE_TODAY');
  assert.equal(classifyFollowUp({ ...base, dueAt: MIDNIGHT }), 'UPCOMING');
  assert.equal(classifyFollowUp({ ...base, status: 'COMPLETED', dueAt: NOW }), 'COMPLETED');
  assert.equal(classifyFollowUp({ ...base, parentOpen: false, dueAt: new Date(NOW.getTime() - 1000) }), 'NOT_APPLICABLE');
  assert.equal(classifyFollowUp({ ...base, dueValid: false, dueAt: null }), 'DATA_QUALITY');
  assert.equal(classifyFollowUp({ ...base, assigneeActive: false, dueAt: NOW }), 'DATA_QUALITY');
});

test('aging buckets are non-overlapping and 72 hours is 3–7 days', () => {
  assert.equal(agingBucket(72 * 3600), '3_7');
  assert.equal(agingBucket(2 * 86400), '0_2');
  assert.equal(agingBucket(3 * 86400), '3_7');
  assert.equal(agingBucket(31 * 86400), '31_plus');
  assert.equal(agingBucket(null), 'unknown');
  assert.equal(agingBucket(-1), 'unknown');
});

test('rates stay null without a denominator or baseline', () => {
  assert.equal(percentRatio(2, 0, true), null);
  assert.equal(percentRatio(0, 0, true), null);
  assert.equal(percentRatio(2, 10, false), null);
  assert.equal(percentRatio(2, 10, true), 0.2);
  assert.equal(changeRatio(1, 0).change_ratio, null);
  assert.equal(changeRatio(0, 0).comparison_note, 'no comparable baseline');
});

test('Kolkata today and week start at local midnight and comparison is equal length', () => {
  const parsed = parseSalesCommandQuery({ period: 'today', timezone: 'Asia/Kolkata' }, { kind: 'platform', founderId: null });
  const period = bindPeriod(parsed, NOW);
  assert.equal(period.from.toISOString(), '2026-09-25T18:30:00.000Z');
  assert.equal(period.to.toISOString(), NOW.toISOString());
  assert.equal(period.previousTo.toISOString(), period.from.toISOString());
  assert.equal(period.to.getTime() - period.from.getTime(), period.previousTo.getTime() - period.previousFrom.getTime());
  const week = bindPeriod(parseSalesCommandQuery({ period: 'week', timezone: 'Asia/Kolkata' }, { kind: 'platform' }), NOW);
  assert.equal(week.from.toISOString(), '2026-09-20T18:30:00.000Z');
});

test('owner-scoped callers cannot widen the owner filter', () => {
  assert.throws(
    () => parseSalesCommandQuery({ owner: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, { kind: 'owner', founderId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
    (err) => err.code === 'SCOPE_DENIED',
  );
  assert.throws(
    () => parseSalesCommandQuery({ owner: 'unassigned' }, { kind: 'owner', founderId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
    (err) => err.code === 'SCOPE_DENIED',
  );
});

test('attention priority breaks ties by age, age, then entity key', () => {
  const older = { severity: 100, age_seconds: 10, created_at: '2026-01-01T00:00:00.000Z', entity_key: 'enquiry:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
  const newer = { severity: 100, age_seconds: 10, created_at: '2026-01-02T00:00:00.000Z', entity_key: 'enquiry:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
  assert.ok(attentionPriority(older, newer) < 0);
});
