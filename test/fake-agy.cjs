#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const event = JSON.parse(input);
  const prompt = event.message.content;
  const model = process.argv.find((arg) => arg.startsWith('--model='))?.slice(8);
  if (model === 'verification-stderr') {
    console.error('SECRET diagnostic: To continue, verify your account at https://accounts.google.com/verify?challenge=test');
    process.exitCode = 1; return;
  }
  if (model === 'verification-result') {
    console.log(JSON.stringify({ event: 'result', result: { status: 'ERROR', error: { reason: 'VALIDATION_REQUIRED', metadata: { verification_url: 'https://accounts.google.com/verify?challenge=test' } } } }));
    return;
  }
  if (model === 'live-stream') {
    console.log(JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'Hello 🌍' } }));
    setTimeout(() => console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'Hello 🌍' } })), 100);
    return;
  }
  if (model === 'hang') { setInterval(() => {}, 1000); return; }
  if (model === 'bad-json') { console.log('invalid json'); return; }
  if (model === 'overflow') { console.log('x'.repeat(10000)); return; }
  if (model === 'error') { console.error('Authentication required'); process.exitCode = 1; return; }
  const system = fs.readFileSync(path.join(process.cwd(), '.agents/agents/n8n-provider.md'), 'utf8');
  const schema = system.includes('Available workflow tools:');
  const transcript = JSON.parse(prompt);
  let structured;
  if (schema) {
    structured = transcript.messages.some((message) => message.role === 'tool')
      ? { content: 'Delivered', tool_calls: [] }
      : { content: '', tool_calls: [{ name: model === 'unknown-tool' ? 'unexpected' : 'lookup_order', arguments: { order_id: 'ABC123' } }] };
  }
  if (model === 'malformed-tools') structured = { content: '', tool_calls: 'invalid' };
  if (model === 'invalid-args') structured = { content: '', tool_calls: [{ name: 'lookup_order', arguments: [] }] };
  console.log(JSON.stringify({ event: 'init', init: { cwd: process.cwd() } }));
  console.log(JSON.stringify({ event: 'result', result: {
    status: 'SUCCESS', response: schema ? JSON.stringify(structured) : JSON.stringify({ prompt: transcript, system, cwd: process.cwd(), args: process.argv.slice(2) }),
    conversation_id: 'test-conversation',
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  } }));
});
