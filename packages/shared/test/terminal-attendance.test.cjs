const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../dist/terminal-contracts.js');
const a = require('../dist/terminal-attendance.js');

test('attendance signatures use their own purpose prefix', () => {
  const payload = { kind: 'local_attendance', proofId: 'p' };
  const text = c.terminalSigningText('attendance', payload);
  assert.equal(text, 'PharmaCeylon:terminal:v1:attendance\n{"kind":"local_attendance","proofId":"p"}');
  assert.notEqual(text, c.terminalSigningText('command', payload));
});

test('only the positively identified physical console session counts as local', () => {
  assert.equal(a.isLocalConsoleSession({ sessionId: 1, protocol: 'console', remoteSession: false }), true);
  for (const session of [
    { sessionId: 2, protocol: 'rdp', remoteSession: true },
    { sessionId: 2, protocol: 'rdp', remoteSession: false },
    { sessionId: 1, protocol: 'console', remoteSession: true },
    { sessionId: 1, protocol: 'unknown', remoteSession: false },
  ]) assert.equal(a.isLocalConsoleSession(session), false);
});
