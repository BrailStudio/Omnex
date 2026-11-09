import { AvatarStage } from './avatar.js';
import { VoiceEngine } from './voice.js';
import { Conversation } from './llm.js';

const $ = (id) => document.getElementById(id);

const stage = new AvatarStage($('avatar-canvas'));
const convo = new Conversation();
let settings = {};
let mode = 'text'; // 'text' | 'voice'
let isRecording = false;

// ---------- Load avatar ----------
stage
  .loadVRM('../assets/models/omnex.vrm')
  .then(() => ($('no-model-hint').style.display = 'none'))
  .catch(() => ($('no-model-hint').style.display = 'block'));

// ---------- Voice engine ----------
const voice = new VoiceEngine({
  onLevel: (lvl) => setRingLevel(lvl)
});

function setRingLevel(level) {
  const scale = 1 + Math.min(level * 1.6, 0.6);
  $('ring-level').style.transform = `scale(${scale})`;
}

// ---------- Status readout ----------
function setStatus(text, cls) {
  $('status-text').textContent = text;
  $('status-dot').className = 'dot' + (cls ? ` ${cls}` : '');
}
setStatus('READY');

// ---------- Transcript ----------
function addMessage(role, text, tagText) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.textContent = text;
  if (tagText) {
    const tag = document.createElement('span');
    tag.className = 'msg-source';
    tag.textContent = tagText;
    div.appendChild(tag);
  }
  $('transcript').appendChild(div);
  $('transcript').scrollTop = $('transcript').scrollHeight;
}

// ---------- Send a message through the pipeline ----------
async function handleUserText(text) {
  if (!text.trim()) return;
  addMessage('user', text);
  setStatus('THINKING', 'online');

  const { text: reply, source, fellBack } = await convo.send(text);
  const tag = source === 'error' ? 'ERROR' : fellBack ? 'CLOUD FALLBACK' : null;
  addMessage('omnex', reply, tag);

  if (mode === 'voice' && source !== 'error') {
    setStatus('SPEAKING', 'listening');
    voice.speak(reply, {
      onMouth: (m) => stage.setSpeaking(m),
      onEnd: () => setStatus('READY', 'online')
    });
  } else {
    setStatus('READY', 'online');
  }
}

// ---------- Text mode ----------
$('text-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('text-input');
  const text = input.value;
  input.value = '';
  handleUserText(text);
});

// ---------- Voice mode ----------
$('mic-btn').addEventListener('mousedown', startListening);
$('mic-btn').addEventListener('mouseup', stopListening);
$('mic-btn').addEventListener('mouseleave', () => { if (isRecording) stopListening(); });

async function startListening() {
  if (isRecording) return;
  isRecording = true;
  $('mic-btn').classList.add('active');
  $('mic-label').textContent = 'Listening…';
  setStatus('LISTENING', 'listening');

  const engine = $('voice-engine').value;
  if (engine === 'browser') {
    try {
      voice.startBrowserListening({
        onResult: (transcript) => handleUserText(transcript),
        onEnd: () => resetMicUI()
      });
    } catch (err) {
      addMessage('system', err.message);
      resetMicUI();
    }
  } else {
    try {
      await voice.startOfflineRecording();
    } catch (err) {
      addMessage('system', 'Microphone access failed: ' + err.message);
      resetMicUI();
    }
  }
}

async function stopListening() {
  if (!isRecording) return;
  const engine = $('voice-engine').value;

  if (engine === 'browser') {
    voice.stopBrowserListening();
  } else {
    resetMicUI();
    setStatus('TRANSCRIBING', 'online');
    try {
      const whisperUrl = settings.whisperUrl || 'http://127.0.0.1:8080';
      const text = await voice.stopOfflineRecording(whisperUrl);
      if (text) handleUserText(text);
      else setStatus('READY', 'online');
    } catch (err) {
      addMessage('system', 'Offline transcription failed: ' + err.message + ' — is your whisper.cpp server running?');
      setStatus('READY');
    }
  }
}

function resetMicUI() {
  isRecording = false;
  $('mic-btn').classList.remove('active');
  $('mic-label').textContent = 'Hold to talk';
  if ($('status-text').textContent === 'LISTENING') setStatus('READY', 'online');
}

// ---------- Mode toggle ----------
document.querySelectorAll('.mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mode-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    mode = btn.dataset.mode;
    $('text-form').classList.toggle('hidden', mode !== 'text');
    $('voice-row').classList.toggle('hidden', mode !== 'voice');
    if (mode === 'voice' && !voice.browserSpeechAvailable()) {
      $('voice-engine').value = 'offline';
    }
  });
});

// ---------- Brain switch (top bar) ----------
function syncBrainUI() {
  document.querySelectorAll('.brain-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.brain === settings.brainMode)
  );
}

document.querySelectorAll('.brain-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    settings = await window.omnex.setSettings({ brainMode: btn.dataset.brain });
    syncBrainUI();
    if (btn.dataset.brain === 'cloud' && !settings.keyStatus[settings.cloudProvider]) {
      addMessage('system', 'Cloud mode needs an API key. Open Settings (⚙) and paste yours.');
    }
  });
});

// ---------- Settings modal ----------
function fillProviderOptions() {
  const sel = $('s-cloud-provider');
  if (sel.options.length) return;
  for (const [id, meta] of Object.entries(settings.providers || {})) {
    sel.add(new Option(meta.label, id));
  }
}

function refreshProviderUI() {
  const p = $('s-cloud-provider').value;
  const saved = !!settings.keyStatus?.[p];
  $('s-cloud-key').value = '';
  $('s-cloud-key').placeholder = saved ? '•••••••• saved (leave blank to keep)' : 'Paste your API key';
  $('s-remove-key').classList.toggle('hidden', !saved);
  $('s-base-row').classList.toggle('hidden', p !== 'custom');
  $('key-storage-hint').textContent = settings.encryption
    ? 'Keys are encrypted with your OS keychain and never shown again.'
    : 'Your OS has no secure keychain available, so keys are stored unencrypted in the app data folder.';
}

function formValues() {
  return {
    brainMode: $('s-brain-mode').value,
    ollamaUrl: $('s-ollama-url').value,
    ollamaModel: $('s-ollama-model').value,
    cloudProvider: $('s-cloud-provider').value,
    cloudModel: $('s-cloud-model').value,
    cloudBaseUrl: $('s-cloud-base').value,
    whisperUrl: $('s-whisper-url').value,
    cloudApiKey: $('s-cloud-key').value
  };
}

async function loadSettingsIntoForm() {
  settings = await window.omnex.getSettings();
  fillProviderOptions();
  $('s-brain-mode').value = settings.brainMode || 'auto';
  $('s-ollama-url').value = settings.ollamaUrl || '';
  $('s-ollama-model').value = settings.ollamaModel || '';
  $('s-cloud-provider').value = settings.cloudProvider || 'anthropic';
  $('s-cloud-model').value = settings.cloudModel || '';
  $('s-cloud-base').value = settings.cloudBaseUrl || '';
  $('s-whisper-url').value = settings.whisperUrl || 'http://127.0.0.1:8080';
  refreshProviderUI();
  syncBrainUI();
}

$('s-cloud-provider').addEventListener('change', () => {
  const p = $('s-cloud-provider').value;
  $('s-cloud-model').value = settings.providers?.[p]?.defaultModel || '';
  refreshProviderUI();
});

async function runTest(target, resultEl) {
  resultEl.className = 'test-result';
  resultEl.textContent = 'Testing…';
  settings = await window.omnex.setSettings(formValues()); // test what's on screen
  refreshProviderUI();
  syncBrainUI();
  const r = await window.omnex.testBrain(target);
  resultEl.textContent = r.message;
  resultEl.className = 'test-result ' + (r.ok ? 'ok' : 'bad');
}
$('test-local').addEventListener('click', () => runTest('local', $('test-local-result')));
$('test-cloud').addEventListener('click', () => runTest('cloud', $('test-cloud-result')));

$('s-remove-key').addEventListener('click', async () => {
  settings = await window.omnex.setSettings({ cloudProvider: $('s-cloud-provider').value, clearCloudKey: true });
  $('test-cloud-result').textContent = '';
  refreshProviderUI();
});

$('settings-btn').addEventListener('click', async () => {
  await loadSettingsIntoForm();
  $('test-local-result').textContent = '';
  $('test-cloud-result').textContent = '';
  $('settings-modal').showModal();
});
$('settings-cancel').addEventListener('click', () => $('settings-modal').close());
$('settings-form').addEventListener('submit', async () => {
  settings = await window.omnex.setSettings(formValues());
  syncBrainUI();
});

// ---------- Boot ----------
loadSettingsIntoForm().then(() => {
  const labels = { auto: 'auto (local first, cloud fallback)', local: 'local only', cloud: 'cloud (your API key)' };
  addMessage('system', `Omnex online · brain: ${labels[settings.brainMode] || settings.brainMode}`);
});
