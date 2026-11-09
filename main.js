const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');
const path = require('path');
const Store = require('electron-store');
// Electron 31 ships Node 20, so global fetch / AbortController are available here.

// ---------- Cloud providers (BYOK) ----------
// 'anthropic' uses the Messages API; everything else speaks the OpenAI-style
// /chat/completions protocol, so "custom" works with LM Studio, vLLM, Together, etc.
const PROVIDERS = {
  anthropic:  { label: 'Anthropic (Claude)', kind: 'anthropic', defaultModel: 'claude-haiku-5-5' },
  openai:     { label: 'OpenAI',             kind: 'openai', baseUrl: 'https://api.openai.com/v1',      defaultModel: 'gpt-4o-mini' },
  openrouter: { label: 'OpenRouter',         kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1',   defaultModel: 'openai/gpt-4o-mini' },
  groq:       { label: 'Groq',               kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1', defaultModel: 'llama-3.1-8b-instant' },
  custom:     { label: 'Custom (OpenAI-compatible)', kind: 'openai', baseUrl: '', defaultModel: '' }
};
const BRAIN_MODES = ['auto', 'local', 'cloud'];
const ALLOWED_SETTINGS = ['brainMode', 'ollamaUrl', 'ollamaModel', 'cloudProvider', 'cloudModel', 'cloudBaseUrl', 'whisperUrl'];

const store = new Store({
  defaults: {
    brainMode: 'auto', // 'auto' = local first, cloud if unavailable | 'local' | 'cloud'
    ollamaUrl: 'http://127.0.0.1:11434',
    ollamaModel: 'llama3.1',
    cloudProvider: 'anthropic',
    cloudModel: 'claude-haiku-5-5',
    cloudBaseUrl: '',
    whisperUrl: 'http://127.0.0.1:8080',
    keys: {}, // per-provider API keys, encrypted at rest when the OS allows it
    systemPrompt:
      "You are Omnex, a sharp, warm, slightly witty personal AI assistant living on the user's PC. Keep spoken replies concise and natural — you are often heard, not just read."
  }
});

// ---------- Key storage ----------
function encodeKey(plain) {
  if (safeStorage.isEncryptionAvailable()) {
    return 'enc:' + safeStorage.encryptString(plain).toString('base64');
  }
  return 'raw:' + Buffer.from(plain, 'utf8').toString('base64');
}
function decodeKey(stored) {
  if (!stored) return '';
  try {
    if (stored.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
    if (stored.startsWith('raw:')) return Buffer.from(stored.slice(4), 'base64').toString('utf8');
  } catch (_) { /* key unreadable (e.g. different OS user) */ }
  return '';
}
const getKey = (provider) => decodeKey(store.get(`keys.${provider}`));
const setKey = (provider, plain) => store.set(`keys.${provider}`, encodeKey(plain));

// One-time migration from the first version, which stored a single plaintext key.
function migrateOldKey() {
  const old = store.get('cloudApiKey');
  if (old) {
    const p = PROVIDERS[store.get('cloudProvider')] ? store.get('cloudProvider') : 'anthropic';
    if (!store.get(`keys.${p}`)) setKey(p, old);
  }
  if (store.has('cloudApiKey')) store.delete('cloudApiKey');
}

// The renderer never receives API keys — only whether one is saved.
function publicSettings() {
  const { keys, ...rest } = store.store;
  const keyStatus = {};
  for (const p of Object.keys(PROVIDERS)) keyStatus[p] = !!(keys && keys[p]);
  return {
    ...rest,
    keyStatus,
    encryption: safeStorage.isEncryptionAvailable(),
    providers: Object.fromEntries(
      Object.entries(PROVIDERS).map(([k, v]) => [k, { label: v.label, defaultModel: v.defaultModel }])
    )
  };
}

// ---------- Window ----------
let mainWindow;
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#05070a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
}

app.whenReady().then(() => {
  migrateOldKey();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------- Settings IPC ----------
ipcMain.handle('settings:get', () => publicSettings());

ipcMain.handle('settings:set', (_evt, partial = {}) => {
  for (const k of ALLOWED_SETTINGS) {
    if (typeof partial[k] !== 'string') continue;
    const v = partial[k].trim();
    if (k === 'brainMode' && !BRAIN_MODES.includes(v)) continue;
    if (k === 'cloudProvider' && !PROVIDERS[v]) continue;
    store.set(k, v);
  }
  const provider = PROVIDERS[partial.cloudProvider] ? partial.cloudProvider : store.get('cloudProvider');
  if (typeof partial.cloudApiKey === 'string' && partial.cloudApiKey.trim()) {
    setKey(provider, partial.cloudApiKey.trim());
  }
  if (partial.clearCloudKey) store.delete(`keys.${provider}`);
  return publicSettings();
});

// ---------- Local brain (Ollama) ----------
const ollamaBase = () => String(store.get('ollamaUrl')).replace(/\/+$/, '');

async function ollamaModels(timeoutMs = 1500) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${ollamaBase()}/api/tags`, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data.models || []).map((m) => m.name);
  } finally {
    clearTimeout(t);
  }
}

async function callOllama(messages) {
  // Long timeout: a CPU-only machine can legitimately take a while to answer.
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 180000);
  try {
    const res = await fetch(`${ollamaBase()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: store.get('ollamaModel'), messages, stream: false }),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(await describeHttpError(res, 'Ollama'));
    const data = await res.json();
    const text = data.message?.content?.trim();
    if (!text) throw new Error('Ollama returned an empty reply');
    return text;
  } finally {
    clearTimeout(t);
  }
}

// ---------- Cloud brain (BYOK) ----------
async function describeHttpError(res, label) {
  let detail = '';
  try {
    const body = await res.text();
    try {
      const j = JSON.parse(body);
      detail = j.error?.message || j.message || '';
    } catch (_) { detail = body.slice(0, 160); }
  } catch (_) { /* ignore */ }
  if (res.status === 401 || res.status === 403) return `${label} rejected the API key (HTTP ${res.status}). Check the key in Settings.`;
  if (res.status === 429) return `${label} rate limit or out of credit (HTTP 429). ${detail}`.trim();
  return `${label} error HTTP ${res.status}. ${detail}`.trim();
}

async function callCloud(messages, { maxTokens = 1024, timeoutMs = 60000 } = {}) {
  const s = store.store;
  const provider = PROVIDERS[s.cloudProvider] ? s.cloudProvider : 'anthropic';
  const def = PROVIDERS[provider];
  const key = getKey(provider);
  if (!key) throw new Error(`No API key saved for ${def.label}. Add one in Settings.`);
  const model = s.cloudModel || def.defaultModel;
  if (!model) throw new Error('Set a model name for the cloud provider in Settings.');

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (def.kind === 'anthropic') {
      const sys = messages.find((m) => m.role === 'system')?.content || '';
      const rest = messages.filter((m) => m.role !== 'system');
      const body = { model, max_tokens: maxTokens, messages: rest };
      if (sys) body.system = sys;
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (!res.ok) throw new Error(await describeHttpError(res, def.label));
      const data = await res.json();
      return (data.content || []).map((c) => c.text || '').join('').trim();
    }

    const base = String(provider === 'custom' ? s.cloudBaseUrl : def.baseUrl).replace(/\/+$/, '');
    if (!base) throw new Error('Set a base URL for your custom endpoint in Settings.');
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(await describeHttpError(res, def.label));
    const data = await res.json();
    return (data.choices?.[0]?.message?.content || '').trim();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Cloud request timed out.');
    throw err;
  } finally {
    clearTimeout(t);
  }
}

// ---------- Routing ----------
// brainMode: 'local' → Ollama only | 'cloud' → your API key only |
//            'auto'  → Ollama if reachable, otherwise cloud.
ipcMain.handle('llm:chat', async (_evt, { messages }) => {
  const mode = store.get('brainMode');
  const full = [{ role: 'system', content: store.get('systemPrompt') }, ...messages];

  if (mode === 'cloud') {
    try {
      return { text: await callCloud(full), source: 'cloud' };
    } catch (err) {
      return { text: err.message, source: 'error' };
    }
  }

  if (mode === 'local') {
    try {
      return { text: await callOllama(full), source: 'local' };
    } catch (err) {
      return {
        text: `Local model failed: ${err.message}. Is Ollama running with "${store.get('ollamaModel')}" installed? On a low-end PC, switch the brain to Cloud.`,
        source: 'error'
      };
    }
  }

  // auto
  let localError = '';
  try {
    await ollamaModels(); // quick reachability check so we don't wait long when Ollama is off
    return { text: await callOllama(full), source: 'local' };
  } catch (err) {
    localError = err.message || String(err);
  }
  try {
    return { text: await callCloud(full), source: 'cloud', fellBack: true, error: localError };
  } catch (cloudErr) {
    return {
      text: `Local model unavailable (${localError}) and cloud failed: ${cloudErr.message}`,
      source: 'error'
    };
  }
});

ipcMain.handle('llm:test', async (_evt, { target }) => {
  if (target === 'local') {
    try {
      const names = await ollamaModels(3000);
      const want = store.get('ollamaModel');
      const has = names.some((n) => n === want || n === `${want}:latest` || n.split(':')[0] === want);
      return has
        ? { ok: true, message: `Ollama is running and "${want}" is installed.` }
        : { ok: false, message: `Ollama is running but "${want}" isn't installed. Run: ollama pull ${want}` };
    } catch (err) {
      return { ok: false, message: `Can't reach Ollama at ${ollamaBase()}. Install and start it, or use Cloud.` };
    }
  }
  try {
    await callCloud([{ role: 'user', content: 'Reply with the single word OK.' }], { maxTokens: 8, timeoutMs: 20000 });
    return { ok: true, message: 'Key works.' };
  } catch (err) {
    return { ok: false, message: err.message };
  }
});
