"""Fotógrafo de Apex: guarda una foto de la pantalla de Apex al terminar cada sesión.

Funciona APARTE del grabador (su propio turno de GitHub Actions), así que si falla no afecta a la grabación.
- Para cada circuito que se graba abre la página de Apex en un navegador sin pantalla.
- Escucha el mismo canal en directo que el grabador (con el mismo lector, ApexState) para saber cuándo hay
  una sesión en marcha y cuándo termina.
- Mientras hay sesión, hace una foto cada FOTO_CADA segundos y se queda solo con la última (en memoria).
- Cuando la sesión termina, sube esa última foto (la clasificación final) a las "Releases" de GitHub:
  una por día, etiqueta fotos-AAAA-MM-DD, archivo <id de la sesión>.jpg. Las Releases no se descargan
  con el proyecto, así que no lo hacen más pesado ni más lento.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import ssl
import subprocess
import tempfile
import time
from pathlib import Path

import websockets

from .apex import ApexState
from .grabar import ROOT, UA, log, resolve

FOTO_CADA = 20          # segundos entre fotos mientras hay sesión
VIEW = {'width': 1440, 'height': 900}
UPLOADS: asyncio.Queue | None = None
TAGS_OK: set = set()


def _gh(*args) -> subprocess.CompletedProcess:
    return subprocess.run(['gh', *args], cwd=ROOT, capture_output=True, text=True)


def upload(tag: str, path: Path) -> bool:
    if tag not in TAGS_OK:
        if _gh('release', 'view', tag).returncode != 0:
            r = _gh('release', 'create', tag, '--title', f'Fotos de Apex {tag[6:]}', '--prerelease',
                    '--notes', 'Fotos de la pantalla de Apex al terminar cada sesión (las sube el fotógrafo automáticamente).')
            if r.returncode != 0 and 'already exists' not in (r.stderr or ''):
                log(f'[fotos] no pude crear la release {tag}: {r.stderr.strip()[:200]}')
                return False
        TAGS_OK.add(tag)
    r = _gh('release', 'upload', tag, str(path), '--clobber')
    if r.returncode != 0:
        log(f'[fotos] no pude subir {path.name}: {r.stderr.strip()[:200]}')
        return False
    return True


def limpiar(slugs: list[str]) -> None:
    """Borra fotos de circuitos sin página de Apex (eran fotos de un error 403), de los últimos días."""
    import datetime
    for k in range(3):
        tag = 'fotos-' + (datetime.date.today() - datetime.timedelta(days=k)).isoformat()
        r = _gh('release', 'view', tag, '--json', 'assets', '-q', '.assets[].name')
        if r.returncode != 0:
            continue
        for name in r.stdout.split():
            if any(name.endswith(f'_{s}.jpg') or f'_{s}-' in name for s in slugs):
                _gh('release', 'delete-asset', tag, name, '--yes')
                log(f'[fotos] borrada {tag}/{name} (circuito sin página de Apex)')


async def uploader():
    while True:
        tag, name, data = await UPLOADS.get()
        try:
            with tempfile.TemporaryDirectory() as d:
                p = Path(d) / name
                p.write_bytes(data)
                ok = await asyncio.to_thread(upload, tag, p)
            if ok:
                log(f'[fotos] subida {tag}/{name} ({len(data) // 1024} KB)')
        except Exception as e:
            log(f'[fotos] error subiendo {name}: {e!r}')
        UPLOADS.task_done()


async def photographer(c: dict, browser, deadline: float):
    slug = c['slug']
    url_ws = c.get('ws') or f"wss://{c.get('host', 'live-data.apex-timing.com')}:{c['port']}/"
    page_url = c['url']
    state = ApexState(slug, c['nombre'], c.get('tz', 'Europe/Madrid'))
    last = {'img': None, 'ts': 0.0}
    page = None
    bad = {'n': 0, 'until': 0.0}
    ctx = ssl.create_default_context()

    async def ensure_page():
        nonlocal page
        if page and not page.is_closed():
            return page
        page = await browser.new_page(viewport=VIEW, user_agent=UA, locale='es-ES')
        resp = await page.goto(page_url, wait_until='domcontentloaded', timeout=45000)
        if resp is not None and resp.status >= 400:
            raise RuntimeError(f'la página de Apex responde {resp.status}')
        await page.wait_for_timeout(4000)
        return page

    async def shoot():
        nonlocal page
        if time.time() < bad['until']:
            return
        try:
            p = await ensure_page()
            last['img'] = await p.screenshot(type='jpeg', quality=72, full_page=True, timeout=20000)
            last['ts'] = time.time()
            bad['n'] = 0
        except Exception as e:
            bad['n'] += 1
            bad['until'] = time.time() + min(1800, 60 * 2 ** bad['n'])  # si la página falla, espera cada vez más
            log(f'[fotos][{slug}] no pude hacer la foto: {e!r}')
            last['img'] = None
            try:
                if page:
                    await page.close()
            except Exception:
                pass
            page = None

    async def flush():
        while state.finished:
            s = state.finished.pop(0)
            if last['img'] and time.time() - last['ts'] < 25 * 60:
                await UPLOADS.put((f"fotos-{s['date']}", f"{s['id']}.jpg", last['img']))
            last['img'] = None

    delay, next_shot = 5, 0.0
    while time.time() < deadline:
        try:
            async with websockets.connect(url_ws, origin=c.get('origin', 'https://www.apex-timing.com'),
                                          ssl=ctx if url_ws.startswith('wss') else None, user_agent_header=UA,
                                          ping_interval=None, max_size=2 ** 24, open_timeout=20, close_timeout=5) as ws:
                delay = 5
                try:
                    await ws.send('init')
                except Exception:
                    pass
                while time.time() < deadline:
                    try:
                        msg = await asyncio.wait_for(ws.recv(), timeout=FOTO_CADA)
                        if isinstance(msg, bytes):
                            msg = msg.decode('utf-8', 'replace')
                        try:
                            state.feed(msg, time.time())
                        except Exception:
                            pass
                    except asyncio.TimeoutError:
                        pass
                    state.tick()
                    await flush()
                    # foto cada FOTO_CADA s mientras hay una sesión con vueltas
                    if state.laps and time.time() >= next_shot:
                        next_shot = time.time() + FOTO_CADA
                        await shoot()
                    elif not state.laps and page and time.time() - last['ts'] > 15 * 60:
                        try:  # sin sesión: se cierra la página para ahorrar memoria
                            await page.close()
                        except Exception:
                            pass
                        page = None
        except Exception as e:
            log(f'[fotos][{slug}] error de conexión: {e!r}; reintento en {delay}s')
            await asyncio.sleep(min(delay, max(0, deadline - time.time())))
            delay = min(delay * 2, 300)
    state.close_session(partial=True)
    await flush()


async def main_async(minutes: float, only: list[str] | None):
    from playwright.async_api import async_playwright
    global UPLOADS
    UPLOADS = asyncio.Queue()
    circuits = json.loads((ROOT / 'circuitos.json').read_text())
    active = [resolve(c) for c in circuits if c.get('grabar') and (not only or c['slug'] in only)]
    active = [c for c in active if (c.get('port') or c.get('ws')) and c.get('url') and not c.get('sin_fotos')]
    limpiar([c['slug'] for c in circuits if not c.get('url')])
    deadline = time.time() + minutes * 60
    log(f"[fotos] fotógrafo en marcha {minutes:.0f} min: {', '.join(c['slug'] for c in active)}")
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(args=['--disable-dev-shm-usage'])
        up = asyncio.create_task(uploader())
        await asyncio.gather(*(photographer(c, browser, deadline) for c in active), return_exceptions=True)
        await UPLOADS.join()
        up.cancel()
        await browser.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--minutos', type=float, default=350)
    ap.add_argument('--solo', nargs='*')
    a = ap.parse_args()
    asyncio.run(main_async(a.minutos, a.solo or None))


if __name__ == '__main__':
    main()
