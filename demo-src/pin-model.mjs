// Pins the demo to one Hugging Face revision of the ONNX bundle: writes site/scyllasband/demo/model-files.json with
// the commit, and the URL, size and sha256 of every file the browser runtime needs.
// usage: node demo-src/pin-model.mjs <tag-or-commit>
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const repo = 'spybyscript/scyllasband';
const ref = process.argv[2];
if (!ref) throw new Error('usage: node pin-model.mjs <tag-or-commit>');
const api = (path) => fetch(`https://huggingface.co/api/models/${repo}/${path}`).then((r) => {
  if (!r.ok) throw new Error(`${r.status} ${r.url}`);
  return r.json();
});

const { sha } = await api(`revision/${encodeURIComponent(ref)}`);
const tree = await api(`tree/${sha}/onnx?recursive=true`);
// The engine reads the manifest and assets; ONNX Runtime needs the graphs and their shared weights.
const wanted = (p) => p === 'onnx/manifest.json' || p.startsWith('onnx/assets/') ||
  (p.startsWith('onnx/onnx/') && (p.endsWith('.onnx') || p.endsWith('shared_weights.bin')));

const files = [];
for (const entry of tree.filter((e) => e.type === 'file' && wanted(e.path))) {
  const url = `https://huggingface.co/${repo}/resolve/${sha}/${entry.path}`;
  let sha256 = entry.lfs?.oid;
  if (!sha256) {  // small files aren't in LFS, so hash them here
    const body = new Uint8Array(await (await fetch(url)).arrayBuffer());
    sha256 = createHash('sha256').update(body).digest('hex');
  }
  files.push({ path: entry.path.slice('onnx/'.length), url, size: entry.lfs?.size ?? entry.size, sha256 });
}
const manifest = await (await fetch(`https://huggingface.co/${repo}/resolve/${sha}/onnx/manifest.json`)).json();
const out = {
  repo, ref, revision: sha,
  model_version: manifest.model_version, contract_version: manifest.contract_version,
  bytes: files.reduce((a, f) => a + f.size, 0),
  files: files.sort((a, b) => a.path.localeCompare(b.path)),
};
writeFileSync(new URL('../site/scyllasband/demo/model-files.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
console.log(`pinned ${repo}@${ref} = ${sha}: ${files.length} files, ${(out.bytes / 1e6).toFixed(1)} MB`);
