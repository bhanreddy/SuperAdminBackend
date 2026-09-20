const test = require('node:test');
const assert = require('node:assert/strict');

const definition = require('../src/data/redAlertSprintV3.json');
const { DAYS_META, ALL_TASKS, ROLE_KEYS } = require('../src/services/sprintSeed');

test('RED ALERT v3 has the expected execution shape', () => {
  assert.equal(definition.version, 'red-alert-v3');
  assert.equal(definition.duration_days, 10);
  assert.equal(definition.total_deliverables, 100);
  assert.equal(DAYS_META.length, 10);
  assert.equal(ALL_TASKS.length, 100);
  assert.deepEqual(ROLE_KEYS, ['tech', 'curr', 'sales', 'scale']);
});

test('each owner has 25 valid, uniquely identified deliverables', () => {
  const ids = new Set();

  for (const role of ROLE_KEYS) {
    const ownedTasks = ALL_TASKS.filter((task) => task.role === role);
    assert.equal(ownedTasks.length, 25, `${role} should own 25 tasks`);
  }

  for (const task of ALL_TASKS) {
    assert.match(task.id, /^red-v3-(tech|curr|sales|scale)-\d+$/);
    assert.ok(!ids.has(task.id), `duplicate id: ${task.id}`);
    assert.ok(task.day >= 1 && task.day <= 10, `${task.id} has an invalid day`);
    assert.ok(task.title.trim().length > 0, `${task.id} is missing a title`);
    assert.ok(task.category.trim().length > 0, `${task.id} is missing a category`);
    ids.add(task.id);
  }
});

test('every execution day contains work', () => {
  const scheduledDays = new Set(ALL_TASKS.map((task) => task.day));
  assert.deepEqual([...scheduledDays].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});
