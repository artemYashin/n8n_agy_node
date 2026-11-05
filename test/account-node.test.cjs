const test = require('node:test');
const assert = require('node:assert/strict');
const { resolve } = require('node:path');
const { chmodSync } = require('node:fs');
const { AgyAccount } = require('../dist/nodes/AgyAccount/AgyAccount.node.js');
const { AgyChatModel } = require('../dist/nodes/AgyChatModel/AgyChatModel.node.js');
const executable = resolve(__dirname, 'fake-agy-auth.cjs');
chmodSync(executable, 0o755);

const context = (operation, authorizationCode = '') => ({
  getMode: () => 'manual',
  getNode: () => ({ credentials: { agyCliAccount: { id: 'node-test-account' } } }),
  getCredentials: async () => ({ executable, authorizationCode }),
  getNodeParameter: () => operation,
});

test('account node completes UI operation sequence without outputting secrets', async () => {
  const node = new AgyAccount();
  const start = await node.execute.call(context('startLogin'));
  assert.equal(start[0][0].json.status, 'awaitingSignIn');
  const done = await node.execute.call(context('completeLogin', 'valid-code'));
  assert.equal(done[0][0].json.status, 'signedIn');
  assert.doesNotMatch(JSON.stringify(done), /valid-code|private-token/);
  const checked = await node.execute.call(context('checkConnection'));
  assert.equal(checked[0][0].json.connected, true);
});

test('setup cannot run from scheduled or production workflows', async () => {
  await assert.rejects(new AgyAccount().execute.call({ getMode: () => 'trigger' }), /manual setup/);
});

test('chat model uses credential executable without copying its authorization code', async () => {
  const supplied = await new AgyChatModel().supplyData.call({
    getNodeParameter: (name, _index, fallback) => name === 'authentication' ? 'account' : fallback,
    getCredentials: async () => ({ executable, authorizationCode: 'MUST-NOT-REACH-MODEL' }),
  }, 0);
  assert.equal(supplied.response.cliOptions.executable, executable);
  assert.doesNotMatch(JSON.stringify(supplied.response.cliOptions), /MUST-NOT/);
});

test('model picker loads account models and filters by display name or ID', async () => {
  const search = new AgyChatModel().methods.listSearch.searchModels;
  const ctx = {
    getNodeParameter: (name, fallback) => name === 'authentication' ? 'account' : fallback,
    getCredentials: async () => ({ executable }),
  };
  assert.deepEqual((await search.call(ctx, 'Test Model')).results, [{ name: 'Test Model', value: 'test-model' }]);
  assert.equal((await search.call(ctx, 'test-model')).results.length, 1);
  assert.deepEqual((await search.call(ctx, 'nonexistent')).results, []);
});

test('model selection accepts list, manual ID, and legacy string values', async () => {
  for (const selection of ['legacy-model', { mode: 'list', value: 'list-model' }, { mode: 'id', value: 'manual-model' }]) {
    const supplied = await new AgyChatModel().supplyData.call({
      getNodeParameter: (name, _index, fallback) => name === 'model' ? selection : fallback,
    }, 0);
    assert.equal(supplied.response.cliOptions.model, typeof selection === 'string' ? selection : selection.value);
  }
});
