const test = require('node:test');
const assert = require('node:assert/strict');
const { resolve } = require('node:path');
const { chmodSync } = require('node:fs');
const { startLogin, completeLogin, cancelLogin, checkConnection, parseLoginUrl } = require('../dist/nodes/AgyAccount/auth.js');
const executable = resolve(__dirname, 'fake-agy-auth.cjs');
chmodSync(executable, 0o755);

test('sign-in parses split URL, enforces owner, submits code and discards CLI output', async () => {
  try {
    const login = await startLogin('owner-1', executable);
    assert.equal(new URL(login.authorizationUrl).hostname, 'accounts.google.com');
    assert.equal(login.expiresInSeconds, 600);
    await assert.rejects(startLogin('owner-2', executable), /Another credential/);
    assert.equal(cancelLogin('owner-2'), false);
    await assert.rejects(completeLogin('owner-2', executable, 'valid-code'), /No matching/);
    await assert.rejects(completeLogin('owner-1', '/other/executable', 'valid-code'), /No matching/);
    await assert.rejects(completeLogin('owner-1', executable, 'a\nb'), /single authorization/);
    assert.equal(await completeLogin('owner-1', executable, 'valid-code'), undefined);
    await assert.rejects(completeLogin('owner-1', executable, 'valid-code'), /No matching/);
  } finally { cancelLogin('owner-1'); }
});

test('failed sign-in does not leak the code or CLI output', async () => {
  await startLogin('failure', executable);
  await assert.rejects(completeLogin('failure', executable, 'sensitive-invalid-code'), (error) => {
    assert.match(error.message, /could not complete/);
    assert.doesNotMatch(error.message, /sensitive|private-token/);
    return true;
  });
});

test('cancel and expiry clear pending login; a fresh login can start', async () => {
  await startLogin('cancel', executable);
  assert.equal(cancelLogin('cancel'), true);
  await assert.rejects(completeLogin('cancel', executable, 'valid-code'), /No matching/);
  await startLogin('expire', executable, 150);
  await new Promise((resolve) => setTimeout(resolve, 200));
  await assert.rejects(completeLogin('expire', executable, 'valid-code'), /No matching/);
  await startLogin('fresh', executable);
  cancelLogin('fresh');
});

test('missing binary fails without leaving a login lock', async () => {
  await assert.rejects(startLogin('missing', '/nonexistent/agy'), /Cannot start/);
  await startLogin('recovery', executable);
  cancelLogin('recovery');
});

test('only Google authorization links with PKCE and state are accepted', () => {
  assert.equal(parseLoginUrl('https://evil.example/?code_challenge=123'), undefined);
  assert.equal(parseLoginUrl('https://accounts.google.com/o/oauth2/auth?response_type=code'), undefined);
  assert.equal(parseLoginUrl('https://accounts.google.com.evil.example/o/oauth2/auth?response_type=code&code_challenge_method=S256&code_challenge=x&state=y'), undefined);
});

test('connection check returns models without credential material', async () => {
  assert.deepEqual(await checkConnection(executable), { connected: true, models: ['test-model'] });
  await assert.rejects(checkConnection('/nonexistent/agy'), /Cannot list Agy models/);
});
