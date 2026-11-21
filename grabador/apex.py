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
        self.finished: list[dict] = []
        self._new_session()

    # ---------- sesiones ----------
    def _new_session(self):
        self.laps: list[dict] = []
        self.last_lap: dict[str, tuple] = {}
        self.session_title = (self.title1, self.title2)

    def close_session(self, partial=False):
        if len(self.laps) >= 5:
            self.finished.append(self._build(partial))
        self._new_session()

    def _build(self, partial):
        by_row: dict[str, list] = {}
        for l in self.laps:
            by_row.setdefault(l['row'], []).append(l)
        first = min(l['ts'] for l in self.laps)
        dt = datetime.fromtimestamp(first, self.tz)
        t1, t2 = self.session_title if any(self.session_title) else (self.title1, self.title2)
        title = ' - '.join(x for x in (t1, t2) if x)
        up = title.upper()
        stype = 'Cronos' if re.search(r'CRONO|QUALI|CLASIF|ENTREN|PRACT|LIBRE|ESSAI|CHRONO', up) else 'Carrera'
        stints = []
        for rid, ls in by_row.items():
            ls.sort(key=lambda x: x['ts'])
            drivers = [l['driver'] for l in ls if l['driver']]
            karts = [l['kart'] for l in ls if l['kart']]
            kart = max(set(karts), key=karts.count) if karts else ''
            driver = max(set(drivers), key=drivers.count) if drivers else ''
            try:
                kart_n = int(re.sub(r'\D', '', kart)) if re.sub(r'\D', '', kart) else kart
            except ValueError:
                kart_n = kart
            pos = self.rows.get(rid, {}).get('rk', '')
            stints.append({
                'kart': kart_n, 'driver': driver.strip().upper(), 'cls': '',
                'pos': int(pos) if str(pos).isdigit() else None,
                'laps': [l['t'] for l in ls],
                'gaps': [l['gap'] for l in ls],
                'ts': [round(l['ts'], 1) for l in ls],
            })
        stints.sort(key=lambda s: (s['pos'] is None, s['pos'] or 0))
        return {
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
        else:
            m = CELL_RE.match(cmd)
            if m:
                self._cell('r' + m.group(1), int(m.group(2)), param, value, ts)
                return
            m = ROW_RE.match(cmd)
            if m and param == '#':
                self.rows.setdefault(cmd, {})['rk'] = value

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
            new_rows[rid] = d
        # si cambia el conjunto de filas por completo, es otra sesión
        if self.laps and new_rows and not (set(new_rows) & set(self.last_lap)):
            self.close_session()
        self.rows = new_rows

    def _cell(self, rid: str, col: int, cls: str, value: str, ts: float):
        row = self.rows.setdefault(rid, {})
        dtype = self.col_type.get(col, '')
        if not dtype:
            return
        row[dtype] = value
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
                              'driver': row.get('dr', ''), 'gap': gap})
