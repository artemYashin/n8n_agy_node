const test = require('node:test');
const assert = require('node:assert/strict');
const { resolve } = require('node:path');
const { existsSync, chmodSync } = require('node:fs');
const { AgyChatModel } = require('../dist/nodes/AgyChatModel/AgyChatModel.js');
const { runAgy } = require('../dist/nodes/AgyChatModel/cli.js');
const { HumanMessage, SystemMessage, ToolMessage } = require('@langchain/core/messages');
const executable = resolve(__dirname, 'fake-agy.cjs');
test('CLI forwards text deltas before its final result', async () => {
  let completed = false;
  const deltas = [];
  const result = await runAgy({ executable, model: 'live-stream', onText(delta) {
    assert.equal(completed, false);
    deltas.push(delta);
  } }, '{}', '');
  completed = true;
  assert.deepEqual(deltas, ['Hello 🌍']);
  assert.equal(result.response, 'Hello 🌍');
});
chmodSync(executable, 0o755);
const tools = [{ type: 'function', function: { name: 'lookup_order', description: 'Look up order', parameters: {
  type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'],
} } }];

test('preserves system roles, Unicode and literal shell syntax; cleans up temp workspace', async () => {
  const model = new AgyChatModel({ executable });
  const prompt = 'Привет 🌍 $(touch /tmp/never-run-agy) `echo hi`\n--model=other';
  const output = await model.invoke([new SystemMessage('Be precise.'), new HumanMessage(prompt)]);
  const data = JSON.parse(output.content);
  assert.equal(data.prompt.messages[0].content, prompt);
  assert.match(data.system, /Be precise\./);
  assert.ok(!data.args.some((arg) => arg.includes(prompt)));
  assert.ok(!data.args.includes('--dangerously-skip-permissions'));
  assert.equal(existsSync(data.cwd), false);
  assert.deepEqual(output.usage_metadata, { input_tokens: 10, output_tokens: 5, total_tokens: 15 });
});

test('tool binding returns valid calls, preserves call IDs and handles tool results', async () => {
  const model = new AgyChatModel({ executable });
  const bound = model.bindTools(tools);
  const history = [new HumanMessage('Find ABC123')];
  const first = await bound.invoke(history);
  assert.equal(first.tool_calls[0].name, 'lookup_order');
  assert.deepEqual(first.tool_calls[0].args, { order_id: 'ABC123' });
  const tool = new ToolMessage({ content: 'Delivered', tool_call_id: first.tool_calls[0].id });
  const final = await bound.invoke([...history, first, tool]);
  assert.equal(final.content, 'Delivered');
  assert.equal(final.tool_calls.length, 0);
  const transcript = JSON.parse((await model.invoke([...history, first, tool])).content).prompt.messages;
  assert.equal(transcript[1].tool_calls[0].id, transcript[2].tool_call_id);
});

test('rejects unknown tool names', async () => {
  await assert.rejects(new AgyChatModel({ executable, model: 'unknown-tool' }).bindTools(tools).invoke('Hi'), /unknown tool/);
});

test('rejects malformed tool envelopes and non-object arguments', async () => {
  await assert.rejects(new AgyChatModel({ executable, model: 'malformed-tools' }).bindTools(tools).invoke('Hi'), /malformed/);
  await assert.rejects(new AgyChatModel({ executable, model: 'invalid-args' }).bindTools(tools).invoke('Hi'), /invalid tool arguments/);
});

test('stream fallback returns final text and stop sequences truncate it', async () => {
  const model = new AgyChatModel({ executable });
  const chunks = [];
  for await (const chunk of await model.stream('Hello')) chunks.push(chunk);
  assert.equal(JSON.parse(chunks.map((chunk) => chunk.content).join('')).prompt.messages[0].content, 'Hello');
  const stopped = await model.invoke('Hello', { stop: ['Hello'] });
  assert.equal(stopped.content.includes('Hello'), false);
});

test('rejects unsupported multimodal messages', async () => {
  await assert.rejects(new AgyChatModel({ executable }).invoke([new HumanMessage({ content: [
    { type: 'image_url', image_url: 'https://example.com/image.png' },
  ] })]), /text messages only/);
});

test('reports missing binary, CLI failures, malformed output, and output overflow', async () => {
  const prompt = JSON.stringify({ messages: [] });
  await assert.rejects(runAgy({ executable: '/nonexistent/agy' }, prompt, ''), /Cannot start agy/);
  await assert.rejects(runAgy({ executable, model: 'error' }, prompt, ''), /Authentication required/);
  await assert.rejects(runAgy({ executable, model: 'bad-json' }, prompt, ''), /invalid.*JSON/);
  await assert.rejects(runAgy({ executable, model: 'overflow', maxOutputBytes: 100 }, prompt, ''), /size limit/);
});

test('timeout and abort terminate hanging requests', async () => {
  const prompt = JSON.stringify({ messages: [] });
  await assert.rejects(runAgy({ executable, model: 'hang', timeoutMs: 100 }, prompt, ''), /timed out/);
  const controller = new AbortController();
  const promise = runAgy({ executable, model: 'hang' }, prompt, '', controller.signal);
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(promise, /aborted/);
});

test('concurrent requests have independent workspaces and system prompts', async () => {
  const model = new AgyChatModel({ executable });
  const results = await Promise.all(['first', 'second'].map((id) => model.invoke([new SystemMessage(id), new HumanMessage(id)])));
  const [first, second] = results.map((result) => JSON.parse(result.content));
  assert.notEqual(first.cwd, second.cwd);
  assert.equal(first.prompt.messages[0].content, 'first');
  assert.equal(second.prompt.messages[0].content, 'second');
});

test('verification failures from CLI stderr and result become safe typed errors', async () => {
  for (const model of ['verification-stderr', 'verification-result']) {
    await assert.rejects(runAgy({ executable, model }, '{}', ''), error => {
      assert.equal(error.code, 'account_verification_required');
      assert.equal(error.verification_url, 'https://accounts.google.com/verify?challenge=test');
      assert.ok(!error.message.includes('SECRET'));
      return true;
    });
  }
});
