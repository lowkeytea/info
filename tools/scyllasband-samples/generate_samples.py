#!/usr/bin/env python3
"""Render the Scylla's Band sample page (site/scyllasband/samples/index.html) and its audio/ folder.

    PYTHONPATH=/path/to/scyllasband python tools/scyllasband-samples/generate_samples.py \
        --runtime-repo /path/to/scyllasband --bundle /path/to/litert --pieces /path/to/rendered/pieces

Every speech clip and sung excerpt goes through the public runtime with the script's seed, sampler and steps; the pieces
(Face Down, Bubble Wrap, Thank You for Participating, Ghost in the Machine) are rendered first with the runtime repository's
examples/ghost_in_the_machine/make_track.py and read from --pieces/<id>/<id>.wav. Rendered WAVs are cached in --work, so a
page change re-encodes nothing and a script change re-renders only the clips named with --only (or missing ones).
MP3 encoding uses ffmpeg.
"""
from __future__ import annotations

import argparse
from html import escape
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import wave

import numpy as np

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
REPO_URL = "https://github.com/lowkeytea/scyllasband"
MODEL_URL = "https://huggingface.co/spybyscript/scyllasband"
LOCALE_NAMES = {"en_us": "English (US)", "en_gb": "English (UK)", "es": "Spanish", "it": "Italian", "fr": "French",
                "de": "German", "vi": "Vietnamese"}
KIND_NAMES = {"pop": "Pop", "rap": "Talk-sung", "ballad": "Ballad"}


def read_wav(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as handle:
        rate, frames = handle.getframerate(), handle.readframes(handle.getnframes())
        width, channels = handle.getsampwidth(), handle.getnchannels()
    audio = np.frombuffer(frames, dtype={2: np.int16, 4: np.int32}[width]).astype(np.float32) / (2 ** (8 * width - 1))
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    return audio, rate


def write_wav(path: Path, audio: np.ndarray, rate: int) -> None:
    data = (np.clip(audio, -1, 1) * 32767).astype(np.int16)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1); handle.setsampwidth(2); handle.setframerate(rate); handle.writeframes(data.tobytes())


def duration(seconds: float) -> str:
    return f"{int(seconds // 60)}:{int(round(seconds % 60)):02d}"


class Clips:
    """Renders on demand, caches WAVs in work/, encodes MP3s into audio/."""

    def __init__(self, args, script):
        self.args, self.script = args, script
        self.work, self.audio = args.work, args.site / "audio"
        self.work.mkdir(parents=True, exist_ok=True); self.audio.mkdir(parents=True, exist_ok=True)
        self.only = set(args.only.split(",")) if args.only else set()
        self._runtime = None
        self.produced: set[str] = set()

    @property
    def runtime(self):
        if self._runtime is None:
            from scyllasband.native import open_runtime
            self._runtime = open_runtime(self.args.bundle, engine=self.args.engine, backend=self.args.backend, threads=self.args.threads)
        return self._runtime

    @property
    def options(self) -> dict:
        return dict(seed=self.script["seed"], steps=self.script["steps"], sampler=self.script["sampler"])

    def clip(self, name: str, produce, *, bitrate: str = "96k") -> dict:
        wav = self.work / f"{name}.wav"
        if not wav.is_file() or name in self.only:
            if self.args.page_only:
                raise SystemExit(f"{name}: no cached render in {self.work} (run without --page-only)")
            audio, rate = produce()
            write_wav(wav, audio, rate)
            print(f"rendered {name} ({len(audio) / rate:.1f} s)", flush=True)
        mp3 = self.audio / f"{name}.mp3"
        if not mp3.is_file() or mp3.stat().st_mtime < wav.stat().st_mtime:
            subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(wav), "-codec:a", "libmp3lame", "-b:a", bitrate, str(mp3)], check=True)
        self.produced.add(mp3.name)
        audio, rate = read_wav(wav)
        return dict(src=f"audio/{name}.mp3", seconds=len(audio) / rate)

    def speak(self, name: str, text: str, voice: str, language: str, delivery: str | None = None) -> dict:
        from scyllasband import SynthesisRequest

        def produce():
            result = self.runtime.synthesize(SynthesisRequest(text=text, voice_id=voice, language=language, delivery=delivery, **self.options))
            return result.audio, result.sample_rate
        return self.clip(name, produce)

    def records(self, name: str, records: list[dict], pause_ms: float, *, bitrate: str = "96k") -> dict:
        def produce():
            result = self.runtime.render_records(records, pause_ms=pause_ms, **self.options)
            return result.audio, result.sample_rate
        return self.clip(name, produce, bitrate=bitrate)

    def sing(self, name: str, score: Path, voice: str, transpose: int = 0) -> dict:
        def produce():
            result = self.runtime.sing(json.loads(score.read_text(encoding="utf-8")), voice, seed=self.script["sing_seed"], transpose=transpose)
            return result.audio, result.sample_rate
        return self.clip(name, produce, bitrate="128k")

    def copy(self, name: str, source: Path) -> dict:
        def produce():
            return read_wav(source)
        return self.clip(name, produce, bitrate="128k")


def scene_records(text: str, voice: str, language: str):
    from scyllasband.planner import parse_group_lines
    return parse_group_lines(text, default_voice=voice, default_language=language)


def long_form_records(item: dict, repo: Path):
    from scyllasband.planner import parse_group_lines, records_from_text
    text = (repo / item["file"]).read_text(encoding="utf-8")
    if item.get("group"):
        return parse_group_lines(text, default_voice=None, default_language=None)
    return records_from_text(text, voice=item["voice"], language=item["language"], delivery=item["delivery"])


def piece_context(piece: dict, args) -> dict:
    """Duration, voices and the 'how it was made' snippets for a piece rendered with make_track.py."""
    folder = args.runtime_repo / "examples" / piece["id"]
    sheet = json.loads((args.pieces / piece["id"] / f"{piece['id']}.cues.json").read_text(encoding="utf-8"))
    script = json.loads((folder / "script.json").read_text(encoding="utf-8"))
    voices = list(dict.fromkeys(v for cue in script["cues"] for v in ([cue["voice"]] if cue["type"] == "speak" else cue["voices"])))
    sung = [cue for cue in script["cues"] if cue["type"] == "sing"]
    words = len(re.findall(r"\w+", " ".join(cue["text"] for cue in sheet["cues"])))
    source = folder / "score.txt"
    if source.is_file():
        lines = [l for l in source.read_text(encoding="utf-8").splitlines() if l.strip() and not l.startswith("#")]
        start = next(i for i, l in enumerate(lines) if l.startswith("[" + Path(sung[-1]["score"]).stem + "]"))
        snippet, snippet_name = "\n".join(lines[start:start + 5]), "score.txt"
    else:
        score = json.loads((folder / sung[-1]["score"]).read_text(encoding="utf-8"))
        snippet = json.dumps(dict(text=score["text"], bpm=score["bpm"], style=score["style"]), indent=1)[:-2] + ',\n "notes": [\n  ' + \
            ", ".join(json.dumps(n) for n in score["notes"][:8]) + ", ...\n ]\n}"
        snippet_name = sung[-1]["score"]
    cue = {k: v for k, v in sung[-1].items()}
    return dict(piece, seconds=sheet["seconds"], voices=voices, words=words, cues=len(script["cues"]), sung_cues=len(sung),
                snippet=snippet, snippet_name=snippet_name, cue=json.dumps(cue), folder=f"{REPO_URL}/tree/main/examples/{piece['id']}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--script", type=Path, default=HERE / "samples_script.json")
    parser.add_argument("--site", type=Path, default=REPO / "site" / "scyllasband" / "samples")
    parser.add_argument("--work", type=Path, default=HERE / "work", help="rendered WAV cache (not published)")
    parser.add_argument("--runtime-repo", type=Path, required=True, help="scyllasband checkout (texts, example scores)")
    parser.add_argument("--pieces", type=Path, required=True, help="make_track.py outputs: <dir>/<piece>/<piece>.wav and .cues.json")
    parser.add_argument("--bundle", type=Path, help="model bundle (needed to render; the page alone needs the cache)")
    parser.add_argument("--backend", default="litert")
    parser.add_argument("--engine", default=None)
    parser.add_argument("--threads", type=int, default=8)
    parser.add_argument("--only", help="comma-separated clip names to re-render")
    parser.add_argument("--page-only", action="store_true", help="write the page from cached renders, render nothing")
    args = parser.parse_args()
    sys.path.insert(0, str(args.runtime_repo))

    script = json.loads(args.script.read_text(encoding="utf-8"))
    clips = Clips(args, script)
    repo = args.runtime_repo

    voices = []
    for scene in sorted((HERE / "scenes").glob("*.txt")):
        voice, text = scene.stem, scene.read_text(encoding="utf-8")
        locale = re.match(r"\[(\w+):(\w+)", text).group(2)
        hello_text = script["hello"].format(name=voice.title())
        sung_group = next(g for g in script["sung"].values() if voice in g["voices"])
        voices.append(dict(id=voice, name=voice.title(), locale=locale, locale_name=LOCALE_NAMES[locale],
                           hello=dict(text=hello_text, **clips.speak(f"{voice}_hello", hello_text, voice, locale)),
                           scene=dict(text=text, words=len(re.findall(r"\w+", re.sub(r"\[[^\]]*\]", "", text))),
                                      **clips.records(f"{voice}_scene", scene_records(text, voice, locale), script["scene_pause_ms"])),
                           sung=dict(title=sung_group["title"], **clips.sing(f"{voice}_sings", repo / sung_group["score"], voice, sung_group["transpose"]))))

    long_form = []
    for item in script["long_form"]:
        records = long_form_records(item, repo)
        long_form.append(dict(item, words=len(re.findall(r"\w+", " ".join(r["text"] for r in records))),
                              voices=list(dict.fromkeys(r["voice"] for r in records)), locales=list(dict.fromkeys(r["language"] for r in records)),
                              source=f"{REPO_URL}/blob/main/{item['file']}", **clips.records(item["id"], records, item.get("pause_ms", 0.0))))
    montage_voice = script["languages_voice"]
    montage_locale = next(v["locale"] for v in voices if v["id"] == montage_voice)
    montage_records = [dict(voice=montage_voice, language=(montage_locale if l["id"] == "en" else l["id"]), text=l["line"], delivery=None)
                       for l in script["languages"]]
    montage = dict(id="languages", title="One voice, six languages", voices=[montage_voice], words=len(re.findall(r"\w+", " ".join(l["line"] for l in script["languages"]))),
                   locales=[r["language"] for r in montage_records], source=None,
                   summary=f"{montage_voice.title()} reads the same line in {', '.join(l['name'] for l in script['languages'][:-1])} and {script['languages'][-1]['name']}, half a second apart.",
                   **clips.records("languages", montage_records, 500))
    long_form.append(montage)

    pieces = []
    for piece in script["pieces"]:
        pieces.append(dict(piece_context(piece, args), **clips.copy(piece["id"], args.pieces / piece["id"] / f"{piece['id']}.wav")))
    patter = script["patter"]
    patter = dict(patter, folder=f"{REPO_URL}/tree/main/examples/{patter['id']}",
                  **clips.sing(patter["id"], repo / patter["score"], patter["voice"]))


    for stale in clips.audio.glob("*.mp3"):
        if stale.name not in clips.produced:
            stale.unlink()
    from scyllasband.contract import validate_bundle_layout
    release = validate_bundle_layout(args.bundle)["release"] if args.bundle else "(cached)"
    total = len(voices) * 3 + len(pieces) + 1 + len(long_form)
    page = render_page(dict(script=script, voices=voices, pieces=pieces, patter=patter, long_form=long_form, release=release, total=total,
                            sprite=sprite()))
    (args.site / "index.html").write_text(page, encoding="utf-8")
    print(f"wrote {args.site / 'index.html'}: {total} clips, release {release}")
    return 0


def sprite() -> str:
    demo = (REPO / "site" / "scyllasband" / "demo" / "index.html").read_text(encoding="utf-8")
    return re.search(r'<svg class="sprite".*?</svg>', demo, re.S).group(0)


def audio_tag(src: str, label: str) -> str:
    return f'<audio controls preload="none" src="{escape(src)}" aria-label="{escape(label)}"></audio>'


def render_page(ctx: dict) -> str:
    voices, script = ctx["voices"], ctx["script"]
    piece_cards = []
    for p in ctx["pieces"]:
        piece_cards.append(f'''
        <article class="piece piece-{p["kind"]}" id="{p["id"]}">
          <p class="kicker">{KIND_NAMES[p["kind"]]} &middot; {duration(p["seconds"])}</p>
          <h3>{escape(p["title"])}</h3>
          <p class="meta">{" &middot; ".join(v.title() for v in p["voices"])} &middot; {p["words"]} words &middot; {p["cues"]} cues, {p["sung_cues"]} sung</p>
          <p class="blurb">{escape(p["summary"])}</p>
          {audio_tag(p["src"], p["title"])}
          <details class="how">
            <summary>How it was made</summary>
            <p>The lyric is written as a score, one note per syllable with its pitch and length in beats; the runtime plans the phones
              onto the notes and sings them. The cues (spoken lines and sung sections, with their voices, seeds and gaps) are listed in
              a script and placed on a timeline by <code>make_track.py</code>; a doubled chorus is the same score rendered per voice,
              aligned note by note onto the lead and summed.</p>
            <p class="snippet-name">{escape(p["snippet_name"])}</p>
            <pre>{escape(p["snippet"])}</pre>
            <p class="snippet-name">script.json, the last sung cue</p>
            <pre>{escape(p["cue"])}</pre>
            <a class="text-link" href="{p["folder"]}">The whole piece, step by step &rarr;</a>
          </details>
        </article>''')
    patter = ctx["patter"]
    piece_cards.append(f'''
        <article class="piece piece-rap" id="{patter["id"]}">
          <p class="kicker">Patter &middot; {duration(patter["seconds"])}</p>
          <h3>{escape(patter["title"])}</h3>
          <p class="meta">{patter["voice"].title()} &middot; one score, one command</p>
          <p class="blurb">{escape(patter["summary"])}</p>
          {audio_tag(patter["src"], patter["title"])}
          <details class="how">
            <summary>How it was made</summary>
            <pre>python -m scyllasband sing --score examples/kitchen_patter/melody.json --voice tuesday -o kitchen_patter.wav</pre>
            <a class="text-link" href="{patter["folder"]}">The score and its rules &rarr;</a>
          </details>
        </article>''')

    long_cards = []
    for item in ctx["long_form"]:
        who = item["voices"][0].title() if len(item["voices"]) == 1 else f'{len(item["voices"])} voices'
        where = " &middot; ".join(LOCALE_NAMES.get(l, l) for l in item["locales"])
        source = f'<a class="text-link" href="{item["source"]}">Read the source text &rarr;</a>' if item.get("source") else ""
        long_cards.append(f'''
        <article class="piece piece-long" id="{item["id"]}">
          <p class="kicker">Speech &middot; {duration(item["seconds"])}</p>
          <h3>{escape(item["title"])}</h3>
          <p class="meta">{who} &middot; {where} &middot; {item["words"]} words</p>
          <p class="blurb">{escape(item["summary"])}</p>
          {audio_tag(item["src"], item["title"])}
          {source}
        </article>''')

    voice_cards = []
    for v in voices:
        scene_html = "<br>".join(escape(re.sub(r"^\[[^\]]*\]\s*", "", line)) for line in v["scene"]["text"].splitlines() if line.strip())
        voice_cards.append(f'''
        <article class="voice" id="{v["id"]}">
          <div class="voice-head"><h3>{v["name"]}</h3><span>{v["locale_name"]}</span></div>
          <div class="row">
            <p class="label">Hello <span>{duration(v["hello"]["seconds"])}</span></p>
            {audio_tag(v["hello"]["src"], f'{v["name"]} says hello')}
          </div>
          <div class="row">
            <p class="label">A scene <span>{duration(v["scene"]["seconds"])} &middot; {v["scene"]["words"]} words, the delivery changing line by line</span></p>
            {audio_tag(v["scene"]["src"], f'{v["name"]}, a scene')}
            <details class="scene-text"><summary>The lines</summary><p>{scene_html}</p></details>
          </div>
          <div class="row">
            <p class="label">Singing <span>{duration(v["sung"]["seconds"])} &middot; {escape(v["sung"]["title"])}</span></p>
            {audio_tag(v["sung"]["src"], f'{v["name"]} sings')}
          </div>
          <a class="try" href="../demo/?voice={v["id"]}">Type something for {v["name"]} &rarr;</a>
        </article>''')

    languages = ", ".join(l["name"] for l in script["languages"][:-1]) + " and " + script["languages"][-1]["name"]
    return f'''<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; media-src 'self'; img-src 'self' data:; style-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'">
  <title>Scylla's Band voice samples · Lowkey Tea LLC</title>
  <meta name="description" content="Hear Scylla's Band's fourteen voices: a hello, a scene and a sung chorus from each, four songs built from scores, and long-form speech in six languages.">
  <meta name="color-scheme" content="light dark">
  <meta name="theme-color" content="#fff7e8" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#0c1f33" media="(prefers-color-scheme: dark)">
  <link rel="canonical" href="https://lowkeytea.dev/scyllasband/samples/">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Lowkey Tea LLC">
  <meta property="og:title" content="Scylla's Band voice samples">
  <meta property="og:description" content="Fourteen voices: a hello, a scene and a sung chorus from each, plus four songs built from scores.">
  <meta property="og:url" content="https://lowkeytea.dev/scyllasband/samples/">
  <meta property="og:image" content="https://lowkeytea.dev/assets/og.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="Lowkey Tea LLC wordmark and mug logo on a cream background">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="icon" href="../../favicon.svg" type="image/svg+xml">
  <link rel="preload" href="../../assets/fonts/bricolage-latin.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="../../assets/site.css">
  <link rel="stylesheet" href="samples.css">
</head>
<body>
  <a class="skip" href="#main">Skip to content</a>

  <header class="site-header">
    <div class="shell header-row">
      <a class="brand" href="../../" aria-label="Lowkey Tea, home">
        <svg class="brand-mark" viewBox="0 0 48 48" aria-hidden="true"><use href="#mark"/></svg>
        <span class="brand-name">Lowkey Tea</span>
      </a>
      <nav aria-label="Main">
        <a href="../../#work">Work</a>
        <a href="../../#about">About</a>
        <a href="../../support/">Support</a>
        <a href="../../#contact">Contact</a>
      </nav>
    </div>
  </header>

  <main id="main" class="doc shell" tabindex="-1">
    <div class="doc-head">
      <div class="stripe" aria-hidden="true"></div>
      <p class="eyebrow">Scylla&rsquo;s Band</p>
      <h1>Voice samples</h1>
      <p class="lede">Fourteen voices, each saying hello, playing a scene and singing a chorus; four songs built from scores; and long-form
        speech in {escape(languages)}. Everything here came out of the runtime as published, on a CPU.</p>
      <ul class="chips" aria-label="At a glance">
        <li><strong>{len(voices)}</strong> voices</li>
        <li><strong>{len(script["languages"])}</strong> languages</li>
        <li><strong>{ctx["total"]}</strong> clips</li>
        <li><strong>24 kHz</strong> output</li>
      </ul>
      <div class="actions">
        <a class="button" href="../demo/">Try it in your browser <span aria-hidden="true">&rarr;</span></a>
        <p class="link-row"><a href="{REPO_URL}">GitHub</a><a href="{MODEL_URL}">Hugging Face</a></p>
      </div>
    </div>
    <nav class="section-nav" aria-label="Sections">
      <a href="#songs">Songs</a><a href="#speech">Speech</a><a href="#voices">Voices</a>{"".join(f'<a href="#{v["id"]}">{v["name"]}</a>' for v in voices)}
    </nav>

    <section id="songs" class="block">
      <div class="section-head">
        <h2>Songs</h2>
        <p>The model never free-sings: every note was written down first. Each song is a set of scores and a cue script, and
          <em>How it was made</em> under each one shows the score lines and the cue that produced what you hear.</p>
      </div>
      <div class="pieces">{"".join(piece_cards)}
      </div>
    </section>

    <section id="speech" class="block">
      <div class="section-head">
        <h2>Speech</h2>
        <p>Whole texts, spoken as passages of up to about nine seconds. Each passage sees the text around it and continues from the
          sound of the one before it.</p>
      </div>
      <div class="pieces">{"".join(long_cards)}
      </div>
    </section>

    <section id="voices" class="block">
      <div class="section-head">
        <h2>The voices</h2>
        <p>Three clips each: the voice as it is, a scene of a few lines where the intensity and pace change from line to line (the
          emotion itself comes from the words), and a chorus from one of the songs above. For any other words, languages or
          settings, the demo runs the same model in your browser.</p>
      </div>
      <div class="voices">{"".join(voice_cards)}
      </div>
    </section>

    <p class="render-note">Rendered with the default LiteRT bundle of release {escape(ctx["release"])} on a desktop CPU: speech with
      {script["sampler"].title()} sampling, {script["steps"]} steps and seed {script["seed"]}; singing with the bundle's singing setting.
      Audio loads when you press play.</p>
  </main>

  <footer class="site-footer">
    <div class="shell footer-row">
      <p>&copy; 2026 Lowkey Tea LLC &middot; Washington, United States</p>
      <nav aria-label="Footer">
        <a href="../../privacy/">Privacy</a>
        <a href="../../support/">Support</a>
        <a href="https://github.com/lowkeytea">GitHub</a>
      </nav>
    </div>
  </footer>

  {ctx["sprite"]}
</body>
</html>
'''


if __name__ == "__main__":
    sys.exit(main())
