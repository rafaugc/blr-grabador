"""Atiende las peticiones que se hacen desde la página (se mandan como una "issue" de GitHub).

Títulos que entiende:
  - "Añadir circuito"   cuerpo con líneas "Enlace: <url de Apex>", "Nombre: <nombre>", "País: España|Portugal"
  - "Quitar circuito: <slug>"
  - "Sesiones PDF"      cuerpo = JSON con la lista de sesiones leídas de los PDF "Resumen" de Apex
  - "Grabar circuito: <slug>"  cuerpo con "Grabar: sí|no" (pausa o reanuda la grabación en directo)
  - "Borrar sesiones"   cuerpo con una ruta por línea: data/sesiones/<circuito>/<día>/<archivo>.json
  - "Pilotos"           cuerpo = JSON {"unir": {alias: nombre que se queda}, "quitar": [nombres],
                        "mojado": {"<circuito>|<día>|<hora>": 1 mojado / 0 seco}} → data/pilotos.json

Escribe el resultado en resultado.txt (se publica como comentario en la issue).
Uso: python -m grabador.peticion <evento.json>
"""
from __future__ import annotations

import json
import re
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CIRC = ROOT / 'circuitos.json'
SES = ROOT / 'data' / 'sesiones'
SLUG_RE = re.compile(r'^[a-z0-9][a-z0-9-]{1,60}$')


def slugify(s: str) -> str:
    s = unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode().lower()
    return re.sub(r'[^a-z0-9]+', '-', s).strip('-')[:60]


def load_circ():
    return json.loads(CIRC.read_text()) if CIRC.exists() else []


def save_circ(lst):
    lst.sort(key=lambda x: x['slug'])
    CIRC.write_text(json.dumps(lst, ensure_ascii=False, indent=1))


def field(body: str, name: str) -> str:
    m = re.search(rf'^\s*{name}\s*:\s*(.+?)\s*$', body, re.I | re.M)
    return m.group(1).strip() if m else ''


def add_circuit(body: str) -> str:
    url = field(body, 'Enlace') or (re.search(r'https?://\S+', body) or [''])[0]
    m = re.search(r'apex-timing\.com/(?:live-timing/)?([A-Za-z0-9_-]+)', url)
    if not m or m.group(1) in ('live-timing', 'gokarts'):
        return 'No he entendido el enlace. Copia la dirección de la página de live timing del circuito en Apex Timing.'
    apex = m.group(1)
    url = url.split('#')[0].split('?')[0]
    nombre = field(body, 'Nombre')[:60] or apex.replace('-', ' ').title()
    slug = slugify(apex)
    if not SLUG_RE.match(slug):
        return 'El enlace no parece de un circuito de Apex Timing.'
    pais = field(body, 'País') or field(body, 'Pais')
    lst = load_circ()
    old = next((c for c in lst if c['slug'] == slug), None)
    if old:
        old.update({'url': url, 'grabar': True, 'nombre': nombre or old['nombre']})
        old.pop('port_fijo', None)
        save_circ(lst)
        return f'"{old["nombre"]}" ya estaba en la lista: lo he dejado grabando con este enlace.'
    lst.append({'slug': slug, 'nombre': nombre, 'tz': 'Europe/Lisbon' if pais.lower().startswith('port') else 'Europe/Madrid',
                'grabar': True, 'url': url})
    save_circ(lst)
    return f'Añadido "{nombre}". El grabador empezará a escucharlo en unos 5 minutos.'


def remove_circuit(title: str) -> str:
    slug = title.split(':', 1)[1].strip() if ':' in title else ''
    lst = load_circ()
    new = [c for c in lst if c['slug'] != slug]
    if len(new) == len(lst):
        return f'No he encontrado el circuito "{slug}".'
    save_circ(new)
    return f'Quitado "{slug}" de la lista. Lo ya grabado se conserva.'


def num(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and 0 < x < 1000


def clean_session(s: dict, circs: dict) -> dict | None:
    slug = str(s.get('slug') or '')
    date, time = str(s.get('date') or ''), str(s.get('time') or '')
    if not SLUG_RE.match(slug) or not re.match(r'^\d{4}-\d\d-\d\d$', date) or not re.match(r'^\d{1,2}:\d\d$', time):
        return None
    stints = []
    for t in s.get('stints') or []:
        laps = [round(float(v), 3) for v in (t.get('laps') or []) if num(v)]
        if not laps:
            continue
        kart = t.get('kart')
        stints.append({'kart': int(kart) if str(kart).isdigit() else str(kart)[:10], 'driver': str(t.get('driver') or '')[:60],
                       'cls': str(t.get('cls') or '')[:20], 'pos': t.get('pos') if isinstance(t.get('pos'), int) else None,
                       'laps': laps})
    if not stints:
        return None
    group, typ = str(s.get('group') or '')[:30], str(s.get('type') or '')[:30]
    sid = f"{date}_{time.replace(':', '').zfill(4)}_{slugify(group + ' ' + typ) or 'pdf'}"
    return {'id': sid, 'circuit': circs.get(slug, s.get('circuit') or slug), 'slug': slug, 'date': date, 'time': time.zfill(5),
            'group': group, 'type': typ, 'title': (group + ' ' + typ).strip() or 'Sesión', 'source': str(s.get('source') or 'PDF')[:80],
            'stints': stints}


def recorded_same(s: dict) -> bool:
    """¿Ya hay una sesión grabada en directo a la misma hora (±10 min)? Así no se cuenta dos veces."""
    d = SES / s['slug'] / s['date']
    if not d.exists():
        return False
    h, m = map(int, s['time'].split(':'))
    for f in d.glob('*.json'):
        try:
            o = json.loads(f.read_text())
        except Exception:
            continue
        if str(o.get('source', '')).lower().endswith('.pdf') or o.get('source') == 'PDF':
            continue
        try:
            oh, om = map(int, o['time'].split(':'))
        except Exception:
            continue
        if abs((oh * 60 + om) - (h * 60 + m)) <= 10:
            return True
    return False


def add_pdf(body: str) -> str:
    txt = body.strip().strip('`').strip()
    if txt.startswith('json'):
        txt = txt[4:]
    try:
        data = json.loads(txt)
    except Exception:
        return 'No he podido leer los datos. Vuelve a pulsar "Guardar en la nube" en la página y pega el texto sin cambiarlo.'
    circs = {c['slug']: c['nombre'] for c in load_circ()}
    saved, dup, bad = [], 0, 0
    for s in data if isinstance(data, list) else []:
        c = clean_session(s, circs) if isinstance(s, dict) else None
        if not c:
            bad += 1
            continue
        if recorded_same(c):
            dup += 1
            continue
        d = SES / c['slug'] / c['date']
        d.mkdir(parents=True, exist_ok=True)
        (d / (c['id'] + '.json')).write_text(json.dumps(c, ensure_ascii=False, separators=(',', ':')))
        saved.append(f"{c['date']} {c['time']} {c['title']}")
    out = f'Guardadas {len(saved)} sesiones' + (':\n- ' + '\n- '.join(saved) if saved else '.')
    if dup:
        out += f'\n{dup} ya estaban grabadas en directo y no las he duplicado.'
    if bad:
        out += f'\n{bad} no tenían datos válidos.'
    return out


PIL = ROOT / 'data' / 'pilotos.json'
SES_PATH_RE = re.compile(r'^data/sesiones/[a-z0-9][a-z0-9-]{1,60}/\d{4}-\d\d-\d\d/[\w.+-]{1,120}\.json$')


def set_recording(title: str, body: str) -> str:
    slug = title.split(':', 1)[1].strip() if ':' in title else ''
    val = (field(body, 'Grabar') or '').lower()
    on = not val.startswith('n')
    lst = load_circ()
    c = next((x for x in lst if x['slug'] == slug), None)
    if not c:
        return f'No he encontrado el circuito "{slug}".'
    c['grabar'] = on
    save_circ(lst)
    return f'"{c["nombre"]}": ' + ('vuelve a grabarse en directo (empieza en unos 5 minutos).' if on else 'grabación en pausa. Lo ya grabado se conserva.')


def delete_sessions(body: str) -> str:
    paths = [l.strip().strip('`') for l in body.splitlines()]
    paths = [p for p in paths if SES_PATH_RE.match(p) and '..' not in p]
    done, missing = [], 0
    for p in paths:
        f = ROOT / p
        if f.exists():
            f.unlink()
            done.append(p.split('/', 2)[2])
            try:
                f.parent.rmdir()  # si el día se queda vacío
            except OSError:
                pass
        else:
            missing += 1
    if not paths:
        return 'No he encontrado ninguna sesión en la petición.'
    out = f'Borradas {len(done)} sesiones' + (':\n- ' + '\n- '.join(done) if done else '.')
    if missing:
        out += f'\n{missing} ya no existían.'
    return out


def save_pilotos(body: str) -> str:
    txt = body.strip().strip('`').strip()
    if txt.startswith('json'):
        txt = txt[4:]
    try:
        data = json.loads(txt)
    except Exception:
        return 'No he podido leer los datos. Vuelve a pulsar "Guardar en la nube" en la página.'
    nm = lambda x: re.sub(r'\s+', ' ', str(x)).strip().upper()[:60]
    unir = {nm(a): nm(b) for a, b in (data.get('unir') or {}).items() if nm(a) and nm(b) and nm(a) != nm(b)}
    quitar = sorted({nm(x) for x in (data.get('quitar') or []) if nm(x)})
    mojado = {str(k)[:80]: int(v) for k, v in (data.get('mojado') or {}).items()
              if re.match(r'^[a-z0-9-]{2,61}\|\d{4}-\d\d-\d\d\|\d{1,2}:\d\d$', str(k)) and v in (0, 1)}
    PIL.parent.mkdir(parents=True, exist_ok=True)
    PIL.write_text(json.dumps({'unir': dict(sorted(unir.items())), 'quitar': quitar, 'mojado': dict(sorted(mojado.items()))}, ensure_ascii=False, indent=1))
    return (f'Guardado: {len(unir)} nombres juntados con otro, {len(quitar)} pilotos quitados de la comparativa'
            f' y {len(mojado)} sesiones marcadas a mano como seco/mojado.')


def main():
    ev = json.loads(Path(sys.argv[1]).read_text())
    issue = ev['issue']
    title, body = (issue.get('title') or '').strip(), issue.get('body') or ''
    t = title.lower()
    if t.startswith('añadir circuito') or t.startswith('anadir circuito'):
        res = add_circuit(body)
    elif t.startswith('quitar circuito'):
        res = remove_circuit(title)
    elif t.startswith('sesiones pdf'):
        res = add_pdf(body)
    elif t.startswith('grabar circuito'):
        res = set_recording(title, body)
    elif t.startswith('borrar sesiones'):
        res = delete_sessions(body)
    elif t.startswith('pilotos'):
        res = save_pilotos(body)
    else:
        res = 'No es una petición que yo entienda.'
    (ROOT / 'resultado.txt').write_text(res)
    print(res)


if __name__ == '__main__':
    main()
