const http = require('node:http');
const { createHash, timingSafeEqual, randomBytes, randomUUID } = require('node:crypto');
const { mkdir, readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { homedir } = require('node:os');
const bridge = require('./bridge.ts');
const { ApiError, validate, generate } = require('./completions.cjs');

class Queue {
  constructor(limit, capacity) { this.limit = limit; this.capacity = capacity; this.active = 0; this.waiting = []; }
  async acquire(signal) {
    signal.throwIfAborted();
    if (this.active < this.limit) { this.active++; return; }
    if (this.waiting.length >= this.capacity) throw new ApiError(429, 'Request queue is full. Retry later.', null, 'rate_limit_exceeded');
    await new Promise((resolve, reject) => {
      const entry = { resolve: () => { signal.removeEventListener('abort', abort); resolve(); } };
      const abort = () => { this.waiting = this.waiting.filter(x => x !== entry); reject(signal.reason); };
      this.waiting.push(entry); signal.addEventListener('abort', abort, { once: true });
    });
  }
  release() { const next = this.waiting.shift(); if (next) next.resolve(); else this.active--; }
}

function readJson(req, max = 1024 * 1024) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new ApiError(415, 'Content-Type must be application/json.');
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [], failed = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > max) { failed = true; chunks = []; reject(new ApiError(413, 'Request body exceeds the size limit.')); }
      else if (!failed) chunks.push(chunk);
    });
    req.on('end', () => { if (!failed) { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new ApiError(400, 'Invalid JSON body.')); } } });
    req.on('error', reject);
    req.on('aborted', () => reject(new ApiError(400, 'Request body interrupted.')));
  });
}
const hash = value => createHash('sha256').update(value).digest();
const json = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
function errorEnvelope(error) {
  return { error: { message: error.message, type: error.status < 500 ? 'invalid_request_error' : 'server_error', param: error.param || null, code: error.code || 'server_error', ...(error.verification_url ? { verification_url: error.verification_url } : {}) } };
}

function createApp(config = {}) {
  const backend = config.backend || bridge;
  const key = config.apiKey;
  if (typeof key !== 'string' || key.length < 16) throw new Error('AGY_API_KEY must contain at least 16 characters.');
  const options = { executable: config.executable || 'auto', defaultModel: config.defaultModel || '', timeoutMs: config.timeoutMs || 180000 };
  const queue = new Queue(config.concurrency || 2, config.maxQueue ?? 16);
  const controllers = new Set();
  let verification;
  const verificationStatus = () => verification && verification.expires > Date.now() ? verification.error : null;
  const publicDir = config.publicDir || process.env.AGY_PUBLIC_DIR || path.join(__dirname, '../public');
  const server = http.createServer(async (req, res) => {
    const requestId = `req_${randomUUID()}`;
    res.setHeader('x-request-id', requestId);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    let controller, timer, acquired = false;
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && pathname === '/healthz') return json(res, 200, { status: 'ok' });
      const assets = { '/': ['index.html','text/html'], '/app.js': ['app.js','text/javascript'], '/style.css': ['style.css','text/css'] };
      if (req.method === 'GET' && assets[pathname]) {
        const [file, type] = assets[pathname];
        const content = await readFile(path.join(publicDir, file));
        res.writeHead(200, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store' }); return res.end(content);
      }
      if (typeof req.headers.authorization !== 'string' || !timingSafeEqual(hash(req.headers.authorization), hash(`Bearer ${key}`))) throw new ApiError(401, 'Invalid or missing API key.', null, 'invalid_api_key');
      if (pathname === '/v1/responses' || pathname.startsWith('/v1/responses/')) throw new ApiError(400, 'Responses API is not supported. In n8n OpenAI Chat Model, turn off Use Responses API. Use /v1/chat/completions instead.', null, 'unsupported_endpoint');
      if (req.method === 'GET' && pathname === '/v1/models') {
        const models = await backend.listModels(options.executable);
        return json(res, 200, { object: 'list', data: [{ id: 'agy-default', name: 'Agy default', object: 'model', created: 0, owned_by: 'agy' }, ...models.map(m => ({ id: m.value, name: m.name, object: 'model', created: 0, owned_by: 'agy' }))] });
      }
      if (req.method === 'GET' && pathname === '/admin/status') {
        try { const models = await backend.listModels(options.executable); return json(res, 200, { authenticated: true, verification: verificationStatus(), models, active: queue.active, queued: queue.waiting.length }); }
        catch { return json(res, 200, { authenticated: false, verification: verificationStatus(), message: 'Sign in with Google, or check the CLI/network connection.', active: queue.active, queued: queue.waiting.length }); }
      }
      if (req.method === 'POST' && pathname.startsWith('/admin/')) {
        const body = await readJson(req, 16384);
        if (pathname === '/admin/login/start') return json(res, 200, await backend.startLogin('http-admin', options.executable));
        if (pathname === '/admin/login/complete') {
          if (typeof body.code !== 'string') throw new ApiError(400, 'code must be a string.', 'code');
          await backend.completeLogin('http-admin', options.executable, body.code);
          return json(res, 200, { authenticated: true });
        }
        if (pathname === '/admin/login/cancel') return json(res, 200, { cancelled: backend.cancelLogin('http-admin') });
      }
      if (req.method !== 'POST' || pathname !== '/v1/chat/completions') throw new ApiError(404, 'Unknown endpoint.', null, 'not_found');
      const input = validate(await readJson(req));
      controller = new AbortController(); controllers.add(controller);
      timer = setTimeout(() => controller.abort(new ApiError(504, 'Request timed out.', null, 'timeout')), options.timeoutMs);
      res.on('close', () => { if (!res.writableEnded) controller.abort(new ApiError(499, 'Client disconnected.')); });
      await queue.acquire(controller.signal); acquired = true;
      controller.signal.throwIfAborted();
      const id = `chatcmpl-${randomUUID().replaceAll('-','')}`, created = Math.floor(Date.now()/1000), model = input.body.model;
      let heartbeat;
      const event = data => { if (!res.destroyed) res.write(`data: ${JSON.stringify(data)}\n\n`); };
      const chunk = (delta, finish_reason = null) => event({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason, logprobs: null }] });
      if (input.body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'connection': 'keep-alive', 'x-accel-buffering': 'no' });
        res.flushHeaders(); chunk({ role: 'assistant', content: '' });
        heartbeat = setInterval(() => { if (!res.destroyed) res.write(': keep-alive\n\n'); }, 15000);
      }
      try {
        const result = await generate(input, backend, options, controller.signal, input.body.stream ? delta => chunk({ content: delta }) : undefined);
        verification = undefined;
        if (input.body.stream) {
          if (!result.live && result.message.content) chunk({ content: result.message.content });
          if (result.message.tool_calls) chunk({ tool_calls: result.message.tool_calls.map((call, index) => ({ index, ...call })) });
          chunk({}, result.finish_reason);
          if (input.body.stream_options?.include_usage) event({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: result.usage });
          res.end('data: [DONE]\n\n');
        } else json(res, 200, { id, object: 'chat.completion', created, model, choices: [{ index: 0, message: result.message, finish_reason: result.finish_reason, logprobs: null }], usage: result.usage });
      } finally { clearInterval(heartbeat); }
    } catch (caught) {
      let error = controller?.signal.aborted ? controller.signal.reason : caught;
      if (!(error instanceof ApiError)) {
        const detected = bridge.verificationError(error?.message || '');
        const source = error?.code === 'account_verification_required' ? error : detected;
        if (source) {
          // Revalidate the URL even when supplied by an alternate backend.
          const safe = bridge.verificationError('VALIDATION_REQUIRED ' + (source.verification_url || ''));
          error = new ApiError(403, 'Google account verification is required. Open the verification link in the setup page, complete verification, then retry. If no link is available, run Agy directly to obtain it.', null, 'account_verification_required');
          if (safe?.verification_url) error.verification_url = safe.verification_url;
          verification = { error: errorEnvelope(error).error, expires: Date.now() + 10 * 60_000 };
        }
      }
      if (!(error instanceof ApiError)) {
        // CLI diagnostics can contain auth links or prompt data. Never expose them.
        console.error(`[${requestId}] Agy operation failed`);
        error = new ApiError(502, 'Agy request failed. Check account sign-in, model ID, CLI installation, and network access.', null, 'upstream_error');
      }
      if (!res.destroyed && !res.writableEnded) {
        if (res.headersSent) res.end(`data: ${JSON.stringify(errorEnvelope(error))}\n\ndata: [DONE]\n\n`);
        else { if (error.status === 429) res.setHeader('retry-after', '5'); json(res, error.status, errorEnvelope(error)); }
      }
    } finally {
      if (timer) clearTimeout(timer);
      if (controller) controllers.delete(controller);
      if (acquired) queue.release();
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.on('close', () => backend.cancelLogin('http-admin'));
  server.stop = () => {
    backend.cancelLogin('http-admin');
    for (const controller of controllers) controller.abort(new ApiError(503, 'Server shutting down.', null, 'unavailable'));
    server.close(); server.closeIdleConnections();
  };
  return server;
}

async function loadKey(directory, configured) {
  if (configured) return configured;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'api-key');
  try { return (await readFile(file, 'utf8')).trim(); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const key = `agy-${randomBytes(32).toString('hex')}`;
  try { await writeFile(file, key + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (e) { if (e.code === 'EEXIST') return (await readFile(file, 'utf8')).trim(); throw e; }
  console.log(`Generated API key (save it): ${key}`);
  return key;
}
function positive(value, fallback, min = 1) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value); if (!Number.isInteger(n) || n < min) throw new Error('Invalid numeric server configuration'); return n;
}
async function main() {
  const apiKey = await loadKey(process.env.AGY_DATA_DIR || path.join(homedir(), '.agy-api'), process.env.AGY_API_KEY);
  const server = createApp({ apiKey, executable: process.env.AGY_EXECUTABLE || 'auto', defaultModel: process.env.AGY_DEFAULT_MODEL,
    concurrency: positive(process.env.AGY_MAX_CONCURRENCY, 2), maxQueue: positive(process.env.AGY_MAX_QUEUE, 16, 0), timeoutMs: positive(process.env.AGY_REQUEST_TIMEOUT_MS, 180000) });
  const port = positive(process.env.PORT, 8080);
  server.listen(port, '0.0.0.0', () => console.log(`Agy API listening on :${port}. Setup: http://localhost:${port}/ | API base: /v1`));
  for (const signal of ['SIGTERM','SIGINT']) process.once(signal, () => server.stop());
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { createApp, loadKey, Queue, validate, generate, prepareRuntime: bridge.resolveExecutable };
