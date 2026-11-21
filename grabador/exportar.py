"""Prepara los archivos que lee la app (carpeta web/).

  python -m grabador.exportar             -> genera web/ y escribe en web/cambiados.txt lo que hay que publicar
  python -m grabador.exportar --confirmar -> apunta en data/publicado.json que ya se publicó
"""
from __future__ import annotations

import hashlib
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / 'web'


def load(p, default):
    try:
        return json.loads(p.read_text())
    except Exception:
        return default


def build():
    files = {}
    index = {'actualizado': time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime()), 'circuitos': {},
             'estado': load(ROOT / 'data' / 'estado.json', {}),
             'detectados': load(ROOT / 'data' / 'circuitos_detectados.json', {})}
    for cdir in sorted((ROOT / 'data' / 'sesiones').glob('*')):
        days = {}
        for ddir in sorted(cdir.glob('*')):
            sess = []
            for f in sorted(ddir.glob('*.json')):
                s = load(f, None)
                if not s:
                    continue
                for st in s['stints']:
                    st.pop('ts', None)
                sess.append(s)
            if not sess:
                continue
            rel = f"datos/{cdir.name}/{ddir.name}.json"
            body = json.dumps(sess, ensure_ascii=False, separators=(',', ':'))
            files[rel] = body
            days[ddir.name] = {'n': len(sess), 'archivo': rel, 'hash': hashlib.sha1(body.encode()).hexdigest()[:12]}
        if days:
            nombre = load(next(cdir.rglob('*.json')), {}).get('circuit') or cdir.name
            index['circuitos'][cdir.name] = {'nombre': nombre, 'dias': days}
    # sesiones en curso (foto cada 10 min): se añaden a su día si aún no hay versión terminada
    for f in sorted((ROOT / 'data' / 'envivo').glob('*.json')):
        s = load(f, None)
        if not s or time.time() - f.stat().st_mtime > 6 * 3600:
            continue
        for st in s['stints']:
            st.pop('ts', None)
        rel = f"datos/{s['slug']}/{s['date']}.json"
        sess = json.loads(files[rel]) if rel in files else []
        if any(x['title'] == s['title'] and x['time'] == s['time'] for x in sess):
            continue
        sess.append(s)
        body = json.dumps(sess, ensure_ascii=False, separators=(',', ':'))
        files[rel] = body
        c = index['circuitos'].setdefault(s['slug'], {'nombre': s['circuit'], 'dias': {}})
        c['dias'][s['date']] = {'n': len(sess), 'archivo': rel, 'hash': hashlib.sha1(body.encode()).hexdigest()[:12]}
    files['datos/indice.json'] = json.dumps(index, ensure_ascii=False, separators=(',', ':'))
    return files


def main():
    files = build()
    published = load(ROOT / 'data' / 'publicado.json', {})
    changed = []
    for rel, body in files.items():
        h = hashlib.sha1(body.encode()).hexdigest()
        p = WEB / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(body)
        if published.get(rel) != h or rel == 'datos/indice.json':
            changed.append(rel)
    if '--confirmar' in sys.argv:
        for rel, body in files.items():
            published[rel] = hashlib.sha1(body.encode()).hexdigest()
        (ROOT / 'data' / 'publicado.json').write_text(json.dumps(published, indent=0))
        print('Publicación anotada.')
        return
    (WEB / 'cambiados.txt').write_text('\n'.join(changed))
    print(f'{len(changed)} archivos para publicar:')
    print('\n'.join(changed))


if __name__ == '__main__':
    main()
