export class VoiceEngine {
  constructor({ onLevel } = {}) {
    this.onLevel = onLevel || (() => {});
    this.recognition = null;
    this.mediaStream = null;
    this.mediaRecorder = null;
    this.audioCtx = null;
    this.analyser = null;
    this._levelRAF = null;
  }

  browserSpeechAvailable() {
    return 'webkitSpeechRecognition' in window || 'SpeechRecognition' in window;
  }

  // ---------- Speech-to-text: browser engine ----------
  startBrowserListening({ onResult, onEnd }) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) throw new Error('Browser speech recognition not available (use Chrome/Edge).');
    const rec = new SR();
    rec.lang = 'en-US';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onresult = (e) => onResult(e.results[e.results.length - 1][0].transcript);
    rec.onend = () => onEnd?.();
    rec.onerror = (e) => onEnd?.(e.error);
    rec.start();
    this.recognition = rec;
  }

  stopBrowserListening() {
    this.recognition?.stop();
    this.recognition = null;
  }

  // ---------- Speech-to-text: offline Whisper server ----------
  async startOfflineRecording() {
    this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this._setupLevelMeter(this.mediaStream);
    this.mediaRecorder = new MediaRecorder(this.mediaStream);
    this._chunks = [];
    this.mediaRecorder.ondataavailable = (e) => this._chunks.push(e.data);
    this.mediaRecorder.start();
  }

  async stopOfflineRecording(whisperUrl) {
    return new Promise((resolve, reject) => {
      if (!this.mediaRecorder) return reject(new Error('Not recording'));
      this.mediaRecorder.onstop = async () => {
        this._teardownLevelMeter();
        this.mediaStream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(this._chunks, { type: 'audio/webm' });
        try {
          const form = new FormData();
          form.append('file', blob, 'speech.webm');
          const res = await fetch(`${whisperUrl}/inference`, { method: 'POST', body: form });
          if (!res.ok) throw new Error(`Whisper server HTTP ${res.status}`);
          const data = await res.json();
          resolve((data.text || '').trim());
        } catch (err) {
          reject(err);
        }
      };
      this.mediaRecorder.stop();
    });
  }

  _setupLevelMeter(stream) {
    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = this.audioCtx.createMediaStreamSource(stream);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 256;
    src.connect(this.analyser);
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    const tick = () => {
      this.analyser.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length / 255;
      this.onLevel(avg);
      this._levelRAF = requestAnimationFrame(tick);
    };
    tick();
  }

  _teardownLevelMeter() {
    if (this._levelRAF) cancelAnimationFrame(this._levelRAF);
    this.audioCtx?.close();
    this.audioCtx = null;
  }

  // ---------- Text-to-speech ----------
  // Uses the browser's built-in speech synthesis. Drives an approximate
  // mouth-open envelope via word boundary events (onMouth callback, 0..1)
  // since raw synthesized audio isn't accessible for real analysis.
  speak(text, { onMouth, onEnd } = {}) {
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 1.02;
    utter.pitch = 1.05;
    const voices = window.speechSynthesis.getVoices();
    const preferred = voices.find((v) => /female|samantha|zira|jenny/i.test(v.name));
    if (preferred) utter.voice = preferred;

    utter.onboundary = () => {
      onMouth?.(0.5 + Math.random() * 0.5);
      setTimeout(() => onMouth?.(Math.random() * 0.15), 90);
    };
    utter.onend = () => {
      onMouth?.(0);
      onEnd?.();
    };
    utter.onerror = () => {
      onMouth?.(0);
      onEnd?.();
    };
    window.speechSynthesis.speak(utter);
  }

  stopSpeaking() {
    window.speechSynthesis.cancel();
  }
}
