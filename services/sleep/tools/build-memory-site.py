import json, html, hashlib, os, re, shutil
from datetime import datetime
from zoneinfo import ZoneInfo
LOCAL_ZONE = ZoneInfo(os.environ.get('ELEAGENT_TIMEZONE', 'America/Los_Angeles'))
d = json.load(open('data/memory.json'))
nodes = {n['id']: n for n in d['nodes']}
E = html.escape
def t(iso, fmt='%m-%d %H:%M'):
    return datetime.fromisoformat(iso).astimezone(LOCAL_ZONE).strftime(fmt) if iso else ''
shutil.rmtree('site', ignore_errors=True); os.makedirs('site/img')
def clipfile(name):
    p = f'data/clips/{name}'
    if not os.path.exists(p): return None
    h = hashlib.sha256(open(p, 'rb').read()).hexdigest()[:10]
    out = f'v-{h}.mp4'; shutil.copy(p, f'site/img/{out}'); return f'img/{out}'
def video(src, label):
    return f'<details class="clip"><summary>▶ {E(label)}</summary><video controls playsinline preload="none" src="{src}"></video></details>'
def diary_html(n):
    """Diary text with ⟦HH:MM⟧ anchors turned into inline players of the raw clip at that moment."""
    moments = {m.get('anchor'): m for m in (n.get('moments') or [])}
    parts, last = [], 0
    text = n.get('description', '') or ''
    for mt in re.finditer(r'⟦(\d{1,2}:\d{2}(?::\d{2})?)⟧', text):
        parts.append(E(text[last:mt.start()]))
        m = moments.get(mt.group(1)) or {}
        src = clipfile(m['clip']) if m.get('clip') else None
        parts.append(video(src, mt.group(1)) if src else f'<span class="muted">({E(mt.group(1))})</span>')
        last = mt.end()
    parts.append(E(text[last:]))
    return ''.join(parts)
def img(name):
    p = f'data/img/{name}'
    h = hashlib.sha256(open(p, 'rb').read()).hexdigest()[:10]
    out = f'c-{h}.jpg'; shutil.copy(p, f'site/img/{out}'); return f'img/{out}'
KIND = {'person': ('People', '#7cc4ff'), 'object': ('Objects', '#ffb86b'), 'place': ('Places', '#8be28b'), 'event': ('Events', '#d6a2ff'),
        'routine': ('Routines', '#f5e07a'), 'reading': ('Readings', '#7fe0d0'), 'conversation': ('Conversations', '#ff8fa3'), 'diary': ('Diary', '#c0c0c0')}
def links_of(nid):
    """Each link is only text: show the other entity and what the link says."""
    out = []
    for l in d['links']:
        if nid not in (l['a'], l['b']): continue
        other = l['b'] if l['a'] == nid else l['a']
        if other not in nodes: continue
        o = nodes[other]
        out.append(f'<div class="lk"><a href="#{E(other)}"><span class="dot" style="background:{KIND.get(o["kind"], ("", "#999"))[1]}"></span>{E(o["name"])}</a>'
                   f'<span class="muted"> {E((l.get("text") or "").replace(chr(10), " / "))}</span></div>')
    return ''.join(out)
def texts_of(n):
    t = n.get('texts')
    t = json.loads(t) if isinstance(t, str) else (t or [])
    if not t: return ''
    return '<details><summary>Read text (' + str(len(t)) + ' passages)</summary><div class="tr">' + ''.join(f'<div>{E(x)}</div>' for x in t) + '</div></details>'
def badge(k):
    name, color = KIND.get(k, (k, '#999'))
    return f'<span class="badge" style="border-color:{color};color:{color}">{name}</span>'
def span(n):
    a, b = t(n.get('t_start')), t(n.get('t_last'))
    return f'{a} – {b}' if a and b and a != b else a
fragments = dict(d['stats']).get('fragment', 0)
mem = [n for n in d['nodes'] if n['kind'] not in ('diary',)]
o = ['<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Eleagent memories</title><style>',
     ':root{--bg:#0e1014;--card:#171a21;--muted:#9aa3ad;--line:#262b34}body{margin:0;background:var(--bg);color:#e8e8e8;font:15px/1.65 -apple-system,system-ui,"PingFang SC",sans-serif}',
     'main{max-width:1000px;margin:auto;padding:28px 20px 60px}h1{font-size:24px;margin:0 0 4px}h2{font-size:18px;margin:40px 0 12px;color:#cfd6df}.muted{color:var(--muted)}',
     '.stats{display:flex;gap:12px;flex-wrap:wrap;margin:18px 0}.stat{background:var(--card);border-radius:12px;padding:10px 16px}.stat b{display:block;font-size:22px}',
     '.diary{background:var(--card);border-left:3px solid #c0c0c0;border-radius:10px;padding:14px 18px;white-space:pre-wrap}',
     '.clip{display:inline-block;margin:0 2px}.clip summary{display:inline;cursor:pointer;color:#7cc4ff;font-size:13px;background:#1f2633;border-radius:8px;padding:1px 7px;list-style:none}.clip[open]{display:block;margin:6px 0}.clip video{display:block;max-width:360px;width:100%;border-radius:8px;margin-top:6px;background:#000}',
     '.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px}.card{background:var(--card);border-radius:12px;padding:14px 16px;scroll-margin-top:12px}',
     '.card:target{outline:2px solid #7cc4ff}.card h3{margin:6px 0 4px;font-size:16px}.badge{display:inline-block;font-size:12px;border:1px solid;border-radius:10px;padding:0 8px}',
     '.covers{display:flex;gap:4px;flex-wrap:wrap;margin:10px 0 4px}.covers img{height:64px;border-radius:6px;background:#222}',
     '.lk{display:block;color:#b9c3cf;text-decoration:none;font-size:13px;margin-top:3px}.lk:hover{color:#fff}.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}',
     '.conv{background:var(--card);border-radius:12px;padding:14px 16px;margin:12px 0;scroll-margin-top:12px}.conv:target{outline:2px solid #ff8fa3}',
     'details{margin-top:8px}summary{cursor:pointer;color:var(--muted);font-size:13px}.tr{font-size:14px;margin-top:6px}.tr div{padding:2px 0;border-bottom:1px solid var(--line)}',
     '.tr .tm{color:var(--muted);font-variant-numeric:tabular-nums;margin-right:8px}.tr .sp{color:#ff8fa3;margin-right:6px}</style><main>',
     '<h1>Eleagent memories</h1><div class="muted">Consolidated memories · Exported at ' + t(d['exported_at'], '%Y-%m-%d %H:%M') + ' (local time)</div>',
     f'<div class="stats"><div class="stat"><b>{len(mem)}</b> memories</div><div class="stat"><b>{sum(1 for n in mem if n["kind"]=="conversation")}</b> conversations</div>'
     f'<div class="stat"><b>{len(d["links"])}</b> links</div><div class="stat"><b>{fragments}</b> pending fragments<br><span class="muted" style="font-size:12px">From recent captures awaiting consolidation</span></div></div>']
for n in [n for n in d['nodes'] if n['kind'] == 'diary']:
    o.append(f'<h2 id="{E(n["id"])}">Diary · {E(n["name"])}</h2><div class="diary">{diary_html(n)}</div>')
for kind in ('person', 'object', 'place', 'event', 'routine', 'reading'):
    items = sorted([n for n in mem if n['kind'] == kind], key=lambda n: -int(n.get('occurrences') or 0))
    if not items: continue
    o.append(f'<h2>{KIND[kind][0]}</h2><div class="grid">')
    for n in items:
        covers = ''.join(f'<img loading="lazy" src="{img(c)}">' for c in n.get('covers', []))
        o.append(f'<div class="card" id="{E(n["id"])}">{badge(kind)} <span class="muted" style="font-size:12px">Seen {n.get("occurrences", 0)} times · {span(n)}</span>'
                 f'<h3>{E(n["name"])}</h3><div>{E(n.get("description", ""))}</div>' + (f'<div class="covers">{covers}</div>' if covers else '') + texts_of(n) + links_of(n['id']) + '</div>')
    o.append('</div>')
o.append('<h2>Conversations</h2>')
for n in sorted([n for n in mem if n['kind'] == 'conversation'], key=lambda n: n.get('t_start', '')):
    tr = json.loads(n['transcript']) if isinstance(n.get('transcript'), str) else (n.get('transcript') or [])
    lines = ''.join(f'<div><span class="tm">{t(l["t"], "%H:%M:%S")}</span><span class="sp">{E(l["speaker"] if l["speaker"] != "unknown" else "Unknown voice")}</span>{E(l["text"])}</div>' for l in tr)
    o.append(f'<div class="conv" id="{E(n["id"])}">{badge("conversation")} <span class="muted" style="font-size:12px">{span(n)} · {len(tr)} lines · {round(float(n.get("duration_s") or 0))} seconds of speech</span>'
             f'<h3 style="margin:6px 0 4px">{E(n["name"])}</h3><div>{E(n.get("summary", ""))}</div>{links_of(n["id"])}'
             + (video(clipfile(n['clip']), 'Original clip (first 5 seconds)') if n.get('clip') and clipfile(n['clip']) else '') + f'<details><summary>Full transcript</summary><div class="tr">{lines}</div></details></div>')
o.append('</main>')
open('site/index.html', 'w').write('\n'.join(o))
print('ok', len(os.listdir('site/img')), 'images')
