"""Interpreta el canal en directo de Apex Timing y lo convierte en sesiones con vueltas.

Formato de los mensajes (texto, varias líneas por mensaje):
    comando|parametro|valor
Ejemplos:
    init|grid|<table>...</table>      -> tabla completa (nueva sesión / nuevo diseño)
    grid||<table>...</table>          -> idem
    title1||CARRERA 1                 -> título de la sesión
    r900005625c5|tn|54.321            -> celda (fila r..., columna c...) con valor nuevo
    r900005625|#|3                    -> posición de una fila
"""
from __future__ import annotations

import re
import time
from datetime import datetime
from html.parser import HTMLParser
from zoneinfo import ZoneInfo

TIME_RE = re.compile(r'^(?:(\d{1,2}):)?(\d{1,2}\.\d{1,3})$')
CELL_RE = re.compile(r'^r(\d+)c(\d+)$')
ROW_RE = re.compile(r'^r(\d+)$')


def parse_time(s: str):
    s = (s or '').strip().replace(',', '.')
    m = TIME_RE.match(s)
    if not m:
        return None
    t = float(m.group(2)) + (int(m.group(1)) * 60 if m.group(1) else 0)
    return round(t, 3) if 5 < t < 600 else None


def parse_gap(s: str):
    s = (s or '').strip().replace(',', '.').lstrip('+')
    m = TIME_RE.match(s)
    if not m:
        return None
    return round(float(m.group(2)) + (int(m.group(1)) * 60 if m.group(1) else 0), 3)


STINT_RE = re.compile(r'^(.*?)\s*\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*$')


def set_name(row: dict, value: str, team_col: bool):
    """En carreras por equipos Apex alterna en la misma celda el equipo y el piloto al volante ("NOMBRE [0:24]")."""
    v = (value or '').strip()
    if not v:
        return
    m = STINT_RE.match(v)
    if m:
        row['driver'] = re.sub(r'^\d{1,3}\s*-\s*', '', m.group(1).strip())
        row['teamrace'] = True
    elif team_col or row.get('teamrace'):
        row['team'] = v
    else:
        row['driver'] = re.sub(r'^\d{1,3}\s*-\s*', '', v)  # quita el dorsal: "66-ANTONIO PARRA"



class _GridParser(HTMLParser):
    """Lee la tabla HTML de Apex: filas <tr data-id="r..."> con celdas <td data-type="...">."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.rows = []  # [(row_id, classes, [(attrs, text)])]
        self._row = None
        self._cell = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == 'tr':
            self._row = (a.get('data-id', ''), a.get('class', ''), [])
            self.rows.append(self._row)
        elif tag == 'td' and self._row is not None:
            self._cell = [a, '']
            self._row[2].append(self._cell)

    def handle_endtag(self, tag):
        if tag == 'td':
            self._cell = None
        elif tag == 'tr':
            self._row = None

    def handle_data(self, data):
        if self._cell is not None:
            self._cell[1] += data


class ApexState:
    """Estado de un circuito. Recibe líneas del canal y produce sesiones terminadas."""

    IDLE_CLOSE = 20 * 60  # cerrar sesión tras 20 min sin vueltas

    def __init__(self, slug: str, name: str, tz: str = 'Europe/Madrid'):
        self.slug, self.name, self.tz = slug, name, ZoneInfo(tz)
        self.col_type: dict[int, str] = {}
        self.col_title: dict[int, str] = {}
        self.rows: dict[str, dict] = {}
        self.title1 = self.title2 = self.track = ''
        self.comments = ''
        self.finished: list[dict] = []
        self.unknown: list[dict] = []  # vueltas de filas que Apex no ha anunciado todavía (sin kart ni piloto)
        self.unknown_title = ('', '')
        self._new_session()

    # ---------- sesiones ----------
    def _new_session(self):
        self.laps: list[dict] = []
        self.last_lap: dict[str, tuple] = {}
        self.session_title = (self.title1, self.title2)

    def close_session(self, partial=False):
        known = [l for l in self.laps if l['kart'] or l['driver']]
        unk = [l for l in self.laps if not (l['kart'] or l['driver'])]
        if unk:
            # sesión arrancada sin anunciar en Apex: la apartamos hasta que llegue la lista con nombres
            self._stash(unk, own=not known)
        self.laps = known
        if len(self.laps) >= 5:
            self.finished.append(self._build(partial))
        if partial and len(self.unknown) >= 5:
            self.laps = self.unknown
            self.session_title = self.unknown_title or (self.title1, 'Sin anunciar')
            self.finished.append(self._build(True))
            self.unknown = []
        self._new_session()

    def _stash(self, unk, own):
        if not self.unknown:
            # own=True: la sesión anunciada no tenía vueltas propias -> estas vueltas SON esa sesión (lista de pilotos tardía)
            self.unknown_title = (self.session_title if any(self.session_title) else (self.title1, self.title2)) if own else None
        self.unknown += unk

    def _resolve_unknown(self, new_rows: dict):
        """Llega una lista de pilotos: si incluye filas que corrieron sin anunciar, les ponemos nombre y las guardamos aparte."""
        if not self.unknown:
            return
        hit = [l for l in self.unknown if l['row'] in new_rows]
        if not hit:
            if time.time() - max(l['ts'] for l in self.unknown) > 3600:
                self.unknown = []
            return
        for l in hit:
            r = new_rows[l['row']]
            l['kart'] = r.get('no', '')
            l['driver'] = r.get('driver') or r.get('dr', '')
            l['team'] = r.get('team', '')
        saved_laps, saved_title = self.laps, self.session_title
        self.laps = hit
        self.session_title = self.unknown_title or (self.title1, 'Previa (sin anunciar)')
        if len(hit) >= 5:
            self.finished.append(self._build(False))
        self.laps, self.session_title = saved_laps, saved_title
        self.unknown = [l for l in self.unknown if l['row'] not in new_rows]

    def _build(self, partial):
        by_row: dict[str, list] = {}
        teamrace = any(l.get('team') for l in self.laps)
        for l in self.laps:
            # en carreras por equipos, cada piloto con su kart es una tanda distinta
            key = (l['row'], l['driver']) if teamrace else l['row']
            by_row.setdefault(key, []).append(l)
        first = min(l['ts'] for l in self.laps)
        dt = datetime.fromtimestamp(first, self.tz)
        t1, t2 = self.session_title if any(self.session_title) else (self.title1, self.title2)
        title = ' - '.join(x for x in (t1, t2) if x)
        up = title.upper()
        stype = 'Cronos' if re.search(r'CRONO|QUALI|CLASIF|ENTREN|PRACT|LIBRE|ESSAI|CHRONO|PREVIA', up) else 'Carrera'
        stints = []
        for key, ls in by_row.items():
            rid = key[0] if isinstance(key, tuple) else key
            ls.sort(key=lambda x: x['ts'])
            # vueltas repetidas: Apex a veces reenvía el mismo tiempo a mitad de vuelta o justo antes de la siguiente
            limpio = []
            for i, l in enumerate(ls):
                if limpio and abs(l['t'] - limpio[-1]['t']) < 0.0005:
                    if l['ts'] - limpio[-1]['ts'] < 0.85 * l['t']:
                        continue
                    if i + 1 < len(ls) and ls[i + 1]['ts'] - l['ts'] < 0.6 * ls[i + 1]['t']:
                        continue
                limpio.append(l)
            ls = limpio
            teams = [l['team'] for l in ls if l.get('team')]
            drivers = [l['driver'] for l in ls if l['driver']]
            karts = [l['kart'] for l in ls if l['kart']]
            kart = max(set(karts), key=karts.count) if karts else ''
            driver = max(set(drivers), key=drivers.count) if drivers else ''
            try:
                kart_n = int(re.sub(r'\D', '', kart)) if re.sub(r'\D', '', kart) else kart
            except ValueError:
                kart_n = kart
            pos = self.rows.get(rid, {}).get('rk', '')
            # número real de la primera vuelta grabada (si el grabador se enganchó con la sesión empezada será > 1)
            # (se mira solo en las 3 primeras: en las cronos hay pausas en boxes que Apex cuenta como vueltas)
            difs = [int(l['n']) - i for i, l in enumerate(ls[:3]) if str(l.get('n', '')).isdigit()]
            v0 = max(1, min(difs)) if difs else None
            stints.append({
                'v0': v0, 'kart': kart_n, 'driver': driver.strip().upper(), 'cls': '',
                'team': (max(set(teams), key=teams.count) if teams else ''),
                'pos': int(pos) if str(pos).isdigit() else None,
                'laps': [l['t'] for l in ls],
                'gaps': [l['gap'] for l in ls],
                'posv': [int(l['pos']) if str(l.get('pos', '')).isdigit() else None for l in ls],
                'lider': [l.get('lider', '') for l in ls],
                'pitsv': [l.get('pits', '') for l in ls],
                'ts': [round(l['ts'], 1) for l in ls],
            })
        stints.sort(key=lambda s: (s['pos'] is None, s['pos'] or 0))
        cols = [(i, t) for i, t in sorted(self.col_type.items()) if t and t not in ('sta', 'grp')]
        seen = {l['row'] for l in self.laps}
        clas = []
        for rid, r in self.rows.items():
            if rid not in seen:
                continue
            clas.append([r.get(t, '') for _, t in cols])
        rk = next((k for k, (_, t) in enumerate(cols) if t == 'rk'), None)
        if rk is not None:
            clas.sort(key=lambda v: int(v[rk]) if str(v[rk]).isdigit() else 999)
        coms = []
        for m in re.finditer(r'<p><b>([^<]*)</b>(.*?)</p>', self.comments or ''):
            txt = re.sub(r'<[^>]+>', ' ', m.group(2))
            coms.append({'hora': m.group(1), 'texto': re.sub(r'\s+', ' ', txt).strip()})
        return {
            'columnas': [{'tipo': t, 'titulo': self.col_title.get(i, t)} for i, t in cols],
            'clasificacion': clas, 'comentarios': coms, 'pista': self.track,
            'id': f"{dt:%Y-%m-%d}_{dt:%H%M}_{self.slug}",
            'circuit': self.name, 'slug': self.slug, 'date': f"{dt:%Y-%m-%d}", 'time': f"{dt:%H:%M}",
            'group': t2 or '', 'type': stype, 'title': title, 'source': 'grabador',
            'partial': partial, 'stints': stints,
        }

    # ---------- entrada ----------
    def feed(self, message: str, ts: float | None = None):
        ts = ts or time.time()
        for line in message.split('\n'):
            line = line.strip('\r')
            if line:
                self._line(line, ts)

    def tick(self, now: float | None = None):
        now = now or time.time()
        if self.laps and now - max(l['ts'] for l in self.laps) > self.IDLE_CLOSE:
            self.close_session()

    def _line(self, line: str, ts: float):
        parts = line.split('|', 2)
        cmd = parts[0]
        param = parts[1] if len(parts) > 1 else ''
        value = parts[2] if len(parts) > 2 else ''
        if cmd in ('init', 'grid') and ('<tr' in value or '<table' in value):
            self._grid(value)
        elif cmd == 'clear' and param == 'grid':
            self.close_session()
            self.rows.clear()
        elif cmd in ('title1', 'title2'):
            if getattr(self, cmd) != value:
                setattr(self, cmd, value)
                if self.laps and (self.title1, self.title2) != self.session_title:
                    self.close_session()
                if not self.laps:
                    self.session_title = (self.title1, self.title2)
        elif cmd == 'track':
            self.track = value
        elif cmd == 'com':
            self.comments = value
        else:
            m = CELL_RE.match(cmd)
            if m:
                self._cell('r' + m.group(1), int(m.group(2)), param, value, ts)
                return
            m = ROW_RE.match(cmd)
            if m and param == '#':
                self.rows.setdefault(cmd, {})['rk'] = value
                for l in reversed(self.laps[-60:]):
                    if l['row'] == cmd:
                        if ts - l['ts'] < 3:
                            l['pos'] = value
                        break

    def _grid(self, html: str):
        p = _GridParser()
        try:
            p.feed(html)
        except Exception:
            return
        header = next((r for r in p.rows if 'head' in r[1] or r[0] in ('r0',)), None)
        if header:
            self.col_type = {}
            self.col_title = {}
            for i, (a, txt) in enumerate(header[2], start=1):
                self.col_type[i] = a.get('data-type', '')
                self.col_title[i] = txt.strip()
        new_rows = {}
        for rid, cls, cells in p.rows:
            if not rid or rid == (header[0] if header else None) or 'head' in cls:
                continue
            d = {}
            for i, (a, txt) in enumerate(cells, start=1):
                dt = self.col_type.get(i)
                if dt:
                    d[dt] = txt.strip()
                    if dt == 'dr':
                        set_name(d, txt, self.team_col())
            new_rows[rid] = d
        # si cambia el conjunto de filas por completo, es otra sesión
        if self.laps and new_rows and not (set(new_rows) & set(self.last_lap)):
            self.close_session()
        # vueltas de filas desconocidas dentro de la sesión actual: apartarlas
        if self.laps and any(not (l['kart'] or l['driver']) for l in self.laps):
            unk = [l for l in self.laps if not (l['kart'] or l['driver'])]
            self.laps = [l for l in self.laps if l['kart'] or l['driver']]
            self._stash(unk, own=not self.laps)
        self._resolve_unknown(new_rows)
        self.rows = new_rows

    def team_col(self):
        return any(t == 'dr' and re.search(r'equip|team|[ée]quipe', self.col_title.get(i, ''), re.I)
                   for i, t in self.col_type.items())

    def _cell(self, rid: str, col: int, cls: str, value: str, ts: float):
        row = self.rows.setdefault(rid, {})
        dtype = self.col_type.get(col, '')
        if not dtype:
            return
        row[dtype] = value
        if dtype == 'dr':
            set_name(row, value, self.team_col() or cls == 'drteam')
            return
        late = {'int': 'gap', 'gap': 'lider', 'rk': 'pos', 'pit': 'pits', 'tlp': 'n'}
        if dtype in late:
            # estos datos suelen llegar justo después de la vuelta: se los asignamos a esa vuelta
            for l in reversed(self.laps[-60:]):
                if l['row'] == rid:
                    if ts - l['ts'] < 3:
                        l[late[dtype]] = parse_gap(value) if dtype == 'int' else value
                    break
            return
        if dtype == 'llp':
            t = parse_time(value)
            if t is None:
                return
            prev = self.last_lap.get(rid)
            if prev and prev[0] == t and ts - prev[1] < t * 0.6:
                return  # repetición del mismo tiempo
            self.last_lap[rid] = (t, ts)
            gap = parse_gap(row.get('int', ''))
            self.laps.append({'row': rid, 't': t, 'ts': ts, 'kart': row.get('no', ''),
                              'driver': row.get('driver') or row.get('dr', ''), 'team': row.get('team', ''), 'gap': gap,
                              'pos': row.get('rk', ''), 'lider': row.get('gap', ''), 'pits': row.get('pit', ''),
                              'n': row.get('tlp', '')})
