"""Actualiza circuitos.json con la lista de circuitos guardada en la app.

Uso: python -m grabador.desde_app circuitos_app.json
El archivo de entrada es una lista de {"id": slug, "data": {...}} (tal como la da la base de datos de la app).
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main():
    docs = json.loads(Path(sys.argv[1]).read_text())
    out = []
    for d in docs:
        c, slug = d.get('data') or {}, d.get('id')
        if not slug or not (c.get('url') or c.get('port')):
            continue
        e = {'slug': slug, 'nombre': c.get('nombre') or slug, 'tz': c.get('tz') or 'Europe/Madrid',
             'grabar': bool(c.get('grabar'))}
        if c.get('url'):
            e['url'] = c['url']
            if c.get('port'):
                e['port'] = c['port']
        else:
            e['port'], e['port_fijo'] = c['port'], True
        out.append(e)
    out.sort(key=lambda x: x['slug'])
    path = ROOT / 'circuitos.json'
    old = path.read_text() if path.exists() else ''
    new = json.dumps(out, ensure_ascii=False, indent=1)
    if json.loads(old or '[]') != out:
        path.write_text(new)
        print(f'circuitos.json actualizado ({len(out)} circuitos)')
    else:
        print('circuitos.json sin cambios')


if __name__ == '__main__':
    main()
