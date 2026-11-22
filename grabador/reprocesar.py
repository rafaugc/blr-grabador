"""Vuelve a procesar la copia en bruto de un turno de grabación.

  python -m grabador.reprocesar raw_dir --circuitos karting-cabanillas [--volcar karting-cabanillas 10:00 12:00]

- Recupera sesiones que no estén ya guardadas (mismo título y horas que se solapan = ya existe).
- --volcar guarda en data/muestras/ los mensajes en bruto de un circuito entre dos horas (UTC), para analizarlos.
"""
from __future__ import annotations

import argparse
import gzip
import json
import time
from datetime import datetime, timezone
from pathlib import Path

from .apex import ApexState

ROOT = Path(__file__).resolve().parent.parent


def span(s):
    ts = [t for st in s['stints'] for t in st.get('ts', [])]
    return (min(ts), max(ts)) if ts else (0, 0)


def exists_like(s):
    d = ROOT / 'data' / 'sesiones' / s['slug'] / s['date']
    a0, a1 = span(s)
    for f in d.glob('*.json') if d.exists() else []:
        try:
            o = json.loads(f.read_text())
        except Exception:
            continue
        b0, b1 = span(o)
        if o.get('title') == s['title'] and min(a1, b1) - max(a0, b0) > 0:
            return f
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('raw_dir')
    ap.add_argument('--circuitos', nargs='*', default=[])
    ap.add_argument('--volcar', nargs=3, metavar=('SLUG', 'DESDE', 'HASTA'))
    ap.add_argument('--reemplazar', action='store_true', help='sustituir sesiones ya guardadas por la versión reprocesada')
    a = ap.parse_args()
    circuits = {c['slug']: c for c in json.loads((ROOT / 'circuitos.json').read_text())}
    files = sorted(Path(a.raw_dir).rglob('*.jsonl.gz'))
    print(f'{len(files)} archivos en bruto')
    if a.volcar:
        slug, t0, t1 = a.volcar
        out = ROOT / 'data' / 'muestras' / f'bruto_{slug}_{t0.replace(":", "")}-{t1.replace(":", "")}.jsonl.gz'
        out.parent.mkdir(parents=True, exist_ok=True)
        n = 0
        with gzip.open(out, 'wt', encoding='utf-8') as w:
            for f in files:
                if not f.name.startswith(slug + '_'):
                    continue
                for line in gzip.open(f, 'rt', encoding='utf-8', errors='replace'):
                    try:
                        ts, msg = json.loads(line)
                    except Exception:
                        continue
                    hm = datetime.fromtimestamp(ts, timezone.utc).strftime('%H:%M')
                    if t0 <= hm <= t1:
                        w.write(line)
                        n += 1
        print(f'Volcado {n} mensajes en {out}')
    for slug in a.circuitos:
        c = circuits.get(slug, {'slug': slug, 'nombre': slug})
        state = ApexState(slug, c['nombre'], c.get('tz', 'Europe/Madrid'))
        got = []
        for f in files:
            if not f.name.startswith(slug + '_'):
                continue
            last = 0
            for line in gzip.open(f, 'rt', encoding='utf-8', errors='replace'):
                try:
                    ts, msg = json.loads(line)
                except Exception:
                    continue
                state.feed(msg, ts)
                if ts - last > 30:
                    state.tick(ts)
                    last = ts
                got += state.finished
                state.finished = []
        state.close_session(partial=True)
        got += state.finished
        added = 0
        for s in got:
            old = exists_like(s)
            if old and not a.reemplazar:
                continue
            if old:
                s['id'] = old.stem
                old.write_text(json.dumps(s, ensure_ascii=False, separators=(',', ':')))
                print(f'  sustituida: {old.name} · {s["title"]}')
                continue
            d = ROOT / 'data' / 'sesiones' / s['slug'] / s['date']
            d.mkdir(parents=True, exist_ok=True)
            p = d / f"{s['id']}.json"
            n = 2
            while p.exists():
                p = d / f"{s['id']}-{n}.json"
                n += 1
            s['id'] = p.stem
            s['recuperada'] = True
            p.write_text(json.dumps(s, ensure_ascii=False, separators=(',', ':')))
            added += 1
            print(f'  recuperada: {p.name} · {s["title"]} · {len(s["stints"])} pilotos')
        print(f'{slug}: {len(got)} sesiones en bruto, {added} recuperadas')


if __name__ == '__main__':
    main()
