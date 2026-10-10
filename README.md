# lowkeytea.dev

Company site for Lowkey Tea LLC. Plain static files with no build step, served free from Cloudflare.

```
site/                      ← publish this folder
  index.html               home: hero, Work (Scylla's Band), About, Contact
  privacy/index.html       privacy policy: website, email, Scylla's Band, app index
  support/index.html       support page (use as the App Store / Play "Support URL")
  scyllasband/demo/        in-browser Scylla's Band demo (the only page with JavaScript)
  404.html                 served for missing paths (see wrangler.jsonc)
  _headers                 security headers + font caching (Cloudflare _headers format)
  robots.txt, sitemap.xml
  favicon.svg
  assets/og.png            1200×630 social preview image
  assets/site.css
  assets/fonts/            Bricolage Grotesque (SIL OFL 1.1, see OFL.txt), self-hosted
demo-src/                  sources for the demo's engine build, model pin and a local preview server (not published)
wrangler.jsonc             Cloudflare Worker config: serves site/ as static assets
templates/
  app-privacy-policy.html  per-app privacy policy to copy when an app ships (not published)
previous-draft/            the first draft and its QA notes, kept for reference
```

The look follows the [Scylla's Band voice gallery](https://lowkeytea.github.io/scyllasband/): the same navy, red-to-teal stripe, cream offset shadows and outlined cards, with a dark mode that follows the visitor's system setting. Only the demo page uses JavaScript.

## Preview

```sh
node demo-src/serve.mjs 8080
```

Then open <http://127.0.0.1:8080>. This server applies `site/_headers` the way Cloudflare does, which the demo needs for multithreading. `python3 -m http.server --directory site` works for everything except the demo's threads. Use a server rather than opening files from disk. Folder links like `support/` open as directory listings from disk, and browsers refuse to run the demo from a `file://` page.

## Deploy (Cloudflare Workers, free plan)

The repo `lowkeytea/info` is connected to a Cloudflare Worker named `info` through Workers Builds, so every push to `main` deploys. There's no Worker script: `wrangler.jsonc` serves `site/` as static assets, with `site/_headers` applied, `site/404.html` for missing paths, and `/dir` redirecting to `/dir/`. The deploy command is plain `npx wrangler deploy`, with no build command.

- **Custom domain:** Workers & Pages → `info` → Settings → Domains & Routes → Add → Custom domain → `lowkeytea.dev`, then the same again for `www.lowkeytea.dev`. If there's already a DNS record for the name, delete it first under DNS → Records.
- **`workers.dev` address and preview URLs:** both are off (`"workers_dev": false`, `"preview_urls": false` in `wrangler.jsonc`). These are re-applied on every deploy, so change them there rather than in the dashboard.
- **Manual deploy:** `npx wrangler@4 deploy` from this folder, after `npx wrangler@4 login`.

Static asset requests are free and don't count against the Workers request limit. The largest file is ONNX Runtime's 14.2 MB WebAssembly binary for the demo (the per-file limit is 25 MiB), and the whole site is about 16 MB in 26 files. The model itself comes from Hugging Face, not Cloudflare.

## Apple organization migration

Things Apple checks for, and where the site covers them:

- **Legal entity name** matches the D-U-N-S record: "Lowkey Tea LLC" appears in the hero, the About facts, the footer and the privacy policy. If the D-U-N-S spelling differs, search and replace `Lowkey Tea LLC` across `site/`.
- **Website and email on the organization's own domain:** `https://lowkeytea.dev` and `info@lowkeytea.dev`. Cloudflare Email Routing forwards `info@lowkeytea.dev` to the Google Workspace inbox `info@lowkeytea.me`, and replies go out from the `.me` address.
- **Privacy Policy URL** for App Store Connect: `https://lowkeytea.dev/privacy/`, or a per-app page (below).
- **Support URL:** `https://lowkeytea.dev/support/`.

## Adding an app's privacy policy

1. Copy `templates/app-privacy-policy.html` to `site/apps/<app-slug>/privacy/index.html`.
2. Fill in every highlighted TODO so it matches what you declare in App Store Connect (App Privacy) and Google Play (Data safety). The comment at the top of the template lists the usual traps: SDKs, account deletion, children.
3. In `site/privacy/index.html`, replace "No Lowkey Tea apps are available right now." with a link to the new page.
4. To announce the app, add a card in the Work section of `site/index.html`.

## Editing notes

- The header, footer and logo symbol are repeated in each page (there's no build step to share them). Change all four pages when you change one.
- `_headers` sets a strict Content-Security-Policy (`'self'` only, no inline styles or scripts). If you add a third-party embed, analytics, or inline `style=""`, update the CSP or it will be blocked.
- Speed figures and platform details on the home page come from the Scylla's Band README and model card (release v2-20261006). Update them with new releases.

## Scylla's Band demo

`site/scyllasband/demo/` runs Scylla's Band in the visitor's browser, and nothing is hosted besides the page itself.

- **Model:** downloaded from Hugging Face on the visitor's click, at the exact commit and SHA-256 hashes listed in `model-files.json`. It's 261 MB, kept in Cache Storage and deletable from the page.
- **Engine:** `engine/scyllasband.wasm` is the unmodified `libscyllasband` C++ engine and text front end compiled with Emscripten. Its graph calls go to ONNX Runtime Web 1.30.0 (`ort/`, plain WASM build, MIT), running in `worker.js`.
- **Headers:** `_headers` gives `/scyllasband/demo/*` COOP/COEP (needed for threads) and removes the site-wide CSP; the page sets its own CSP in a `<meta>` tag.
- **Measured in desktop Chrome** (Ryzen 7 7800X3D, 4 threads, with a training job running on the same machine): about 5× faster than real time once loaded, and first sound after about 1 s. The first request after loading takes about 2 s while the graphs initialize. The native runtime is roughly 35× on a desktop CPU.

To update it:

- **New model release:** `node demo-src/pin-model.mjs <tag-or-commit>` rewrites `model-files.json`. Visitors' browsers drop the old files and download the new ones.
- **New runtime version:** `EMSDK=/path/to/emsdk demo-src/build-wasm.sh /path/to/scyllasband` rebuilds `engine/` from a checkout. `demo-src/scyllasband_graph_js.cpp` is the only code beyond the stock engine. It belongs upstream in `libscyllasband` eventually.
- **ONNX Runtime Web:** keep the `/wasm` build (`ort.wasm.min.mjs`). The default `onnxruntime-web` import (JSEP) gave wrong results with these graphs.

## Notes on what's linked

- Discord uses the permanent invite `discord.gg/mBhpn7WB5N` (no expiry, according to Discord's API). It appears in the Work link row, the Contact section and the Support page.
- Canonical URLs, `og:url`, `og:image` and `sitemap.xml` all point to `https://lowkeytea.dev`. If the domain changes, search and replace it across `site/`.
- `assets/og.png` was rendered from the hero styles. If the wordmark or tagline changes, re-render it at 1200×630.
- The privacy policy is written to match exactly what this site and Scylla's Band do. Have it reviewed before you rely on it for an app, and keep it accurate as things change.
