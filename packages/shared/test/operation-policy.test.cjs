const test = require('node:test');
const assert = require('node:assert/strict');
const { onlineOperationAccessError: access, approvalUseError: use } = require('../dist/operation-policy.js');

const remote = { online: true, authenticated: true, branchAccessVerified: true,
  permissionGranted: true, terminalEnrolled: false, enrollmentBranchMatches: false,
  localAttendanceVerified: false, clinicalEvidenceVerified: false, bankPaymentEvidenceVerified: false };
const local = { ...remote, terminalEnrolled: true, enrollmentBranchMatches: true, localAttendanceVerified: true };
function fixture() {
  const document = { tenantId: 'tenant1', branchId: 'branch1', documentType: 'transfer',
    documentId: 'transfer1', documentVersion: 1, documentDigest: 'a'.repeat(64), requestedByUserId: 'staff1' };
  return { approval: { approvalId: 'approval1', document, authorizedAction: 'dispatch', approvedByUserId: 'manager1',
    approvedAt: 100, expiresAt: null, status: 'approved', policyVersion: 1, reason: 'Reviewed' },
    context: { currentDocument: { ...document }, authorizedAction: 'dispatch', trustedNow: 200,
      approverStillAuthorized: true, mayApproveOwnRequests: false } };
}

test('remote management and normal business reservations need no terminal', () => {
  assert.equal(access(['management_record', 'business_reservation'], remote), null);
});
test('bank payment recording requires evidence; branch cash still requires local execution', () => {
  assert.equal(access(['bank_payment_record'], remote), 'PAYMENT_EVIDENCE_REQUIRED');
  assert.equal(access(['bank_payment_record'], { ...remote, bankPaymentEvidenceVerified: true }), null);
  assert.equal(access(['branch_cash'], remote), 'TERMINAL_REQUIRED');
});
for (const effect of ['physical_stock', 'branch_cash', 'customer_refund_execution', 'clinical_dispensing', 'terminal_designation']) {
  test(`${effect} requires enrolled local execution even with full permissions`, () => {
    assert.equal(access([effect], remote), 'TERMINAL_REQUIRED');
    assert.equal(access([effect], { ...local, enrollmentBranchMatches: false }), 'IDENTITY_MISMATCH');
    assert.equal(access([effect], { ...local, localAttendanceVerified: false }), 'REMOTE_SESSION_DENIED');
    assert.equal(access([effect], { ...local, clinicalEvidenceVerified: true }), null);
  });
}
test('clinical evidence is independent of management permission', () => {
  assert.equal(access(['clinical_dispensing'], local), 'PHARMACIST_REQUIRED');
});
test('mixed approval/posting cannot inherit the management-only permission', () => {
  assert.equal(access(['management_record', 'business_reservation', 'physical_stock'], remote), 'TERMINAL_REQUIRED');
  assert.equal(access(['management_record', 'physical_stock'], local), null);
});
test('all online management still requires authentication, branch permission and connection', () => {
  for (const [flag, error] of [['online', 'ONLINE_REQUIRED'], ['authenticated', 'AUTHENTICATION_REQUIRED'],
    ['branchAccessVerified', 'IDENTITY_MISMATCH'], ['permissionGranted', 'PERMISSION_DENIED']]) {
    assert.equal(access(['management_record'], { ...remote, [flag]: false }), error);
  }
  assert.equal(access([], remote), 'INVALID_COMMAND');
  assert.equal(access(['caller_invented_effect'], remote), 'INVALID_COMMAND');
});
test('exact document approval remains usable without a newly invented mandatory TTL', () => {
  const f = fixture();
  assert.equal(use(f.approval, f.context), null);
  assert.equal(use(f.approval, { ...f.context, trustedNow: 99999999 }), null);
  assert.equal(use(null, f.context), 'APPROVAL_REQUIRED');
});
test('changed quantities/prices or document revision require fresh approval', () => {
  const f = fixture();
  for (const changed of [{ documentVersion: 2 }, { documentDigest: 'b'.repeat(64) }]) {
    assert.equal(use(f.approval, { ...f.context, currentDocument: { ...f.context.currentDocument, ...changed } }), 'APPROVAL_STALE');
  }
});
test('approval cannot cross tenant, branch, document, requester or action', () => {
  const f = fixture();
  for (const key of ['tenantId', 'branchId', 'documentId', 'documentType', 'requestedByUserId']) {
    assert.equal(use(f.approval, { ...f.context, currentDocument: { ...f.context.currentDocument, [key]: 'other' } }), 'APPROVAL_INVALID');
  }
  assert.equal(use(f.approval, { ...f.context, authorizedAction: 'refund' }), 'APPROVAL_INVALID');
});
test('revoked or no-longer-authorized approval cannot execute', () => {
  const f = fixture();
  assert.equal(use({ ...f.approval, status: 'revoked' }, f.context), 'APPROVAL_INVALID');
  assert.equal(use(f.approval, { ...f.context, approverStillAuthorized: false }), 'APPROVAL_INVALID');
});
test('existing self-approval rules apply without imposing two different approver/executor people', () => {
  const f = fixture();
  const own = { ...f.approval, approvedByUserId: 'staff1' };
  assert.equal(use(own, f.context), 'SELF_APPROVAL_DENIED');
  assert.equal(use(own, { ...f.context, mayApproveOwnRequests: true }), null);
  // Executor identity is audited separately; merely executing one's approval is not self-request approval.
  assert.equal(use(f.approval, f.context), null);
});
test('workflow-specific expiry and malformed evidence fail at the correct boundaries', () => {
  const f = fixture();
  assert.equal(use({ ...f.approval, expiresAt: 200 }, f.context), 'APPROVAL_EXPIRED');
  assert.equal(use({ ...f.approval, expiresAt: 201 }, f.context), null);
  assert.equal(use({ ...f.approval, expiresAt: 99 }, f.context), 'APPROVAL_INVALID');
  assert.equal(use({ ...f.approval, document: { ...f.approval.document, documentDigest: 'bad' } }, f.context), 'APPROVAL_INVALID');
});
