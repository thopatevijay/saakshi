"""Pull the voiceover text out of DEMO_SCRIPT.md, one file per section.

Only blockquotes that follow a `**Voiceover**` line count — the constraints blockquote at the top of
the script is not narration and must never reach the TTS.
"""
import re, sys, pathlib

src = pathlib.Path('demo-video/DEMO_SCRIPT.md').read_text()
out = pathlib.Path('demo-video/audio'); out.mkdir(parents=True, exist_ok=True)

sections, current, in_vo = [], None, False
for line in src.split('\n'):
    m = re.match(r'^## Section (\d+) · (.+?) \(', line)
    if m:
        current = {'n': int(m.group(1)), 'title': m.group(2), 'lines': []}
        sections.append(current); in_vo = False; continue
    if line.strip() == '**Voiceover**':
        in_vo = True; continue
    if in_vo and line.startswith('**Screen actions**'):
        in_vo = False; continue
    if in_vo and current is not None and line.startswith('>'):
        current['lines'].append(line.lstrip('>').strip())

total = 0
for s in sections:
    # Blank lines inside the quote become paragraph breaks; TTS reads those as a natural pause.
    text = '\n\n'.join(p.strip() for p in '\n'.join(s['lines']).split('\n\n') if p.strip())
    text = text.replace('**', '').replace('*', '')
    words = len(text.split())
    total += words
    path = out / f"section-{s['n']}.txt"
    path.write_text(text)
    print(f"  section {s['n']}  {words:>3} words  ~{words/140*60:>5.1f}s  {s['title'][:44]}")
print(f"  ---\n  TOTAL {total} words  ~{total/140*60:.0f}s  ({total/140*60/60:.2f} min)")
