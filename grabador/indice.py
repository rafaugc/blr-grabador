"""Índice de todas las sesiones grabadas (data/indice.json) para que la página no tenga que preguntar a la API de GitHub."""
import hashlib
import json
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main():
    idx = {'actualizado': int(time.time()), 'circuitos': {}}
    for cdir in sorted((ROOT / 'data' / 'sesiones').glob('*')):
        dias = {}
        for ddir in sorted(cdir.glob('*')):
            files = [{'f': f.name, 'h': hashlib.sha1(f.read_bytes()).hexdigest()[:10]} for f in sorted(ddir.glob('*.json'))]
            if files:
                dias[ddir.name] = files
        if dias:
            idx['circuitos'][cdir.name] = {'dias': dias}
    out = ROOT / 'data' / 'indice.json'
    old = out.read_text() if out.exists() else ''
    new = json.dumps(idx, separators=(',', ':'))
    if json.loads(old or '{}').get('circuitos') != idx['circuitos']:
        out.write_text(new)
        print('Índice actualizado')


if __name__ == '__main__':
    main()
