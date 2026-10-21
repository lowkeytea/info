// Page side of the Scylla's Band demo: the controls, playback of streamed audio, and the WAV download.
// All model work happens in worker.js.

const $ = (id) => document.getElementById(id);
const els = Object.fromEntries(['start', 'progress', 'progress-bar', 'progress-text', 'warning', 'studio', 'text', 'count',
  'voice', 'language', 'speed', 'speed-value', 'speak', 'stop', 'status', 'result', 'player', 'save', 'storage-text', 'delete',
  'model-info'].map((id) => [id, $(id)]));

const SAMPLE_RATE = 24000;
// ?backend=cpu keeps the demo on WebAssembly even where WebGPU is available (for comparing the two).
const BACKEND = new URLSearchParams(location.search).get('backend') === 'cpu' ? 'cpu' : 'auto';
const BRITISH = new Set(['ink', 'orpheus', 'tuesday']);
const SAMPLES = {
  en: "The last train leaves at midnight, so pack light, bring a warm coat, and don't forget the map.",
  es: 'El último tren sale a medianoche, así que viaja ligero, lleva un abrigo y no olvides el mapa.',
  it: "L'ultimo treno parte a mezzanotte, quindi viaggia leggero, porta un cappotto caldo e non dimenticare la mappa.",
  fr: "Le dernier train part à minuit, alors voyage léger, prends un manteau chaud et n'oublie pas la carte.",
  de: 'Der letzte Zug fährt um Mitternacht, also reise mit leichtem Gepäck, nimm einen warmen Mantel mit und vergiss die Karte nicht.',
  vi: 'Chuyến tàu cuối cùng rời ga lúc nửa đêm, nên hãy mang hành lý gọn nhẹ, một chiếc áo khoác ấm, và đừng quên bản đồ.',
};
// The delivery presets from the Scylla's Band README.
const PRESETS = {
  neutral: { energy: 2, tension: 2, valence: 2, assertiveness: 2 },
  calm: { energy: 1.8, tension: 1, valence: 2.2, assertiveness: 2.1 },
  assertive: { energy: 2.3, tension: 2.4, valence: 2.1, assertiveness: 2.4 },
  joyful: { energy: 2.3, tension: 2, valence: 2.2, assertiveness: 2.2 },
  angry: { energy: 2.3, tension: 2.4, valence: 1.4, assertiveness: 2.4 },
  sad: { energy: 1.7, tension: 1.5, valence: 1.4, assertiveness: 2 },
};
const AXES = Object.keys(PRESETS.neutral);

const mb = (bytes) => `${Math.round(bytes / 1e6)} MB`;
let worker, pin, ready = false, firstRun = true;
let audioContext, nextStart = 0, sources = [], chunks = [], startedAt = 0, firstAudioAt = 0;

function setStatus(text) { els.status.textContent = text; }
function warn(text) { els.warning.textContent = text; els.warning.hidden = !text; }

function createWorker() {
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => handlers[data.type]?.(data);
  worker.onerror = (event) => fail(event.message || 'The demo could not start in this browser.');
  worker.postMessage({ type: 'status', backend: BACKEND });
}

function fail(message) {
  ready = false;
  warn(message);
  els.speak.disabled = true;
  els.stop.hidden = true;
  els.start.disabled = false;
  els.start.textContent = 'Try again';
  els.progress.hidden = true;
}

const handlers = {
  status({ pin: p, missingBytes }) {
    pin = p;
    document.querySelectorAll('[data-size]').forEach((el) => { el.textContent = mb(pin.bytes); });
    els['model-info'].textContent = `Model: ${pin.repo} at revision ${pin.revision.slice(0, 7)} (${pin.ref}), ` +
      `${pin.backend === 'webgpu' ? 'WebGPU' : 'ONNX'} bundle. Runtime: libscyllasband compiled to WebAssembly, with ONNX Runtime ` +
      `Web 1.30.0 on ${pin.backend === 'webgpu' ? 'the GPU (WebGPU)' : 'the CPU (WebAssembly)'}.`;
    const stored = missingBytes === 0;
    els['storage-text'].textContent = stored
      ? `The model (${mb(pin.bytes)}) is stored in this browser.`
      : missingBytes < pin.bytes ? `Part of the model is stored in this browser (${mb(pin.bytes - missingBytes)}).` : 'Nothing is stored yet.';
    els.delete.hidden = missingBytes === pin.bytes;
    if (!ready) {
      els.start.disabled = false;
      els.start.textContent = stored ? 'Start (already downloaded)' : `Download the model (${mb(missingBytes)}) and start`;
    }
  },
  progress({ received, total }) {
    els['progress-bar'].value = total ? received / total : 1;
    els['progress-text'].textContent = `Downloading: ${mb(received)} of ${mb(total)}`;
  },
  warming() {
    els['progress-text'].textContent = 'Preparing the voices…';
  },
  ready({ backend, threads }) {
    ready = true;
    els.progress.hidden = true;
    els.start.hidden = true;
    els.studio.setAttribute('aria-disabled', 'false');
    els.speak.disabled = false;
    setStatus(backend === 'webgpu' ? 'Ready. Running on your GPU with WebGPU.'
      : `Ready. Running on ${threads} CPU thread${threads === 1 ? '' : 's'}.`);
    worker.postMessage({ type: 'status', backend: BACKEND });
  },
  chunk({ index, count }) {
    if (!chunks.length) setStatus(`Generating sentence ${index + 1} of ${count}…`);
  },
  audio({ samples }) {
    chunks.push(samples);
    if (!firstAudioAt) firstAudioAt = performance.now();
    const buffer = audioContext.createBuffer(1, samples.length, SAMPLE_RATE);
    buffer.copyToChannel(samples, 0);
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);
    nextStart = Math.max(nextStart, audioContext.currentTime + 0.05);
    source.start(nextStart);
    nextStart += buffer.duration;
    sources.push(source);
    setStatus(`Speaking… ${secondsOf(chunks).toFixed(1)} s generated so far`);
  },
  done() {
    const elapsed = (performance.now() - startedAt) / 1000;
    const audioSeconds = secondsOf(chunks);
    const first = (firstAudioAt - startedAt) / 1000;
    setStatus(`${audioSeconds.toFixed(1)} s of speech in ${elapsed.toFixed(1)} s ` +
      `(${(audioSeconds / elapsed).toFixed(1)}× real time). First sound after ${first.toFixed(1)} s` +
      `${firstRun ? ', including loading the model into memory.' : '.'}`);
    firstRun = false;
    showResult();
    finishSpeaking();
  },
  stopped() {
    setStatus('Stopped.');
    if (chunks.length) showResult();
    finishSpeaking();
  },
  error({ during, message }) {
    if (during === 'speak') {
      setStatus(`Something went wrong: ${message}`);
      finishSpeaking();
    } else {
      fail(`The model couldn't be loaded: ${message}`);
    }
  },
  deleted() {
    worker.terminate();
    ready = false;
    firstRun = true;
    els.start.hidden = false;
    els.studio.setAttribute('aria-disabled', 'true');
    els.speak.disabled = true;
    setStatus('');
    createWorker();
  },
};

function secondsOf(list) { return list.reduce((a, c) => a + c.length, 0) / SAMPLE_RATE; }

function finishSpeaking() {
  els.speak.disabled = !ready;
  els.stop.hidden = true;
}

function showResult() {
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const all = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) { all.set(c, offset); offset += c.length; }
  const url = URL.createObjectURL(wav(all));
  if (els.player.src) URL.revokeObjectURL(els.player.src);
  els.player.src = url;
  els.save.href = url;
  els.result.hidden = false;
}

function wav(samples) {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (at, s) => [...s].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true); view.setUint32(28, SAMPLE_RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 0x7fff, true));
  return new Blob([view], { type: 'audio/wav' });
}

function delivery() {
  return AXES.map((axis) => `${axis}=${$(axis).value}`).join(',');
}

function syncAxisOutputs() {
  for (const axis of AXES) $(`${axis}-value`).textContent = Number($(axis).value).toFixed(1);
}

function updateEnglishLabel() {
  els.language.options[0].textContent = BRITISH.has(els.voice.value) ? 'English (UK)' : 'English (US)';
}

function updateCount() { els.count.textContent = els.text.value.length; }

// Controls
els.start.addEventListener('click', async () => {
  warn('');
  els.start.disabled = true;
  els.start.textContent = 'Loading…';
  els.progress.hidden = false;
  els['progress-text'].textContent = 'Preparing…';
  try { await navigator.storage?.persist?.(); } catch { /* storage stays best-effort */ }
  worker.postMessage({ type: 'start', backend: BACKEND });
});

els.speak.addEventListener('click', async () => {
  const text = els.text.value.trim();
  if (!text) return setStatus('Type something first.');
  audioContext ??= new AudioContext();
  await audioContext.resume();
  for (const s of sources) { try { s.stop(); } catch { /* already ended */ } }
  sources = []; chunks = []; nextStart = 0; firstAudioAt = 0;
  els.result.hidden = true;
  els.speak.disabled = true;
  els.stop.hidden = false;
  setStatus(firstRun ? 'Loading the model into memory…' : 'Generating…');
  startedAt = performance.now();
  worker.postMessage({ type: 'speak', text, voice: els.voice.value, language: els.language.value, delivery: delivery(),
    speed: Number(els.speed.value) });
});

els.stop.addEventListener('click', () => {
  worker.postMessage({ type: 'cancel' });
  for (const s of sources) { try { s.stop(); } catch { /* already ended */ } }
});

els.delete.addEventListener('click', () => {
  if (!confirm('Delete the downloaded Scylla\'s Band model from this browser?')) return;
  worker.postMessage({ type: 'delete' });
});

els.voice.addEventListener('change', updateEnglishLabel);
els.language.addEventListener('change', () => {
  if (Object.values(SAMPLES).includes(els.text.value)) { els.text.value = SAMPLES[els.language.value]; updateCount(); }
});
els.text.addEventListener('input', updateCount);
els.speed.addEventListener('input', () => { els['speed-value'].textContent = `${Number(els.speed.value).toFixed(2)}×`; });

document.querySelectorAll('input[name="preset"]').forEach((radio) => radio.addEventListener('change', () => {
  const preset = PRESETS[radio.value];
  if (!preset) return;
  for (const axis of AXES) $(axis).value = preset[axis];
  syncAxisOutputs();
}));
for (const axis of AXES) {
  $(axis).addEventListener('input', () => {
    document.querySelector('input[name="preset"][value="custom"]').checked = true;
    syncAxisOutputs();
  });
}

// Start-up checks
updateCount();
updateEnglishLabel();
syncAxisOutputs();
if (typeof WebAssembly !== 'object' || !('caches' in self) || !('Worker' in self)) {
  els.start.textContent = 'Not supported in this browser';
  warn('This browser is missing something the demo needs (WebAssembly, workers or Cache Storage). Private windows often turn off Cache Storage.');
} else {
  if ((navigator.deviceMemory && navigator.deviceMemory < 4) || matchMedia('(pointer: coarse)').matches) {
    warn('This looks like a phone or a device with limited memory. The demo may not have enough memory to run here.');
  }
  createWorker();
}
