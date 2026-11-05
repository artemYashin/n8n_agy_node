const el = id => document.getElementById(id);
let request;
el('base-url').textContent = location.origin + '/v1';
async function api(route, body) {
  const key = el('key').value.trim();
  if (!key) throw new Error('Введите API-ключ сервера.');
  const response = await fetch(route, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || `HTTP ${response.status}`);
  return data;
}
function action(id, fn) {
  el(id).onclick = async () => { el('message').textContent = ''; el(id).disabled = true; try { await fn(); } catch (e) { el('message').textContent = e.message; } finally { el(id).disabled = false; } };
}
action('check', async () => {
  const status = await api('/admin/status');
  el('connection').textContent = status.authenticated ? 'Google подключён. Модели доступны.' : status.message;
  el('status').textContent = status.authenticated ? 'Аккаунт подключён' : 'Требуется вход';
});
action('start', async () => {
  const data = await api('/admin/login/start', {});
  const link = el('login-link'); link.href = data.authorizationUrl; link.hidden = false;
  el('message').textContent = `Откройте ссылку и завершите вход в течение ${Math.floor(data.expiresInSeconds / 60)} минут.`;
});
action('complete', async () => {
  const code = el('code').value.trim();
  try { await api('/admin/login/complete', { code }); el('login-link').hidden = true; el('connection').textContent = 'Вход выполнен. Обновите список моделей.'; }
  finally { el('code').value = ''; }
});
action('cancel', async () => { await api('/admin/login/cancel', {}); el('login-link').hidden = true; el('code').value = ''; });
action('models', async () => {
  const result = await api('/v1/models'); el('model').replaceChildren();
  for (const model of result.data) { const option = document.createElement('option'); option.value = model.id; option.textContent = model.name || model.id; el('model').append(option); }
});
action('send', async () => {
  if (!el('key').value.trim()) throw new Error('Введите API-ключ.');
  request = new AbortController(); el('answer').textContent = '';
  try {
    const response = await fetch('/v1/chat/completions', { method: 'POST', signal: request.signal,
      headers: { Authorization: `Bearer ${el('key').value.trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: el('model').value, stream: true, messages: [{ role: 'user', content: el('prompt').value }] }) });
    if (!response.ok) throw new Error((await response.json()).error.message);
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
          const data = JSON.parse(line.slice(6)); if (data.error) throw new Error(data.error.message);
          el('answer').textContent += data.choices?.[0]?.delta?.content || '';
        }
      }
    }
  } catch (e) { if (e.name !== 'AbortError') throw e; }
  finally { request = undefined; }
});
el('stop').onclick = () => request?.abort();
