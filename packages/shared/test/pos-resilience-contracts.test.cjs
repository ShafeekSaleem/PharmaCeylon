const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../dist/index.js');
const fixtures = require('./terminal-fixtures.cjs');

function afterHours() {
  const f = structuredClone(fixtures);
  f.sale.occurredAt = f.grant.operatingWindows[0].endsAt;
  const manager = { ...f.grant.authorizedStaff[0], staffUserId: 'manager1', staffAuthorizationId: 'manager-auth',
    offlineManagerActions: ['acknowledge_business_hours', 'assist_shift_handover'] };
  f.grant.authorizedStaff.push(manager);
  const managerSignIn = { ...f.staffSignIn, staffSignInId: 'manager-sign-in', staffAuthorizationId: manager.staffAuthorizationId,
    session: { ...f.sale.session, staffUserId: manager.staffUserId } };
  const acknowledgement = { contractVersion: 1, kind: 'business_hours_acknowledgement', recordId: 'hours1',
    identity: f.grant.identity, grantId: f.grant.grantId, grantVersion: f.grant.grantVersion,
    nominationVersion: f.grant.nominationVersion, offlineSessionId: f.sale.offlineSessionId,
    managerSignInId: managerSignIn.staffSignInId, recordedAt: f.sale.occurredAt,
    startsAt: f.sale.occurredAt, endsAt: f.sale.occurredAt + 3600000, reason: 'Serve remaining customers' };
  f.sale.businessHoursAcknowledgementId = acknowledgement.recordId;
  return { ...f, evidence: { acknowledgement, managerSignIn } };
}
const saleCheck = f => c.offlineSalePolicyError(f.grant, f.snapshot, f.sale, f.usage, f.sale.occurredAt,
  'offline', f.staffSignIn, f.openShift, f.evidence);

test('routine closing time needs prepared manager acknowledgement; it does not reset stock or expiry', () => {
  const f = afterHours();
  assert.equal(c.offlineGrantTimeError(f.grant, f.sale.occurredAt), 'BUSINESS_HOURS_ACK_REQUIRED');
  assert.equal(saleCheck(f), null);
  f.usage.quantities['line-1'] = 20;
  assert.equal(saleCheck(f), 'LOCAL_STOCK_EXHAUSTED');
  f.sale.occurredAt = f.grant.expiresAt;
  assert.equal(saleCheck(f), 'GRANT_EXPIRED');
});
test('mandatory restrictions cannot be overridden by acknowledgement or an online business extension', () => {
  const f = afterHours();
  f.grant.mandatoryOperatingWindows = [...f.grant.operatingWindows];
  f.grant.operatingHoursException = { approvalId: 'extension', approverUserId: 'manager1', reason: 'Business extension',
    startsAt: f.sale.occurredAt, endsAt: f.sale.occurredAt + 3600000 };
  assert.equal(saleCheck(f), 'OUTSIDE_OPERATING_HOURS');
  f.grant.mandatoryOperatingWindows = [];
  f.sale.occurredAt = f.grant.notBefore + 1000;
  assert.equal(saleCheck(f), 'OUTSIDE_OPERATING_HOURS');
});
test('after-hours evidence cannot cross grants, nomination, branch, outage or acknowledged record identity', () => {
  for (const changed of [{ grantId: 'other' }, { grantVersion: 2 }, { nominationVersion: 2 },
    { offlineSessionId: 'other' }, { recordId: 'other' }, { reason: '' }, { managerSignInId: 'other' }]) {
    const f = afterHours();
    Object.assign(f.evidence.acknowledgement, changed);
    assert.equal(saleCheck(f), 'BUSINESS_HOURS_ACK_REQUIRED');
  }
  const f = afterHours();
  f.evidence.acknowledgement.identity = { ...f.grant.identity, branchId: 'wrong' };
  assert.equal(saleCheck(f), 'BUSINESS_HOURS_ACK_REQUIRED');
});
test('ordinary staff, forged credential versions and future/expired acknowledgement cannot authorize after-hours', () => {
  for (const mutate of [f => f.grant.authorizedStaff[1].offlineManagerActions = [],
    f => f.evidence.managerSignIn.credentialVersion++,
    f => f.evidence.managerSignIn.authenticatedAt = f.sale.occurredAt + 1,
    f => f.evidence.acknowledgement.endsAt = f.sale.occurredAt,
    f => f.evidence.acknowledgement.endsAt = f.grant.expiresAt + 1,
    f => f.evidence.acknowledgement.startsAt = f.sale.occurredAt + 1]) {
    const f = afterHours(); mutate(f);
    assert.equal(saleCheck(f), 'BUSINESS_HOURS_ACK_REQUIRED');
  }
});
test('old or malformed grant fields cannot silently enable manager actions or remove mandatory hours', () => {
  const missingHours = afterHours();
  delete missingHours.grant.mandatoryOperatingWindows;
  assert.equal(saleCheck(missingHours), 'GRANT_INVALID');
  const missingCapabilities = afterHours();
  delete missingCapabilities.grant.authorizedStaff[1].offlineManagerActions;
  assert.equal(saleCheck(missingCapabilities), 'GRANT_INVALID');
  const unknownCapability = afterHours();
  unknownCapability.grant.authorizedStaff[1].offlineManagerActions.push('approve_refund');
  assert.equal(saleCheck(unknownCapability), 'GRANT_INVALID');
});
test('manager may close absent cashier shift with own evidence and preserved original cashier/variance', () => {
  const f = afterHours();
  const close = { ...f.sale, kind: 'shift_close', sequence: 2, previousCommandHash: 'a'.repeat(64),
    staffSignInId: f.evidence.managerSignIn.staffSignInId, closingCashCountMinor: 9800, expectedCashMinor: 10000,
    assistance: { managerSignInId: f.evidence.managerSignIn.staffSignInId, reason: 'Cashier left unexpectedly' } };
  const current = { openShift: f.openShift, expectedCashMinor: 10000, lastClosedWorkSessionId: null,
    usedWorkSessionIds: [f.openShift.session.workSessionId] };
  const run = () => c.offlineShiftTransition(f.grant, close, current, f.evidence.managerSignIn, close.occurredAt, 'offline');
  const result = run();
  assert.equal(result.error, null);
  assert.equal(result.closingSummary.session.staffUserId, fixtures.sale.session.staffUserId);
  assert.equal(result.closingSummary.countedByUserId, 'manager1');
  assert.equal(result.closingSummary.varianceMinor, -200);
  assert.equal(result.next.openShift, null);
  close.assistance.reason = '';
  assert.equal(run().error, 'SESSION_INVALID');
  close.assistance.reason = 'Cashier absent';
  f.grant.authorizedStaff[1].offlineManagerActions = [];
  assert.equal(run().error, 'SESSION_INVALID');
});
test('shift opening after business hours uses the same acknowledgement but never a mandatory-hours override', () => {
  const f = afterHours();
  const open = { ...f.sale, kind: 'shift_open', openingCashMinor: 10000, previousClosedWorkSessionId: null };
  const current = { openShift: null, expectedCashMinor: null, lastClosedWorkSessionId: null, usedWorkSessionIds: [] };
  assert.equal(c.offlineShiftTransition(f.grant, open, current, f.staffSignIn, open.occurredAt, 'offline', f.evidence).error, null);
  f.grant.mandatoryOperatingWindows = [];
  assert.equal(c.offlineShiftTransition(f.grant, open, current, f.staffSignIn, open.occurredAt, 'offline', f.evidence).error, 'OUTSIDE_OPERATING_HOURS');
});
test('assignment authorization is remote-capable; activation requires exact target/local checks and D11 clearance', () => {
  assert.equal(c.mayManageOfflineTerminal({ online: true, isOwner: true, isManagerAtBranch: false, hasActiveOwnerDelegation: false }), true);
  const remote = { online: true, authenticated: true, branchAccessVerified: true, permissionGranted: true,
    terminalEnrolled: false, enrollmentBranchMatches: false, localAttendanceVerified: false };
  assert.equal(c.onlineOperationAccessError(['terminal_assignment_authorization'], remote), null);
  assert.equal(c.onlineOperationAccessError(['terminal_designation'], remote), 'TERMINAL_REQUIRED');
  const activation = { online: true, localAttendanceVerified: true, localStaffAuthorized: true,
    authorizationCurrentAndActorStillAuthorized: true, targetEnrollmentMatches: true,
    nominationVersionMatches: true, previousOfflineAuthorityCleared: true };
  assert.equal(c.mayActivateOfflineTerminal(activation), true);
  for (const flag of Object.keys(activation)) assert.equal(c.mayActivateOfflineTerminal({ ...activation, [flag]: false }), false);
});
test('uncertain card attempts recover the original outcome instead of inviting another charge', () => {
  assert.equal(c.externalCardRecoveryAction('prepared'), 'verify_original_attempt');
  assert.equal(c.externalCardRecoveryAction('uncertain'), 'verify_original_attempt');
  assert.equal(c.externalCardRecoveryAction('approved'), 'complete_original_sale');
  assert.equal(c.externalCardRecoveryAction('linked_to_sale'), 'recover_receipt');
  assert.equal(c.externalCardRecoveryAction('declined'), 'retry_payment_with_new_attempt');
  assert.throws(() => c.externalCardRecoveryAction('unknown'));
});
test('readiness shows preparation/storage/payment issues before an outage', () => {
  const ready = { nominated: true, grantUsable: true, snapshotFreshForOutageEntry: true, preparedStaffAvailable: true,
    localStorageHealthy: true, trustedClock: true, localAttendanceVerified: true,
    unresolvedPaymentAttempt: false, syncInProgress: false };
  assert.deepEqual(c.offlineReadinessIssues(ready), []);
  assert.deepEqual(c.offlineReadinessIssues({ ...ready, localStorageHealthy: false, unresolvedPaymentAttempt: true }),
    ['localStorageHealthy', 'unresolvedPaymentAttempt']);
});
test('drain waits for stable connection and durably quiesced checkout; unresolved outcomes resolve during drain', () => {
  const ready = { authenticatedConnectionStable: true, currentCheckoutDurablyQuiesced: true, unresolvedPaymentsDurablyRecorded: true };
  assert.equal(c.mayBeginReconnectDrain(ready), true);
  for (const flag of Object.keys(ready)) assert.equal(c.mayBeginReconnectDrain({ ...ready, [flag]: false }), false);
  const resume = { authenticated: true, journalAcceptedThroughLastLocalCommand: true, uncertainCommandsResolved: true,
    freshSnapshotInstalled: true, stockReviewBlocksInstalled: true, supportRecordsAccepted: true, paymentAttemptsResolved: true };
  assert.equal(c.mayResumeOnlineCheckout({ ...resume, supportRecordsAccepted: false }), false);
  assert.equal(c.mayResumeOnlineCheckout({ ...resume, paymentAttemptsResolved: false }), false);
});
test('OS reboot needs cross-boot time evidence; an app restart proof alone cannot restore authority', () => {
  const f = fixtures;
  const boundary = { grantId: f.grant.grantId, grantVersion: 1, grantExpiresAt: f.grant.expiresAt,
    offlineSessionId: f.sale.offlineSessionId, offlineStartedAt: f.sale.offlineStartedAt, snapshotId: f.snapshot.snapshotId,
    snapshotVersion: 1, lastJournalSequence: 1, lastJournalHash: 'a'.repeat(64) };
  const evidence = { restartKind: 'os_reboot', timeContinuityProof: 'same_boot_monotonic', stateBeforeRestart: 'offline',
    original: boundary, restored: boundary, journalIntact: true, stockUsageRestored: true, staffStateRestored: true,
    shiftStateRestored: true, trustedClockRestored: true, timeRollbackDetected: false, trustedNow: f.sale.occurredAt };
  assert.equal(c.offlineRestartDecision(evidence).reason, 'CLOCK_UNTRUSTED');
  assert.equal(c.offlineRestartDecision({ ...evidence, timeContinuityProof: 'verified_cross_boot' }).action, 'restore_same_offline_session');
  assert.equal(c.offlineRestartDecision({ ...evidence, timeContinuityProof: 'unproven' }).action, 'require_online_recovery');
});
