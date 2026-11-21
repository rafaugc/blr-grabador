"""Une las sesiones que quedaron partidas en dos (relevo entre turnos o reconexión).

Dos archivos son la misma sesión si: uno de los dos quedó a medias, mismo circuito, mismo título, se tocan en el
tiempo (menos de 10 min entre el final de uno y el principio del otro, o se solapan)
y comparten al menos la mitad de los karts. Las vueltas repetidas se quitan.
"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GAP = 10 * 60


def span(s):
    ts = [t for st in s['stints'] for t in st.get('ts', [])]
    return (min(ts), max(ts)) if ts else (None, None)


def same(a, b):
    if a.get('slug') != b.get('slug') or a.get('title') != b.get('title'):
        return False
    (a0, a1), (b0, b1) = span(a), span(b)
    if a0 is None or b0 is None:
        return False
    overlap = min(a1, b1) - max(a0, b0) > 0  # grabadas a la vez por dos turnos
    near = b0 - a1 <= GAP and a0 - b1 <= GAP
    if not (overlap or ((a.get('partial') or b.get('partial')) and near)):
        return False
    ka, kb = {str(s['kart']) for s in a['stints']}, {str(s['kart']) for s in b['stints']}
    return len(ka & kb) >= 0.5 * min(len(ka), len(kb))


ARR = ('laps', 'gaps', 'ts', 'posv', 'lider', 'pitsv')


def merge(a, b):
    by = {}
    for s in a['stints'] + b['stints']:
        key = (str(s['kart']), s['driver'])
        cur = by.setdefault(key, dict({k: v for k, v in s.items() if k not in ARR}, **{k: [] for k in ARR}))
        for i, t in enumerate(s['laps']):
            ts = s['ts'][i] if i < len(s.get('ts', [])) else None
            dup = any(abs(t - t2) < 0.002 and (ts is None or ts2 is None or abs(ts - ts2) < 5)
                      for t2, ts2 in zip(cur['laps'], cur['ts']))
            if not dup:
                for k in ARR:
                    src = s.get(k, [])
                    cur[k].append(src[i] if i < len(src) else (t if k == 'laps' else None))
        if s.get('pos') is not None:
            cur['pos'] = s['pos']
    for s in by.values():
        order = sorted(range(len(s['laps'])), key=lambda i: s['ts'][i] or 0)
        for k in ARR:
            s[k] = [s[k][i] for i in order]
    first, last = (a, b) if span(a)[0] <= span(b)[0] else (b, a)
    out = dict(first)
    for k in ('columnas', 'clasificacion', 'comentarios', 'pista'):
        if last.get(k):
            out[k] = last[k]
    out['stints'] = sorted(by.values(), key=lambda s: (s['pos'] is None, s['pos'] or 0))
    out['partial'] = bool(last.get('partial'))
    return out


def main():
    base = ROOT / 'data' / 'sesiones'
    changed = 0
    for circuit in base.glob('*') if base.exists() else []:
        files = sorted(circuit.rglob('*.json'))
        items = []
        for f in files:
            try:
                items.append([f, json.loads(f.read_text())])
            except Exception:
                pass
        items.sort(key=lambda x: span(x[1])[0] or 0)
        i = 0
        while i < len(items):
            j = i + 1
            while j < len(items):
                if same(items[i][1], items[j][1]):
                    items[i][1] = merge(items[i][1], items[j][1])
                    items[j][0].unlink()
                    del items[j]
                    changed += 1
                    items[i][0].write_text(json.dumps(items[i][1], ensure_ascii=False, separators=(',', ':')))
                else:
                    j += 1
            i += 1
    print(f'Sesiones unidas: {changed}')


if __name__ == '__main__':
    main()
