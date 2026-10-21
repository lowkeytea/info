// Pins the demo to one Hugging Face revision of the model: writes site/scyllasband/demo/model-files.json with the commit
// and, for each bundle the browser can use, the URL, size and sha256 of every file the browser runtime needs:
//   wasm    the `onnx/` bundle (dynamic INT8), run on the CPU in WebAssembly
//   webgpu  the `webgpu/` bundle (INT8 weights, float compute), run on the GPU through WebGPU
// The worker picks one and downloads only that bundle's files.
// usage: node demo-src/pin-model.mjs <tag-or-commit>
//        node demo-src/pin-model.mjs --local <base-url> <onnx-dir> <webgpu-dir>   (testing before an upload; don't commit)
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const repo = 'spybyscript/scyllasband';
const FOLDERS = { wasm: 'onnx', webgpu: 'webgpu' };
// The engine reads the manifest and assets; ONNX Runtime needs the graphs and their shared weights. Paths are relative
// to the bundle folder.
const wanted = (p) => p === 'manifest.json' || p.startsWith('assets/') ||
  (p.startsWith('onnx/') && (p.endsWith('.onnx') || p.endsWith('shared_weights.bin')));
const summary = (files) => ({ bytes: files.reduce((a, f) => a + f.size, 0), files: files.sort((a, b) => a.path.localeCompare(b.path)) });

async function fromHub(ref) {
  const api = (path) => fetch(`https://huggingface.co/api/models/${repo}/${path}`).then((r) => {
    if (!r.ok) throw new Error(`${r.status} ${r.url}`);
    return r.json();
  });
  const { sha } = await api(`revision/${encodeURIComponent(ref)}`);
  const flavors = {};
  for (const [flavor, folder] of Object.entries(FOLDERS)) {
    const files = [];
    for (const entry of await api(`tree/${sha}/${folder}?recursive=true`)) {
      const path = entry.path.slice(folder.length + 1);
      if (entry.type !== 'file' || !wanted(path)) continue;
      const url = `https://huggingface.co/${repo}/resolve/${sha}/${entry.path}`;
      let sha256 = entry.lfs?.oid;
      if (!sha256) {  // small files aren't in LFS, so hash them here
        const body = new Uint8Array(await (await fetch(url)).arrayBuffer());
        sha256 = createHash('sha256').update(body).digest('hex');
      }
      files.push({ path, url, size: entry.lfs?.size ?? entry.size, sha256 });
    }
    flavors[flavor] = { folder, ...summary(files) };
  }
  const manifest = await (await fetch(`https://huggingface.co/${repo}/resolve/${sha}/onnx/manifest.json`)).json();
  return { repo, ref, revision: sha, model_version: manifest.model_version, contract_version: manifest.contract_version, flavors };
}

function fromDisk(base, dirs) {
  const walk = (dir) => readdirSync(dir).flatMap((n) => statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]);
  const flavors = {};
  for (const [flavor, dir] of Object.entries(dirs)) {
    const files = walk(dir).map((p) => relative(dir, p)).filter(wanted).map((path) => {
      const body = readFileSync(join(dir, path));
      return { path, url: `${base}${FOLDERS[flavor]}/${path}`, size: body.length, sha256: createHash('sha256').update(body).digest('hex') };
    });
    flavors[flavor] = { folder: FOLDERS[flavor], ...summary(files) };
  }
  const manifest = JSON.parse(readFileSync(join(dirs.wasm, 'manifest.json'), 'utf8'));
  return { repo, ref: 'local', revision: 'local000', model_version: manifest.model_version, contract_version: manifest.contract_version, flavors };
}

const args = process.argv.slice(2);
if (!args[0]) throw new Error('usage: node pin-model.mjs <tag-or-commit>');
const pinned = args[0] === '--local' ? fromDisk(args[1], { wasm: args[2], webgpu: args[3] }) : await fromHub(args[0]);
writeFileSync(new URL('../site/scyllasband/demo/model-files.json', import.meta.url), JSON.stringify(pinned, null, 1) + '\n');
for (const [flavor, f] of Object.entries(pinned.flavors)) console.log(`${flavor}: ${f.files.length} files, ${(f.bytes / 1e6).toFixed(1)} MB`);
console.log(`pinned ${repo}@${pinned.ref} = ${pinned.revision}`);
