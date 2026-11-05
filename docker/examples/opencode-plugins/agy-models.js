// OpenCode 1.x local plugin. Copy to .opencode/plugins/agy-models.js.
// No external dependencies; credentials never get written to config or logs.
export const AgyModels = async ({ client } = {}) => ({
  async config(config) {
    const provider = config.provider?.agy;
    if (!provider) return;
    const options = provider.options || {};
    const resolveEnv = value => typeof value === 'string'
      ? value.replace(/\{env:([^}]+)\}/g, (_, name) => process.env[name] || '') : value;
    const baseURL = resolveEnv(options.baseURL);
    const apiKey = resolveEnv(options.apiKey) || process.env.AGY_API_KEY;
    const warn = async message => {
      try { await client?.app?.log({ body: { service: 'agy-models', level: 'warn', message } }); } catch {}
    };
    if (!baseURL || !apiKey) {
      await warn('Agy model discovery needs provider.agy.options.baseURL and AGY_API_KEY. Keeping configured models.');
      return;
    }
    try {
      const url = new URL(baseURL.replace(/\/+$/, '') + '/models');
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid endpoint');
      const response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15000), redirect: 'error' });
      if (!response.ok) {
        await warn(`Agy model discovery failed (HTTP ${response.status}). Keeping configured models.`);
        return;
      }
      const payload = await response.json();
      if (!Array.isArray(payload.data) || payload.data.length > 1000) throw new Error('Invalid model list');
      const models = Object.create(null);
      for (const item of payload.data) {
        if (!item || typeof item.id !== 'string' || !item.id.trim() || item.id.length > 200 || ['__proto__','constructor','prototype','agy-image'].includes(item.id)) continue;
        const previous = Object.hasOwn(provider.models || {}, item.id) ? provider.models[item.id] : {};
        models[item.id] = {
          ...previous,
          name: typeof item.name === 'string' && item.name ? item.name : item.id,
          temperature: false,
          tool_call: true,
          modalities: { input: ['text'], output: ['text'] },
          options: { ...previous?.options, max_tokens: null, max_completion_tokens: null, temperature: null, top_p: null, frequency_penalty: null, presence_penalty: null },
        };
      }
      const ids = Object.keys(models);
      if (!ids.length) throw new Error('Empty model list');
      // Mutate only after a complete successful fetch. Stale model IDs disappear.
      provider.models = models;
      const fallback = models['agy-default'] ? 'agy-default' : ids[0];
      for (const field of ['model','small_model']) {
        if (typeof config[field] === 'string' && config[field].startsWith('agy/') && !Object.hasOwn(models, config[field].slice(4))) config[field] = 'agy/' + fallback;
      }
    } catch {
      await warn('Agy model discovery failed or timed out. Keeping configured models.');
    }
  },
});
