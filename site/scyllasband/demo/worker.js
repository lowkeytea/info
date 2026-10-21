// Runs Scylla's Band off the main thread: downloads and verifies the pinned model files, keeps them in Cache Storage,
// and drives the WebAssembly build of libscyllasband, whose graph calls go to ONNX Runtime Web: on the GPU through
// WebGPU when the browser has an adapter (the `webgpu` bundle), otherwise on the CPU in WebAssembly (the `onnx` bundle).
import createScyllasBand from './engine/scyllasband.mjs';

const CACHE = 'scyllasband-model-v1';
const ORT_VERSION = '1.30.0';
// ONNX Runtime Web's WebGPU build without JSPI needs a 25.5 MiB WebAssembly file, over the host's 25 MiB per-file limit,
// so that one file comes from the npm CDN (CORS, so it loads under COEP). Browsers with JSPI use the 16 MiB build here.
const ASYNCIFY_WASM = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort-wasm-simd-threaded.asyncify.wasm`;
const post = (message, transfer = []) => self.postMessage(message, transfer);

let ort, backend, pin, files, byPath, manifest, engine, runtime, shared;
let cancelled = false, warming = false;
const sessions = new Map();

// WebGPU when an adapter is available (and not turned off with ?backend=cpu), else WebAssembly on the CPU.
async function chooseBackend(preference) {
  if (backend) return backend;
  let adapter = null;
  if (preference !== 'cpu' && self.navigator?.gpu) {
    try { adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }); } catch { adapter = null; }
  }
  if (adapter) {
    const jspi = typeof WebAssembly.Suspending === 'function';
    backend = { kind: 'webgpu', flavor: 'webgpu', build: jspi ? 'jspi' : 'webgpu', adapter: adapter.info?.vendor || '' };
  } else {
    backend = { kind: 'wasm', flavor: 'wasm', build: 'wasm' };
  }
  ort = await import(`./ort/ort.${backend.build}.min.mjs`);
  ort.env.wasm.wasmPaths = backend.build === 'webgpu'
    ? { mjs: new URL('./ort/ort-wasm-simd-threaded.asyncify.mjs', import.meta.url).href, wasm: ASYNCIFY_WASM }
    : new URL('./ort/', import.meta.url).href;
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) : 1;
  return backend;
}

async function loadPin(preference) {
  if (!pin) {
    pin = await (await fetch(new URL('./model-files.json', import.meta.url))).json();
    await chooseBackend(preference);
    files = pin.flavors[backend.flavor].files;
    byPath = new Map(files.map((f) => [f.path, f]));
  }
  return pin;
}

async function missingFiles() {
  const cache = await caches.open(CACHE);
  const have = new Set((await cache.keys()).map((r) => r.url));
  return files.filter((f) => !have.has(f.url));
}

async function sha256(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function download() {
  const cache = await caches.open(CACHE);
  // Drop files from an earlier pinned revision so they don't take up space next to the current one.
  const pinned = new Set(files.map((f) => f.url));
  for (const request of await cache.keys()) if (!pinned.has(request.url)) await cache.delete(request);
  const todo = await missingFiles();
  const total = todo.reduce((a, f) => a + f.size, 0);
  let received = 0;
  for (const file of todo) {
    const response = await fetch(file.url);
    if (!response.ok) throw new Error(`Hugging Face returned ${response.status} for ${file.path}.`);
    const bytes = new Uint8Array(file.size);
    let offset = 0;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.length > file.size) throw new Error(`${file.path} is larger than expected.`);
      bytes.set(value, offset);
      offset += value.length;
      received += value.length;
      post({ type: 'progress', received, total });
    }
    if (offset !== file.size) throw new Error(`${file.path} was cut short.`);
    if ((await sha256(bytes)) !== file.sha256) throw new Error(`${file.path} failed its checksum.`);
    await cache.put(file.url, new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } }));
  }
}

async function read(path) {
  const file = byPath.get(path);
  if (!file) throw new Error(`${path} isn't part of the pinned bundle.`);
  const response = await (await caches.open(CACHE)).match(file.url);
  if (!response) throw new Error(`${path} is missing from the browser cache.`);
  return new Uint8Array(await response.arrayBuffer());
}

function session(name) {
  if (!sessions.has(name)) {
    sessions.set(name, (async () => {
      const model = await read(manifest.components[name].artifacts.onnx.path);
      const options = { executionProviders: [backend.kind === 'webgpu' ? 'webgpu' : 'wasm'], graphOptimizationLevel: 'all' };
      if (name !== 'g2p') {
        shared ??= await read('onnx/components/shared_weights.bin');
        options.externalData = [{ path: 'shared_weights.bin', data: shared }];
      }
      return ort.InferenceSession.create(model, options);
    })());
  }
  return sessions.get(name);
}

async function runGraph(name, inputs) {
  if (cancelled) throw new Error('cancelled');
  if (name === 'g2p') {
    // The G2P input is zero-padded and masked; running only the used width gives the same result. On the CPU the width
    // is rounded up to 32; on the GPU to a power of two from 32, since each new input shape compiles new shaders.
    const ids = inputs[0].data;
    let used = ids.length;
    while (used > 1 && ids[used - 1] === 0n) used--;
    const step = backend.kind === 'webgpu' ? 2 ** Math.ceil(Math.log2(Math.max(32, used))) : Math.ceil(used / 32) * 32;
    const width = Math.min(ids.length, step);
    inputs = [{ ...inputs[0], data: ids.slice(0, width), shape: [1, width] }];
  }
  const s = await session(name);
  const names = manifest.components[name].inputs;
  const feeds = Object.fromEntries(inputs.map((x, i) => [names[i], new ort.Tensor(x.type, x.data, x.shape)]));
  const output = (await s.run(feeds))[s.outputNames[0]];
  return { data: output.data, shape: output.dims };
}

// Event types from scyllasband.h: 1 plan, 2 chunk started, 3 audio, 4 done.
function onEvent(type, chunkIndex, chunkCount, samples) {
  if (warming) return 0;
  if (type === 2) post({ type: 'chunk', index: chunkIndex, count: chunkCount });
  if (type === 3 && samples) {
    const copy = samples.slice();
    post({ type: 'audio', samples: copy }, [copy.buffer]);
  }
  return cancelled ? 1 : 0;
}

async function start() {
  await download();
  manifest = JSON.parse(new TextDecoder().decode(await read('manifest.json')));
  engine = await createScyllasBand({ runGraph, onEvent, locateFile: (f) => new URL(`./engine/${f}`, import.meta.url).href });
  // The engine reads the manifest and JSON assets from its virtual filesystem and checks that each graph file exists;
  // the graphs themselves are loaded on the JavaScript side, so empty placeholders are enough.
  const put = (path, bytes) => {
    engine.FS.mkdirTree(`/bundle/${path}`.replace(/\/[^/]*$/, ''));
    engine.FS.writeFile(`/bundle/${path}`, bytes);
  };
  put('manifest.json', await read('manifest.json'));
  for (const path of Object.values(manifest.assets)) put(path, await read(path));
  for (const component of Object.values(manifest.components)) put(component.artifacts.onnx.path, new Uint8Array(0));
  runtime = engine.ccall('sb_create', 'number', ['string'], ['/bundle']);
  if (!runtime) throw new Error(engine.ccall('scyllasband_last_error', 'string', [], []));
  // One short sentence, unheard, loads every graph a first request needs (and on the GPU compiles their shaders), so
  // the visitor's first request starts as quickly as later ones.
  post({ type: 'warming' });
  warming = true;
  try {
    await engine.ccall('sb_stream', 'number', ['number', 'string', 'string', 'string', 'string', 'number', 'number'],
      [runtime, 'Hello there.', 'scylla', 'en', 'energy=2,tension=2,valence=2,assertiveness=2', 1, -1], { async: true });
  } finally {
    warming = false;
  }
  post({ type: 'ready', backend: backend.kind, adapter: backend.adapter, threads: ort.env.wasm.numThreads });
}

async function speak({ text, voice, language, delivery, speed }) {
  cancelled = false;
  engine.graphError = null;
  const status = await engine.ccall('sb_stream', 'number', ['number', 'string', 'string', 'string', 'string', 'number', 'number'],
    [runtime, text, voice, language, delivery, speed, -1], { async: true });
  if (cancelled || status === 3) return post({ type: 'stopped' });
  if (status !== 0) {
    const detail = engine.graphError?.message || engine.ccall('scyllasband_last_error', 'string', [], []);
    throw new Error(detail || `Synthesis failed (status ${status}).`);
  }
  post({ type: 'done' });
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'status') {
      await loadPin(data.backend);
      const missing = await missingFiles();
      post({ type: 'status', pin: { ...pin, flavors: undefined, bytes: pin.flavors[backend.flavor].bytes, backend: backend.kind },
             missingBytes: missing.reduce((a, f) => a + f.size, 0) });
    } else if (data.type === 'start') {
      await loadPin(data.backend);
      await start();
    } else if (data.type === 'speak') {
      await speak(data);
    } else if (data.type === 'cancel') {
      cancelled = true;
    } else if (data.type === 'delete') {
      await caches.delete(CACHE);
      post({ type: 'deleted' });
    }
  } catch (error) {
    post({ type: 'error', during: data.type, message: error?.message || String(error) });
  }
};
