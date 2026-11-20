// Page side of the Scylla's Band demo: the controls, playback of streamed audio, and the WAV download.
// All model work happens in worker.js.

const $ = (id) => document.getElementById(id);
const els = Object.fromEntries(['start', 'progress', 'progress-bar', 'progress-text', 'warning', 'studio', 'text', 'count',
  'voice', 'language', 'speed', 'speed-value', 'speak', 'stop', 'status', 'result', 'player', 'save', 'storage-text', 'delete',
  'model-info', 'trimmed', 'clips', 'clip-list', 'embedded-note', 'full-page'].map((id) => [id, $(id)]));

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
// Quick settings for the three delivery controls (0 is the voice's own delivery; the emotion comes from the text).
const PRESETS = {
  default: { intensity: 0, pace: 0, pitch: 0 },
  calm: { intensity: -1.5, pace: -0.5, pitch: 0 },
  intense: { intensity: 1.5, pace: 0, pitch: 0 },
  slower: { intensity: 0, pace: -1, pitch: 0 },
  faster: { intensity: 0, pace: 1, pitch: 0 },
};
const AXES = Object.keys(PRESETS.default);
// One-click English texts that carry an emotion, each with a delivery preset that suits it.
const EXAMPLES = {
  angry: { preset: 'intense', text: 'I told you three times not to touch it! Why does nobody in this house ever listen to me?' },
  excited: { preset: 'faster', text: "We did it! We actually won! I can't believe it, this is the best day of my whole life!" },
  sad: { preset: 'calm', text: 'I kept his letters for years. I still read them sometimes, late at night, and I still miss him.' },
  scared: { preset: 'default', text: "Did you hear that? Something's moving downstairs. Please, stay close to me and don't make a sound." },
};
const MAX_CHARS = 600;
const ABBREVIATION = /(?:^|[\s(])(?:Mr|Mrs|Ms|Dr|Prof|St|Mt|Jr|Sr|Sra|Srta|Dra|Mme|Mlle|Hr|vs|No|[A-Za-zÀ-ÿ])\.$/;
const MAX_CLIPS = 8;
const LANGUAGE_NAMES = { en: 'English', es: 'Spanish', it: 'Italian', fr: 'French', de: 'German', vi: 'Vietnamese' };

const mb = (bytes) => `${Math.round(bytes / 1e6)} MB`;
let worker, pin, ready = false, firstRun = true;
let audioContext, nextStart = 0, sources = [], chunks = [], startedAt = 0, firstAudioAt = 0;
let request = null;
const clips = [];

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
    els['model-info'].textContent = `Model: ${pin.repo} at revision ${pin.revision.slice(0, 7)} (${pin.ref}), the speech graphs ` +
      `of the WebGPU bundle (8-bit weights). Runtime: libscyllasband compiled to WebAssembly, with ONNX Runtime Web 1.30.0 on ` +
      `${pin.backend === 'webgpu' ? 'the GPU (WebGPU)' : 'the CPU (WebAssembly)'}.`;
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
    if (chunks.length) showResult(true);
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

function showResult(stopped = false) {
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const all = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) { all.set(c, offset); offset += c.length; }
  const clip = { ...request, url: URL.createObjectURL(wav(all)), seconds: total / SAMPLE_RATE, stopped };
  clips.unshift(clip);
  // Drop the oldest clips; the player only ever holds one of the clips kept.
  for (const old of clips.splice(MAX_CLIPS)) URL.revokeObjectURL(old.url);
  select(clip);
  els.result.hidden = false;
}

// The current request's voice, language and delivery, for the clip's label and file name.
function describeRequest(text) {
  const voice = els.voice.value;
  const preset = document.querySelector('input[name="preset"]:checked')?.value || 'default';
  const values = Object.fromEntries(AXES.map((axis) => [axis, Number($(axis).value)]));
  const speed = Number(els.speed.value);
  const language = els.language.value === 'en' && BRITISH.has(voice) ? 'en-gb' : els.language.value;
  const deliveryName = preset === 'custom'
    ? AXES.map((axis) => `${axis}${values[axis] > 0 ? '+' : ''}${values[axis].toFixed(1)}`).join('_') : preset;
  const name = ['scyllasband', voice, language, deliveryName, speed === 1 ? '' : `${speed.toFixed(2)}x`].filter(Boolean).join('-');
  const voiceName = els.voice.selectedOptions[0].textContent;
  const deliveryLabel = preset === 'custom'
    ? AXES.map((axis) => `${axis} ${values[axis].toFixed(1)}`).join(', ')
    : document.querySelector(`input[name="preset"][value="${preset}"] + span`).textContent;
  const label = [voiceName, els.language.selectedOptions[0].textContent || LANGUAGE_NAMES[els.language.value], deliveryLabel,
    speed === 1 ? '' : `${speed.toFixed(2)}×`].filter(Boolean).join(' · ');
  return { text, file: `${name}.wav`, label };
}

function select(clip) {
  els.player.src = clip.url;
  els.save.href = clip.url;
  els.save.download = clip.file;
  els.save.textContent = `Download ${clip.file}`;
  renderClips(clip);
}

function renderClips(current) {
  els['clip-list'].replaceChildren(...clips.map((clip) => {
    const item = document.createElement('li');
    if (clip === current) item.setAttribute('aria-current', 'true');
    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'clip-play';
    play.textContent = `${clip.label} · ${clip.seconds.toFixed(1)} s${clip.stopped ? ' (stopped)' : ''}`;
    play.addEventListener('click', () => { select(clip); els.player.play().catch(() => {}); });
    const text = document.createElement('span');
    text.className = 'clip-text';
    text.textContent = `“${clip.text}”`;
    text.title = clip.text;
    const save = document.createElement('a');
    save.href = clip.url;
    save.download = clip.file;
    save.textContent = 'WAV';
    save.setAttribute('aria-label', `Download ${clip.file}`);
    item.append(play, text, save);
    return item;
  }));
  els.clips.hidden = clips.length < 2;
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

// "Voice default" sends no delivery, so each voice speaks at the model's own default for it.
function delivery() {
  if (document.querySelector('input[name="preset"][value="default"]')?.checked) return '';
  return AXES.map((axis) => `${axis}=${$(axis).value}`).join(',');
}

function syncAxisOutputs() {
  for (const axis of AXES) $(`${axis}-value`).textContent = Number($(axis).value).toFixed(1);
}

function updateEnglishLabel() {
  els.language.options[0].textContent = BRITISH.has(els.voice.value) ? 'English (UK)' : 'English (US)';
}

function updateCount() { els.count.textContent = els.text.value.length; }

// Text over the limit is cut at the end of the last full sentence that fits (else at the last space), and the page says
// so, rather than stopping mid-word.
function trimText() {
  const text = els.text.value;
  if (text.length <= MAX_CHARS) return;
  const head = text.slice(0, MAX_CHARS + 1);
  let cut = -1;
  for (const match of head.matchAll(/[.!?…。！？](?:["'”’»)\]]*)(?=\s|$)/g)) {
    // A title or single letter before the full stop ("Dr.", "Sra.", "z. B.") isn't the end of a sentence.
    if (match[0][0] === '.' && ABBREVIATION.test(head.slice(0, match.index + 1))) continue;
    if (match.index + match[0].length <= MAX_CHARS) cut = match.index + match[0].length;
  }
  if (cut < MAX_CHARS / 3) cut = head.lastIndexOf(' ') > 0 ? head.lastIndexOf(' ') : MAX_CHARS;
  els.text.value = text.slice(0, cut).trimEnd();
  els.trimmed.textContent = `Trimmed from ${text.length} characters, at the end of the last full sentence that fits.`;
}

function onTextInput() {
  if (els.text.value.length > MAX_CHARS) trimText();
  else if (els.text.value.length < MAX_CHARS) els.trimmed.textContent = '';
  updateCount();
}

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
  request = describeRequest(text);
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
// ?voice=<id> opens the demo on that voice (the sample page links here from each voice's card).
const wantedVoice = new URLSearchParams(location.search).get('voice');
if (wantedVoice && [...els.voice.options].some((option) => option.value === wantedVoice)) {
  els.voice.value = wantedVoice;
  updateEnglishLabel();
}
els.language.addEventListener('change', () => {
  if (Object.values(SAMPLES).includes(els.text.value)) { els.text.value = SAMPLES[els.language.value]; updateCount(); }
});
els.text.addEventListener('input', onTextInput);
document.querySelectorAll('[data-example]').forEach((button) => button.addEventListener('click', () => {
  const example = EXAMPLES[button.dataset.example];
  els.language.value = 'en';
  els.text.value = example.text;
  els.trimmed.textContent = '';
  updateCount();
  const radio = document.querySelector(`input[name="preset"][value="${example.preset}"]`);
  radio.checked = true;
  radio.dispatchEvent(new Event('change'));
}));
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
// Inside another page (a Hugging Face Space shows it in a frame) the page isn't cross-origin isolated, so the CPU path
// gets one thread; offer the same page in its own tab.
let embedded = false;
try { embedded = window.top !== window; } catch { embedded = true; }
if (embedded && !self.crossOriginIsolated) {
  els['full-page'].href = location.href;
  els['embedded-note'].hidden = false;
}
onTextInput();
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
