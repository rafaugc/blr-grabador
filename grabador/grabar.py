"""Graba en directo los circuitos activados en circuitos.json.

Uso:  python -m grabador.grabar --minutos 345
Guarda:
  data/sesiones/<slug>/<fecha>/<id>.json   sesiones terminadas (formato de la app)
  data/estado.json                          estado de cada circuito en la última ejecución
  raw/<slug>_<inicio>.jsonl.gz              todo lo recibido, tal cual (copia de seguridad)
"""
from __future__ import annotations

import argparse
import asyncio
import gzip
import json
import os
import re
import ssl
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import websockets

from .apex import ApexState
from . import ajustes

ROOT = Path(__file__).resolve().parent.parent
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'
SILENCE_RECONNECT = 15 * 60  # reconectar si no llega nada en 15 min


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


def slug_from_url(url: str):
    m = re.search(r'apex-timing\.com/(?:live-timing/)?([\w.-]+)/?', url or '')
    return m.group(1) if m and m.group(1) not in ('live-timing', 'en', 'es', 'fr') else None


def resolve(c: dict):
    """Averigua el puerto del canal en directo a partir del enlace del circuito (config.js)."""
    if c.get('ws') or c.get('port_fijo'):
        return c
    url = c.get('url') or f"https://www.apex-timing.com/live-timing/{c['slug']}/index.html"
    base = url.split('index.html')[0].split('#')[0]
    if not base.endswith('/'):
        base += '/'
    try:
        req = urllib.request.Request(base + 'javascript/config.js', headers={'User-Agent': UA})
        body = urllib.request.urlopen(req, timeout=15).read().decode('utf-8', 'replace')
        port = int(re.search(r"var\s+configPort\s*=\s*(\d+)", body).group(1)) + 3
        host = re.search(r"var\s+configHost\s*=\s*'([^']+)'", body)
        c['port'] = port
        c['host'] = host.group(1) if host else 'live-data.apex-timing.com'
        log(f"[{c['slug']}] canal en directo: {c['host']}:{port}")
    except Exception as e:
        log(f"[{c['slug']}] no pude leer la configuración ({e!r}); uso puerto guardado {c.get('port')}")
    return c


class Publisher:
    """Sube a GitHub las sesiones nuevas en cuanto se terminan (como mucho cada 2 min)."""

    def __init__(self, enabled: bool):
        self.enabled = enabled
        self.pending = False
        self.last = 0.0
        self.lock = asyncio.Lock()

    def mark(self):
        self.pending = True

    async def maybe(self, force=False):
        if self.enabled and time.time() - self.last > 180:
            self.pending = True
        if not self.enabled or not self.pending or (not force and time.time() - self.last < 120):
            return
        async with self.lock:
            self.pending = False
            self.last = time.time()
            await asyncio.to_thread(publish_git)


# Archivos que este grabador ha escrito y aún no ha subido: ruta -> contenido (None = borrado)
MINE: dict = {}


def write_mine(path: Path, text: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    MINE[str(path.relative_to(ROOT))] = text


def remove_mine(path: Path):
    if path.exists():
        path.unlink()
    MINE[str(path.relative_to(ROOT))] = None


def _git(*args):
    return subprocess.run(['git', *args], cwd=ROOT, capture_output=True, text=True)


def publish_git():
    """Sube a GitHub sin poder atascarse aunque haya otro grabador a la vez:
    parte siempre de la versión más reciente de GitHub y pone encima solo lo que ha escrito este grabador."""
    snap = dict(MINE)
    applied = 0
    for attempt in range(6):
        if _git('fetch', '-q', 'origin', 'main').returncode != 0:
            time.sleep(5)
            continue
        _git('rebase', '--abort')
        _git('merge', '--abort')
        _git('reset', '-q', '--hard', 'origin/main')
        for rel, text in snap.items():
            p = ROOT / rel
            if text is None:
                if p.exists():
                    p.unlink()
            else:
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(text)
        try:  # ajustes hechos desde la app (pilotos juntados, mojado, sesiones borradas…)
            applied = ajustes.apply_pending()
        except Exception as e:
            log(f'Ajustes de la app: error {e!r}')
        subprocess.run([sys.executable, '-m', 'grabador.unir'], cwd=ROOT, capture_output=True)
        subprocess.run([sys.executable, '-m', 'grabador.indice'], cwd=ROOT, capture_output=True)
        _git('add', '-A', 'data/')
        if _git('diff', '--cached', '--quiet').returncode == 0:
            ajustes.done(applied)
            break
        _git('commit', '-q', '-m', f"Sesiones {time.strftime('%Y-%m-%d %H:%M', time.gmtime())}" + (' + ajustes de la app' if applied else ''))
        r = _git('push', '-q', 'origin', 'HEAD:main')
        if r.returncode == 0:
            log('Subido a GitHub' + (f' (con {applied} ajustes de la app)' if applied else ''))
            ajustes.done(applied)
            break
        time.sleep(4 + attempt * 3)
    else:
        log('No pude subir a GitHub ahora; lo reintento en la próxima subida')
        return
    for rel, text in snap.items():  # lo subido ya no está pendiente
        if MINE.get(rel, object()) == text:
            MINE.pop(rel, None)


PUB: 'Publisher | None' = None
LIVE_EVERY = 3 * 60


def live_path(slug):
    return ROOT / 'data' / 'envivo' / f'{slug}.json'


def save_live(state: ApexState, stats: dict):
    """Foto de la sesión en curso (se sobrescribe); así se ve en la app antes de que termine."""
    p = live_path(state.slug)
    if not state.laps:
        if p.exists():
            remove_mine(p)
            if PUB:
                PUB.mark()
        return
    if time.time() - stats.get('live_ts', 0) < LIVE_EVERY:
        return
    stats['live_ts'] = time.time()
    s = state._build(partial=True)
    s['envivo'] = True
    write_mine(p, json.dumps(s, ensure_ascii=False, separators=(',', ':')))
    if PUB:
        PUB.mark()


def sample_write(slug, msg, stats):
    """Guarda una muestra pequeña de lo que manda Apex (para revisar columnas y formatos)."""
    d = ROOT / 'data' / 'muestras'
    if ('grid||' in msg or 'init|grid|' in msg) and not stats.get('muestra_grid'):
        d.mkdir(parents=True, exist_ok=True)
        write_mine(d / f'{slug}_tabla.txt', msg[:200000])
        stats['muestra_grid'] = True
    n = stats.get('muestra_n', 0)
    if n < 600:
        d.mkdir(parents=True, exist_ok=True)
        with open(d / f'{slug}_inicio.txt', 'w' if n == 0 else 'a') as f:
            f.write(msg[:20000].replace('\n', ' ⏎ ') + '\n')
        stats['muestra_n'] = n + 1
        fp = d / f'{slug}_inicio.txt'
        MINE[str(fp.relative_to(ROOT))] = fp.read_text()


def save_sessions(state: ApexState, stats: dict):
    while state.finished:
        s = state.finished.pop(0)
        d = ROOT / 'data' / 'sesiones' / s['slug'] / s['date']
        d.mkdir(parents=True, exist_ok=True)
        path = d / f"{s['id']}.json"
        n = 2
        while path.exists() or str(path.relative_to(ROOT)) in MINE:
            path = d / f"{s['id']}-{n}.json"
            n += 1
        s['id'] = path.stem
        write_mine(path, json.dumps(s, ensure_ascii=False, separators=(',', ':')))
        stats['sesiones'] += 1
        if PUB:
            PUB.mark()
        stats['ultima_sesion'] = f"{s['date']} {s['time']} {s['title']}"
        log(f"[{s['slug']}] sesión guardada: {path.name} ({len(s['stints'])} pilotos, "
            f"{sum(len(t['laps']) for t in s['stints'])} vueltas)")


async def record(c: dict, deadline: float, stats: dict, raw_dir: Path):
    slug = c['slug']
    url = c.get('ws') or f"wss://{c.get('host', 'live-data.apex-timing.com')}:{c['port']}/"
    origin = c.get('origin', 'https://www.apex-timing.com')
    state = ApexState(slug, c['nombre'], c.get('tz', 'Europe/Madrid'))
    raw = gzip.open(raw_dir / f"{slug}_{time.strftime('%Y%m%d-%H%M')}.jsonl.gz", 'wt', encoding='utf-8')
    ctx = ssl.create_default_context()
    delay = 5
    try:
        while time.time() < deadline:
            try:
                async with websockets.connect(url, origin=origin, ssl=ctx if url.startswith('wss') else None, user_agent_header=UA,
                                              ping_interval=None, max_size=2 ** 24, open_timeout=20,
                                              close_timeout=5) as ws:
                    stats['conectado'] = True
                    stats['conexiones'] += 1
                    log(f"[{slug}] conectado a {url}")
                    delay = 5
                    try:
                        await ws.send('init')
                    except Exception:
                        pass
                    while time.time() < deadline:
                        try:
                            msg = await asyncio.wait_for(ws.recv(), timeout=60)
                        except asyncio.TimeoutError:
                            state.tick()
                            save_sessions(state, stats)
                            if PUB:
                                await PUB.maybe()
                            if time.time() - stats.get('ultimo_mensaje_ts', time.time()) > SILENCE_RECONNECT:
                                log(f"[{slug}] sin datos hace rato, reconecto")
                                break
                            continue
                        now = time.time()
                        if isinstance(msg, bytes):
                            msg = msg.decode('utf-8', 'replace')
                        raw.write(json.dumps([round(now, 2), msg], ensure_ascii=False) + '\n')
                        sample_write(slug, msg, stats)
                        stats['mensajes'] += 1
                        stats['ultimo_mensaje_ts'] = now
                        try:
                            state.feed(msg, now)
                        except Exception as e:  # nunca dejar de grabar por un fallo de lectura
                            stats['errores_lectura'] += 1
                            if stats['errores_lectura'] < 5:
                                log(f"[{slug}] error leyendo mensaje: {e!r}")
                        if state.title1 or state.title2:
                            stats['titulo'] = ' - '.join(x for x in (state.title1, state.title2) if x)
                        state.tick(now)
                        save_sessions(state, stats)
                        stats['en_sesion'] = len(state.laps)
                        save_live(state, stats)
                        if PUB:
                            await PUB.maybe()
            except Exception as e:
                stats['ultimo_error'] = repr(e)[:200]
                log(f"[{slug}] error de conexión: {e!r}; reintento en {delay}s")
                await asyncio.sleep(min(delay, max(0, deadline - time.time())))
                delay = min(delay * 2, 300)
    finally:
        state.close_session(partial=True)
        save_sessions(state, stats)
        if live_path(slug).exists():
            remove_mine(live_path(slug))
        raw.close()


async def main_async(minutes: float, only: list[str] | None):
    circuits = json.loads((ROOT / 'circuitos.json').read_text())
    active = [c for c in circuits if c.get('grabar') and (not only or c['slug'] in only)]
    if not active:
        log('No hay circuitos activados en circuitos.json')
        return
    active = [resolve(c) for c in active]
    active = [c for c in active if c.get('port') or c.get('ws')]
    global PUB
    PUB = Publisher(os.environ.get('GITHUB_ACTIONS') == 'true')
    raw_dir = ROOT / 'raw'
    raw_dir.mkdir(exist_ok=True)
    deadline = time.time() + minutes * 60
    stats = {c['slug']: {'nombre': c['nombre'], 'conectado': False, 'conexiones': 0, 'mensajes': 0,
                         'sesiones': 0, 'errores_lectura': 0} for c in active}
    log(f"Grabando {len(active)} circuitos durante {minutes:.0f} minutos: {', '.join(c['slug'] for c in active)}")
    tasks = {c['slug']: asyncio.create_task(record(c, deadline, stats[c['slug']], raw_dir)) for c in active}

    async def watch_list():
        # cada 5 min mira si se han añadido circuitos nuevos (desde la app) y empieza a grabarlos
        while time.time() < deadline - 120:
            await asyncio.sleep(300)
            if os.environ.get('GITHUB_ACTIONS') == 'true':
                await asyncio.to_thread(subprocess.run, ['git', 'pull', '-q', '--rebase', '-X', 'theirs'], cwd=ROOT, capture_output=True)
            try:
                fresh = json.loads((ROOT / 'circuitos.json').read_text())
            except Exception:
                continue
            for c in fresh:
                if c.get('grabar') and c['slug'] not in tasks and (not only or c['slug'] in only):
                    c = resolve(c)
                    if not (c.get('port') or c.get('ws')):
                        continue
                    stats[c['slug']] = {'nombre': c['nombre'], 'conectado': False, 'conexiones': 0, 'mensajes': 0,
                                        'sesiones': 0, 'errores_lectura': 0}
                    log(f"[{c['slug']}] circuito nuevo en la lista, empiezo a grabarlo")
                    tasks[c['slug']] = asyncio.create_task(record(c, deadline, stats[c['slug']], raw_dir))

    async def watch_ajustes():
        # cada minuto mira si desde la app se han juntado pilotos, marcado sesiones, etc. y lo sube a GitHub
        while time.time() < deadline - 60:
            try:
                n = await asyncio.to_thread(ajustes.poll)
                if n:
                    log(f'{n} ajustes nuevos desde la app')
                    PUB.mark()
                if ajustes.PENDING:
                    await PUB.maybe()
            except Exception as e:
                log(f'Ajustes de la app: error {e!r}')
            await asyncio.sleep(60)

    watcher = asyncio.create_task(watch_list())
    aj_watcher = asyncio.create_task(watch_ajustes()) if PUB.enabled else None
    while any(not t.done() for t in tasks.values()):
        await asyncio.sleep(5)
    watcher.cancel()
    if aj_watcher:
        aj_watcher.cancel()

    estado_path = ROOT / 'data' / 'estado.json'
    estado_path.parent.mkdir(exist_ok=True)
    try:
        estado = json.loads(estado_path.read_text())
    except Exception:
        estado = {}
    fin = time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime())
    for slug, s in stats.items():
        prev = estado.get(slug, {})
        s.pop('ultimo_mensaje_ts', None)
        s.pop('en_sesion', None)
        s.pop('live_ts', None)
        s.pop('muestra_grid', None)
        s.pop('muestra_n', None)
        s['ultima_ejecucion'] = fin
        s['sesiones_total'] = prev.get('sesiones_total', 0) + s['sesiones']
        if s['conectado']:
            s['ultima_conexion_ok'] = fin
        else:
            s['ultima_conexion_ok'] = prev.get('ultima_conexion_ok')
        if not s.get('ultima_sesion'):
            s['ultima_sesion'] = prev.get('ultima_sesion')
        estado[slug] = s
    write_mine(estado_path, json.dumps(estado, ensure_ascii=False, indent=1))
    if PUB and PUB.enabled:
        PUB.pending = True
        await PUB.maybe(force=True)
    log('Resumen:')
    for slug, s in stats.items():
        log(f"  {slug}: conectado={s['conectado']} mensajes={s['mensajes']} sesiones={s['sesiones']}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--minutos', type=float, default=350)
    ap.add_argument('--solo', nargs='*', help='grabar solo estos circuitos (slugs)')
    a = ap.parse_args()
    asyncio.run(main_async(a.minutos, a.solo))


if __name__ == '__main__':
    sys.exit(main())
