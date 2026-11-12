const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../dist/counter-work.js');

const asOf = '2026-11-12T02:00:00.000Z';

test('ready refund maps to W11 kind and available refund destination', () => {
  const task = c.projectCounterWorkTask({
    kind: 'refund',
    id: '00000000-0000-4000-8000-000000000001',
    approval: { evidenceId: '00000000-0000-4000-8000-000000000099', state: 'matches', changes: [] },
    approvedAt: '2026-11-11T10:00:00.000Z',
    readyAt: '2026-11-11T10:00:00.000Z',
    asOf,
  });
  assert.equal(task.stage, 'ready_for_execution');
  assert.equal(task.dailyWorkKind, 'sale_refund.execute');
  assert.equal(task.destination, 'refund');
  assert.equal(task.destinationStatus, 'available');
  assert.equal(task.nextAction.executable, true);
  assert.equal(task.blocker, null);
  assert.equal(task.freshness.stale, false);
  assert.equal(task.signedExecution.operation, 'POST /api/v1/sales/refund-requests/:id/execute');
  assert.equal(task.signedExecution.bodyIdKey, 'refundRequestId');
  assert.equal(task.signedExecution.approvalEvidenceId, '00000000-0000-4000-8000-000000000099');
  assert.deepEqual(task.offline, {
    list: 'online_only',
    execution: 'online_only',
    partialOutage: 'last_known_read_only',
  });
});

test('changed approval blocks execution with APPROVAL_STALE errors', () => {
  const task = c.projectCounterWorkTask({
    kind: 'held_delivery',
    id: '00000000-0000-4000-8000-000000000002',
    approval: { evidenceId: 'ev-1', state: 'changed', changes: ['the purchase order'] },
    approvedAt: '2026-11-10T08:00:00.000Z',
    readyAt: '2026-11-10T08:00:00.000Z',
    asOf,
  });
  assert.equal(task.stage, 'blocked_approval');
  assert.equal(task.blocker.code, 'APPROVAL_STALE');
  assert.equal(task.nextAction.executable, false);
  assert.equal(task.freshness.stale, true);
  assert.equal(task.signedExecution.approvalEvidenceId, null);
  assert.deepEqual(task.executeErrors, [
    { phase: 'prepare', code: 'APPROVAL_STALE' },
    { phase: 'execute', code: 'APPROVAL_STALE' },
  ]);
});

test('revoked approval uses APPROVAL_INVALID', () => {
  const task = c.projectCounterWorkTask({
    kind: 'held_adjustment',
    id: '00000000-0000-4000-8000-000000000003',
    approval: { evidenceId: 'ev-2', state: 'revoked', changes: [] },
    approvedAt: null,
    readyAt: '2026-11-09T12:00:00.000Z',
    asOf,
  });
  assert.equal(task.blocker.code, 'APPROVAL_INVALID');
  assert.match(task.blocker.message, /withdrawn/);
});

test('planned P6 screens still list as ready_for_execution with non-executable next action label', () => {
  const task = c.projectCounterWorkTask({
    kind: 'stocktake',
    id: '00000000-0000-4000-8000-000000000004',
    approval: { evidenceId: 'ev-3', state: 'matches', changes: [] },
    approvedAt: '2026-11-11T09:00:00.000Z',
    readyAt: '2026-11-11T09:00:00.000Z',
    asOf,
  });
  assert.equal(task.stage, 'ready_for_execution');
  assert.equal(task.destinationStatus, 'planned');
  assert.equal(task.nextAction.executable, false);
  assert.match(task.nextAction.label, /screen planned/);
});

test('coverage matrix includes every counter-work kind', () => {
  for (const kind of c.COUNTER_WORK_KINDS) {
    assert.ok(c.COUNTER_WORK_DESTINATION_BY_KIND[kind]);
    assert.ok(c.COUNTER_WORK_DAILY_KIND[kind]);
    assert.ok(c.COUNTER_WORK_OPERATION[kind]);
  }
});
