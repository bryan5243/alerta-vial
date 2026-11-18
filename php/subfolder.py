#!/usr/bin/env python3
"""Adapta la carpeta armada (php/dist-cpanel) para que funcione dentro de una subcarpeta, por ejemplo /alertavial.
Las direcciones que empiezan en "/" (/css/app.css, /api/...) pasan a empezar en /alertavial/."""
import re, sys, pathlib
base = sys.argv[2].rstrip('/'); root = pathlib.Path(sys.argv[1])
if not base.startswith('/'): base = '/' + base
ROOTS = r'(api|css|js|img|vendor|admin|manifest\.webmanifest|sw\.js)'
n = 0
for f in root.rglob('*'):
    if not f.is_file() or f.suffix not in ('.html', '.js', '.css', '.webmanifest') or 'vendor' in f.relative_to(root).parts: continue
    s = f.read_text(encoding='utf-8'); o = s
    s = re.sub(r'(["\'`])/' + ROOTS, lambda m: f'{m.group(1)}{base}/{m.group(2)}', s)
    if f.suffix == '.css': s = re.sub(r'\(/' + ROOTS, lambda m: f'({base}/{m.group(1)}', s)
    s = s.replace('href="/"', f'href="{base}/"').replace("href='/'", f"href='{base}/'")
    if f.name == 'sw.js': s = s.replace("'/'", f"'{base}/'").replace("'/index.html'", f"'{base}/index.html'")
    if f.suffix == '.webmanifest': s = s.replace('"start_url": "/?app=1"', f'"start_url": "{base}/?app=1"').replace('"scope": "/"', f'"scope": "{base}/"')
    s = s.replace('${esc(location.origin)}/', '${esc(location.origin)}' + base + '/')
    if s != o: f.write_text(s, encoding='utf-8'); n += 1
print(f'Subcarpeta {base}: {n} archivos adaptados')
