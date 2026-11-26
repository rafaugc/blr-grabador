"""Ajustes que se hacen desde la app (juntar pilotos, "no son el mismo", quitar pilotos, marcar seco/mojado,
borrar sesiones) sin necesidad de GitHub en cada dispositivo.

La app manda cada cambio como un mensaje al canal de ntfy.sh (gratis, sin cuenta). El grabador, que está siempre
en marcha, lee el canal cada minuto, aplica los cambios a data/pilotos.json (y borra las sesiones pedidas) y lo sube
a GitHub con el resto de lo grabado. ntfy guarda los mensajes 12 horas, así que no se pierde nada aunque haya un
cambio de turno del grabador.

Cambios ("ops"), los mismos que entiende la página:
  {"o":"u","a":ALIAS,"k":NOMBRE}   juntar: ALIAS es la misma persona que NOMBRE
  {"o":"s","a":ALIAS}              separar un nombre juntado
  {"o":"q","n":NOMBRE}             quitar de la comparativa      {"o":"r","n":NOMBRE}  recuperar
  {"o":"d","p":"A|B"}              A y B NO son la misma persona
  {"o":"m","k":"circuito|día|hora","v":1|0|null}   sesión mojada / seca / automático
  {"o":"b","p":"data/sesiones/<circuito>/<día>/<archivo>.json"}   borrar sesión
  {"o":"t","f":FONDO,"r":RESALTE}  colores de la app (igual en todos los dispositivos)
"""
from __future__ import annotations

import json
import re
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PIL = ROOT / 'data' / 'pilotos.json'
TOPIC = 'krk-ajustes-7f3c9a51e2d84b06'
SES_RE = re.compile(r'^data/sesiones/[a-z0-9][a-z0-9-]{1,60}/\d{4}-\d\d-\d\d/[\w.+-]{1,120}\.json$')
TEMA_F = {'carbon', 'azul', 'pizarra', 'verde', 'burdeos', 'negro', 'claro'}
TEMA_R = {'amarillo', 'naranja', 'cian', 'azul', 'rosa', 'blanco'}
MOJ_RE = re.compile(r'^[a-z0-9-]{2,61}\|\d{4}-\d\d-\d\d\|\d{1,2}:\d\d$')

PENDING: list = []          # cambios leídos y aún no subidos
LAST = {'id': None}         # último mensaje leído del canal


def _nm(x) -> str:
    return re.sub(r'\s+', ' ', str(x or '')).strip().upper()[:60]


def load() -> dict:
    try:
        d = json.loads(PIL.read_text())
    except Exception:
        d = {}
    for k, v in (('unir', {}), ('quitar', []), ('mojado', {}), ('distintos', [])):
        d.setdefault(k, v)
    return d


def apply_op(d: dict, o: dict) -> None:
    t = o.get('o')
    if t == 'u':
        def can(n):
            i = 0
            while n in d['unir'] and i < 8:
                n, i = d['unir'][n], i + 1
            return n
        keep, a = can(_nm(o.get('k'))), can(_nm(o.get('a')))
        if not keep or not a or a == keep:
            return
        d['unir'][a] = keep
        for k, v in list(d['unir'].items()):
            if v == a:
                d['unir'][k] = keep
        d['unir'].pop(keep, None)
    elif t == 's':
        d['unir'].pop(_nm(o.get('a')), None)
    elif t == 'q':
        n = _nm(o.get('n'))
        if n and n not in d['quitar']:
            d['quitar'].append(n)
    elif t == 'r':
        n = _nm(o.get('n'))
        d['quitar'] = [x for x in d['quitar'] if x != n]
    elif t == 'd':
        p = str(o.get('p') or '')
        if '|' in p:
            p = '|'.join(sorted(_nm(x) for x in p.split('|', 1)))
            if p not in d['distintos']:
                d['distintos'].append(p)
    elif t == 'm':
        k = str(o.get('k') or '')
        if MOJ_RE.match(k):
            if o.get('v') in (0, 1):
                d['mojado'][k] = o['v']
            else:
                d['mojado'].pop(k, None)
    elif t == 't':
        if o.get('f') in TEMA_F and o.get('r') in TEMA_R:
            d['tema'] = {'f': o['f'], 'r': o['r']}
    elif t == 'b':
        p = str(o.get('p') or '')
        if SES_RE.match(p) and '..' not in p:
            f = ROOT / p
            if f.exists():
                f.unlink()
                try:
                    f.parent.rmdir()
                except OSError:
                    pass


def dump(d: dict) -> str:
    out = {'unir': dict(sorted(d['unir'].items())), 'quitar': sorted(set(d['quitar'])),
           'mojado': dict(sorted(d['mojado'].items())), 'distintos': sorted(set(d['distintos']))}
    if d.get('tema'):
        out['tema'] = d['tema']
    if d.get('_ultimo'):
        out['_ultimo'] = d['_ultimo']
    return json.dumps(out, ensure_ascii=False, indent=1)


def poll() -> int:
    """Lee los mensajes nuevos del canal. Devuelve cuántos cambios nuevos hay."""
    since = LAST['id'] or load().get('_ultimo') or '12h'
    url = f'https://ntfy.sh/{TOPIC}/json?poll=1&since={since}'
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'krk-grabador'}), timeout=20) as r:
            lines = r.read().decode('utf-8', 'replace').splitlines()
    except Exception:
        return 0
    n = 0
    for line in lines:
        try:
            ev = json.loads(line)
            if ev.get('event') != 'message':
                continue
            LAST['id'] = ev.get('id') or LAST['id']
            ops = json.loads(ev.get('message') or '{}').get('ops') or []
        except Exception:
            continue
        for o in ops:
            if isinstance(o, dict):
                PENDING.append(o)
                n += 1
    return n


def apply_pending() -> int:
    """Aplica los cambios pendientes sobre la versión de GitHub recién descargada. Devuelve cuántos se aplicaron."""
    if not PENDING and not LAST['id']:
        return 0
    k = len(PENDING)
    try:
        d = load()
        for o in PENDING[:k]:
            apply_op(d, o)
        if LAST['id']:
            d['_ultimo'] = LAST['id']
        new = dump(d)
        old = PIL.read_text() if PIL.exists() else ''
        if new != old:
            PIL.parent.mkdir(parents=True, exist_ok=True)
            PIL.write_text(new)
    except Exception:
        return 0
    return k


def done(k: int) -> None:
    del PENDING[:k]


if __name__ == '__main__':  # prueba manual: python -m grabador.ajustes
    print('cambios nuevos:', poll())
    print('aplicados:', apply_pending(), time.strftime('%H:%M:%S'))
