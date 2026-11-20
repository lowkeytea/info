"""Build the Hugging Face Space copy of the Scylla's Band browser demo from a website checkout.

usage: python demo-src/build-space.py site <checkout of the Space spybyscript/scyllasband>
Copies the demo page, the site stylesheet, fonts and favicon, and points the page's site-relative links at lowkeytea.dev.
The Space's README.md (its config: `sdk: static`, and COOP/COEP/CORP through `custom_headers`, which threads need) is kept;
everything else in the folder is replaced.
"""
import re
import shutil
import sys
from pathlib import Path

site, out = Path(sys.argv[1]), Path(sys.argv[2])
demo = site / 'scyllasband' / 'demo'
for entry in out.iterdir():
    if entry.name in ('README.md', '.git', '.gitattributes'):
        continue
    shutil.rmtree(entry) if entry.is_dir() else entry.unlink()
shutil.copytree(demo, out, dirs_exist_ok=True, ignore=shutil.ignore_patterns('file-check.js'))
(out / 'assets' / 'fonts').mkdir(parents=True, exist_ok=True)
shutil.copy2(site / 'assets' / 'site.css', out / 'assets' / 'site.css')
for font in (site / 'assets' / 'fonts').iterdir():
    shutil.copy2(font, out / 'assets' / 'fonts' / font.name)
shutil.copy2(site / 'favicon.svg', out / 'favicon.svg')

page = out / 'index.html'
html = page.read_text(encoding='utf8')
for line in ('  <link rel="canonical" href="https://lowkeytea.dev/scyllasband/demo/">\n',
             '  <meta property="og:url" content="https://lowkeytea.dev/scyllasband/demo/">\n',
             '  <script src="file-check.js"></script>\n'):
    assert line in html, line
    html = html.replace(line, '')
html = html.replace('href="../../favicon.svg"', 'href="favicon.svg"').replace('href="../../assets/', 'href="assets/')
html = re.sub(r'href="\.\./\.\./([^"]*)"', r'href="https://lowkeytea.dev/\1"', html)
html = re.sub(r'href="\.\./([^"]*)"', r'href="https://lowkeytea.dev/scyllasband/\1"', html)
# Binary files in a Space are served by a redirect to the Hub's file CDN, so the fonts come from there.
assert html.count("font-src 'self';") == 1
html = html.replace("font-src 'self';", "font-src 'self' https://*.hf.co;")
assert '../' not in html, 'a relative link is left'
# The Space page shows the demo in a sandboxed iframe that may open pop-ups but not navigate the top page, and
# lowkeytea.dev, GitHub and the Hub refuse to be framed, so links off the Space open in a new tab.
html, linked = re.subn(r'<a ((?:class="[^"]*" )?)href="(https://[^"]+)"(?![^>]*\btarget=)',
                       r'<a \1href="\2" target="_blank" rel="noopener"', html)
for tag in re.findall(r'<a [^>]*href="https://[^>]*>', html):
    assert 'target="_blank"' in tag, f'an outside link opens in the frame: {tag}'
print('outside links opening in a new tab:', linked)
page.write_text(html, encoding='utf8')
print('built', out, sum(1 for p in out.rglob('*') if p.is_file()), 'files')
