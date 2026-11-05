const assert = require('node:assert/strict');
const { AgyChatModel } = require('../dist/nodes/AgyChatModel/AgyChatModel.js');
const { SystemMessage, HumanMessage, ToolMessage } = require('@langchain/core/messages');

async function main() {
  const model = new AgyChatModel({ executable: process.env.AGY_EXECUTABLE || 'agy', model: process.env.AGY_MODEL, timeoutMs: 120000 });
  const plain = await model.invoke([
    new SystemMessage('Always respond with exactly CUSTOM_SYSTEM_OK.'), new HumanMessage('Hello'),
  ]);
  assert.equal(plain.content.trim(), 'CUSTOM_SYSTEM_OK');
  console.log('PASS: custom system prompt, live CLI, usage:', plain.usage_metadata);

  const bound = model.bindTools([{
    type: 'function', function: {
      name: 'lookup_order', description: 'Look up the real shipping status of an order. You must call this to know its status.',
      parameters: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] },
    },
  }]);
  const history = [new HumanMessage('Look up order ABC123 using lookup_order. Do not guess its status.')];
  const request = await bound.invoke(history);
  assert.equal(request.tool_calls.length, 1);
  assert.equal(request.tool_calls[0].name, 'lookup_order');
  assert.equal(request.tool_calls[0].args.order_id, 'ABC123');
  console.log('PASS: workflow tool request:', request.tool_calls[0]);
  const final = await bound.invoke([...history, request, new ToolMessage({
    tool_call_id: request.tool_calls[0].id,
    content: '{"order_id":"ABC123","status":"DELIVERED","proof_code":"PINEAPPLE-729"}',
  })]);
  assert.equal(final.tool_calls?.length || 0, 0);
  assert.match(final.content, /deliver/i);
  console.log('PASS: tool result to final answer:', final.content);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
