// Observe the incoming stream without changing the endpoint's body reader.
function logRequest(req, res, requestId, write = console.log) {
  const limit = 1024 * 1024;
  const pathname = new URL(req.url, 'http://localhost').pathname;
  let chunks = [], bytes = 0, logged = false;
  const finish = interrupted => {
    if (logged) return;
    logged = true;
    let body = null;
    if (interrupted) body = '[omitted: interrupted body]';
    else if (bytes > limit) body = '[omitted: body exceeds 1 MiB]';
    else if (bytes) {
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'), (key, value) => {
          const normalized = key.replace(/[-_]/g, '').toLowerCase();
          return ['authorization', 'apikey', 'password', 'secret', 'clientsecret', 'token', 'accesstoken', 'refreshtoken', 'idtoken', 'cookie'].includes(normalized)
            || (pathname.startsWith('/admin/') && normalized === 'code') ? '[REDACTED]' : value;
        });
      } catch { body = '[omitted: invalid JSON or non-JSON body]'; }
    }
    chunks = [];
    write(JSON.stringify({ event: 'http_request', timestamp: new Date().toISOString(), request_id: requestId, method: req.method, path: pathname, body_bytes: bytes, body }));
  };
  req.on('data', chunk => {
    bytes += chunk.length;
    if (bytes <= limit) chunks.push(chunk);
    else chunks = [];
  });
  req.once('end', () => finish(false));
  req.once('aborted', () => finish(true));
  req.once('error', () => finish(true));
  // Drain bodies on rejected/unknown routes as well as handled routes.
  res.once('finish', () => { if (!req.readableEnded) req.resume(); });
}

module.exports = { logRequest };
