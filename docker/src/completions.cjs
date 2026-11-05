const { randomUUID } = require('node:crypto');
const { contentStream } = require('./content-stream.cjs');
const Ajv = require('ajv');
const ajv = new Ajv({ strict: false, allErrors: false, addUsedSchema: false });
const Ajv2020 = require('ajv/dist/2020');
const ajv2020 = new Ajv2020({ strict: false, allErrors: false, addUsedSchema: false });

class ApiError extends Error {
  constructor(status, message, param = null, code = 'invalid_request') {
    super(message); Object.assign(this, { status, param, code });
  }
}
const invalid = (message, param) => { throw new ApiError(400, message, param); };
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
function text(content, nullable = false) {
  if (content == null && nullable) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content) && content.every(p => object(p) && p.type === 'text' && typeof p.text === 'string')) return content.map(p => p.text).join('\n');
  invalid('Only text message content is supported.', 'messages');
}
function validate(body) {
  if (!object(body)) invalid('Expected a JSON object.');
  if (typeof body.model !== 'string' || !body.model.trim() || body.model.length > 200) invalid('model must be a non-empty model ID.', 'model');
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 1000) invalid('messages must contain 1–1000 messages.', 'messages');
  if (body.n !== undefined && body.n !== 1) invalid('Only n=1 is supported.', 'n');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') invalid('stream must be boolean.', 'stream');
  if (body.stream_options != null && (!object(body.stream_options) || (body.stream_options.include_usage !== undefined && typeof body.stream_options.include_usage !== 'boolean'))) invalid('Invalid stream_options.', 'stream_options');
  for (const key of ['temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'frequency_penalty', 'presence_penalty', 'logprobs', 'top_logprobs', 'seed', 'audio', 'modalities', 'functions', 'function_call', 'prediction', 'logit_bias']) {
    if (body[key] != null) invalid(`${key} is not supported by the Agy CLI adapter. Omit this parameter.`, key);
  }
  if (body.reasoning_effort != null && !['low','medium','high','xhigh','max'].includes(body.reasoning_effort)) invalid('Unsupported reasoning_effort.', 'reasoning_effort');
  const messages = body.messages.map(m => {
    if (!object(m) || !['system','developer','user','assistant','tool'].includes(m.role)) invalid('Invalid message role.', 'messages');
    const result = { role: m.role, content: text(m.content, m.role === 'assistant') };
    if (m.role === 'tool') {
      if (typeof m.tool_call_id !== 'string' || !m.tool_call_id) invalid('Tool messages require tool_call_id.', 'messages');
      result.tool_call_id = m.tool_call_id;
    }
    if (m.tool_calls != null) {
      if (m.role !== 'assistant' || !Array.isArray(m.tool_calls)) invalid('Invalid assistant tool_calls.', 'messages');
      result.tool_calls = m.tool_calls.map(call => {
        if (!object(call) || typeof call.id !== 'string' || call.type !== 'function' || !object(call.function) || typeof call.function.name !== 'string' || typeof call.function.arguments !== 'string') invalid('Invalid tool call in history.', 'messages');
        try { if (!object(JSON.parse(call.function.arguments))) throw Error(); } catch { invalid('Tool arguments must be a JSON object string.', 'messages'); }
        return { id: call.id, type: 'function', function: { name: call.function.name, arguments: call.function.arguments } };
      });
    }
    return result;
  });
  if (body.tools != null && (!Array.isArray(body.tools) || body.tools.length > 128)) invalid('tools must be an array with at most 128 tools.', 'tools');
  const validators = new Map();
  const tools = (body.tools || []).map(tool => {
    if (!object(tool) || tool.type !== 'function' || !object(tool.function) || !/^[a-zA-Z0-9_-]{1,64}$/.test(tool.function.name)) invalid('Only named function tools are supported.', 'tools');
    if (validators.has(tool.function.name)) invalid('Tool names must be unique.', 'tools');
    const schema = tool.function.parameters || { type: 'object', properties: {} };
    try {
      const compiler = schema?.$schema === 'https://json-schema.org/draft/2020-12/schema' ? ajv2020 : ajv;
      validators.set(tool.function.name, compiler.compile(schema));
    } catch { invalid('Invalid tool JSON schema.', 'tools'); }
    return tool;
  });
  const choice = body.tool_choice ?? (tools.length ? 'auto' : 'none');
  const named = object(choice) && choice.type === 'function' ? choice.function?.name : undefined;
  if (!['auto','none','required'].includes(choice) && !(typeof named === 'string' && validators.has(named))) invalid('Unsupported tool_choice.', 'tool_choice');
  if (!tools.length && (choice === 'required' || named)) invalid('tool_choice requires tools.', 'tool_choice');
  if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== 'boolean') invalid('parallel_tool_calls must be boolean.', 'parallel_tool_calls');
  const stop = body.stop == null ? [] : typeof body.stop === 'string' ? [body.stop] : body.stop;
  if (!Array.isArray(stop) || stop.length > 4 || !stop.every(s => typeof s === 'string' && s.length > 0 && s.length <= 1000)) invalid('stop must contain up to four non-empty strings.', 'stop');
  const format = body.response_format ?? { type: 'text' };
  if (!object(format) || !['text','json_object'].includes(format.type)) invalid('Supported response_format types: text, json_object.', 'response_format');
  return { body, messages, tools: choice === 'none' ? [] : tools, validators, choice, named, stop, json: format.type === 'json_object' };
}

// Keeps potential stop prefixes out of the SSE stream, including across CLI chunks.
function stopFilter(stops, emit) {
  let pending = '', stopped = false;
  const reserve = Math.max(0, ...stops.map(s => s.length - 1));
  return {
    write(delta) {
      if (stopped) return;
      pending += delta;
      const hits = stops.map(s => pending.indexOf(s)).filter(n => n >= 0);
      if (hits.length) { const value = pending.slice(0, Math.min(...hits)); if (value) emit(value); pending = ''; stopped = true; return; }
      if (pending.length > reserve) { const count = pending.length - reserve; emit(pending.slice(0, count)); pending = pending.slice(count); }
    },
    end() { if (!stopped && pending) emit(pending); pending = ''; },
  };
}

async function generate(input, backend, options, signal, onText) {
  const { body, messages, tools, validators, choice, named, stop, json } = input;
  const system = messages.filter(m => ['system','developer'].includes(m.role)).map(m => m.content).join('\n\n');
  const conversation = messages.filter(m => !['system','developer'].includes(m.role));
  // A single user message is passed unchanged. History is serialized because
  // the CLI accepts one user turn, not an OpenAI messages array.
  let prompt = conversation.length === 1 && conversation[0].role === 'user'
    ? conversation[0].content : JSON.stringify({ messages: conversation });
  // Optional API formats are transport instructions in the user input, never
  // additions to the caller's system prompt.
  if (tools.length) prompt = JSON.stringify({ messages: conversation, tools, tool_choice: choice,
    parallel_tool_calls: body.parallel_tool_calls ?? true,
    response_format: { content: 'string', tool_calls: [{ name: 'tool name', arguments: 'JSON object matching tool parameters' }] },
    format_instructions: 'Return exactly one JSON object with content and tool_calls. For a final answer use an empty tool_calls array. Request tools through this object; the client executes them. Follow tool_choice and parallel_tool_calls. No Markdown fences.',
  });
  else if (json) prompt = JSON.stringify({ messages: conversation, response_format: { type: 'json_object' } });
  let emitted = '', sawDelta = false;
  const live = Boolean(onText && (!json || tools.length));
  const filter = stopFilter(stop, delta => { emitted += delta; onText?.(delta); });
  let decoded = '';
  const contentDecoder = tools.length ? contentStream(delta => { decoded += delta; filter.write(delta); }) : null;
  const result = await backend.runAgy({ executable: options.executable, model: body.model === 'agy-default' ? options.defaultModel : body.model,
    effort: body.reasoning_effort, timeoutMs: options.timeoutMs, maxOutputBytes: 16 * 1024 * 1024,
    onText: live ? delta => { sawDelta = true; if (contentDecoder) contentDecoder.write(delta); else filter.write(delta); } : undefined,
  }, prompt, system, signal);
  let content = result.response;
  if (typeof content !== 'string') throw new ApiError(502, 'Agy returned an invalid response.', null, 'upstream_error');
  const tool_calls = [];
  if (tools.length) {
    let envelope;
    try { envelope = JSON.parse(content.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1')); } catch { throw new ApiError(502, 'Agy returned invalid tool-call JSON.', null, 'upstream_error'); }
    if (!object(envelope) || typeof envelope.content !== 'string' || !Array.isArray(envelope.tool_calls)) throw new ApiError(502, 'Agy returned a malformed tool response.', null, 'upstream_error');
    content = envelope.content;
    for (const call of envelope.tool_calls) {
      if (!object(call) || !validators.has(call.name) || !object(call.arguments) || !validators.get(call.name)(call.arguments) || (named && call.name !== named)) throw new ApiError(502, 'Agy returned an invalid tool or arguments.', null, 'upstream_error');
      tool_calls.push({ id: `call_${randomUUID().replaceAll('-','')}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } });
    }
    if (((choice === 'required' || named) && !tool_calls.length) || (body.parallel_tool_calls === false && tool_calls.length > 1)) throw new ApiError(502, 'Agy did not follow tool_choice.', null, 'upstream_error');
  }
  if (json && !tools.length) {
    try { if (!object(JSON.parse(content))) throw Error(); } catch { throw new ApiError(502, 'Agy returned invalid JSON.', null, 'upstream_error'); }
  }
  if (live) {
    if (contentDecoder) {
      contentDecoder.end();
      // The final parsed envelope is authoritative. Emit only the missing tail;
      // never duplicate text, and fail rather than silently send inconsistent text.
      if (!content.startsWith(decoded)) throw new ApiError(502, 'Agy streamed text that differs from its final response.', null, 'upstream_error');
      filter.write(content.slice(decoded.length));
    } else if (!sawDelta) filter.write(content);
    filter.end(); content = emitted;
  }
  else if (!tool_calls.length && stop.length) {
    const hits = stop.map(s => content.indexOf(s)).filter(n => n >= 0);
    if (hits.length) content = content.slice(0, Math.min(...hits));
  }
  const usage = result.usage || {};
  return { message: { role: 'assistant', content: content || (tool_calls.length ? null : ''), ...(tool_calls.length ? { tool_calls } : {}) },
    finish_reason: tool_calls.length ? 'tool_calls' : 'stop',
    usage: { prompt_tokens: usage.input_tokens || 0, completion_tokens: usage.output_tokens || 0, total_tokens: usage.total_tokens || 0 }, live };
}
module.exports = { ApiError, validate, generate, stopFilter };
