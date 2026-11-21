"""Busca circuitos que publican su cronometraje en Apex Timing.

Dos métodos:
 1. Prueba nombres de circuito ("slugs") y lee su javascript/config.js (puerto, zona horaria, título).
 2. Recorre los puertos del servidor de Apex (terminan en 3) y pregunta a cada uno qué emite ahora.
Resultado: data/circuitos_detectados.json
"""
from __future__ import annotations

import asyncio
import json
import re
import ssl
import time
import urllib.request
from pathlib import Path

import websockets

ROOT = Path(__file__).resolve().parent.parent
HOST = 'live-data.apex-timing.com'
UA = 'Mozilla/5.0 (compatible; descubrir)'
CFG = {k: re.compile(p) for k, p in {
    'port': r"var\s+configPort\s*=\s*(\d+)", 'gmt': r"var\s+configGMT\s*=\s*(-?\d+)",
    'title': r"var\s+title\s*=\s*'([^']*)'", 'logo': r"var\s+logo_title\s*=\s*'([^']*)'",
    'host': r"var\s+configHost\s*=\s*'([^']*)'"}.items()}

# Nombres probables de circuitos (sobre todo España). Se pueden añadir más en candidatos.txt
BASE = """
ariza-racing-circuit kartodromo-lucas-guerrero karting-los-santos los-santos karting-club-los-santos
kclossantos kartinglossantos karting-campillos campillos circuito-campillos karting-la-roca la-roca
karting-vendrell vendrell circuit-vendrell karting-alcaniz motorland karting-zuera zuera
karting-sils sils karting-cuenca karting-recas recas karting-toledo karting-valencia karting-betera
karting-paterna karting-mallorca karting-magaluf karting-sevilla karting-malaga karting-marbella
karting-tenerife karting-club-tenerife karting-gran-canaria karting-bilbao karting-urdax urdax
karting-galicia karting-ourense karting-cheste circuito-fernando-alonso fernando-alonso
karting-fernando-alonso karting-asturias karting-burgos karting-salamanca karting-valladolid
karting-alicante karting-alacant karting-murcia karting-cartagena karting-almeria karting-granada
karting-cordoba karting-jerez karting-huelva karting-cartaya karting-zaragoza karting-lleida
karting-tarragona karting-girona karting-barcelona karting-castelldefels karting-navarra los-arcos
karting-logrono karting-santander karting-jarama karting-rivas karting-getafe karting-madrid
kart-indoor-madrid karting-alcala karting-torrejon karting-arganda karting-chinchon henakart
karting-henares karting-guadalajara karting-segovia karting-avila karting-talavera karting-leon
karting-lugo karting-vigo karting-coruna karting-pamplona karting-vitoria karting-donostia
karting-castellon karting-benidorm karting-torrevieja karting-ibiza karting-menorca karting-lanzarote
karting-fuerteventura kartodromo-de-campillos kartodromo-motorland kartodromo-valencia
kartodromo-de-recas kartodromo-de-alcaniz kartodromo-del-jarama circuito-de-recas
karting-carlos-sainz carlos-sainz-karting carlossainzkarting karting-pedro-de-la-rosa
karting-pedrosa karting-dani-pedrosa kartingcenter kart-center karting-race karting-xtreme
kartodromo-de-cheste kartodromo-recas rkr ksr kart-racing-spain madkart big-karting
kartodromodeviana kartodromo-de-viana kartodromo-viana viana-do-castelo kartodromo-internacional-de-viana
cabodomundokarting kartodromo-de-baltar kartodromo-braga kartodromo-de-leiria kartodromo-de-palmela
""".split()


def candidates():
    extra = ROOT / 'candidatos.txt'
    names = BASE + (extra.read_text().split() if extra.exists() else [])
    out = []
    for n in names:
        for v in (n, n.replace('-', '')):
            if v not in out:
                out.append(v)
    return out


def probe_slug(slug):
    for base, host in ((f'https://www.apex-timing.com/live-timing/{slug}/', 'www'),
                       (f'https://live.apex-timing.com/{slug}/', 'live')):
        try:
            req = urllib.request.Request(base + 'javascript/config.js', headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=12) as r:
                body = r.read().decode('utf-8', 'replace')
        except Exception:
            continue
        m = CFG['port'].search(body)
        if not m:
            continue
        g = {k: (rx.search(body).group(1) if rx.search(body) else '') for k, rx in CFG.items()}
        return {'slug': slug, 'url': base + 'index.html', 'config_port': int(g['port']),
                'port': int(g['port']) + 3, 'gmt': g['gmt'], 'titulo_web': g['title'] or g['logo'],
                'host': g['host'] or HOST}
    return None


async def ws_probe(port, timeout=8):
    url = f'wss://{HOST}:{port}/'
    info = {'port': port, 'vivo': False}
    try:
        async with websockets.connect(url, ssl=ssl.create_default_context(), origin='https://www.apex-timing.com',
                                      open_timeout=timeout, close_timeout=2, ping_interval=None,
                                      max_size=2 ** 23) as ws:
            info['vivo'] = True
            try:
                await ws.send('init')
            except Exception:
                pass
            end = time.time() + timeout
            rows = 0
            while time.time() < end:
                try:
                    msg = await asyncio.wait_for(ws.recv(), timeout=max(0.5, end - time.time()))
                except Exception:
                    break
                if isinstance(msg, bytes):
                    msg = msg.decode('utf-8', 'replace')
                for line in msg.split('\n'):
                    p = line.split('|', 2)
                    if len(p) == 3 and p[0] in ('title1', 'title2', 'track', 'com') and p[2].strip():
                        info[p[0]] = re.sub('<[^>]+>', ' ', p[2]).strip()[:120]
                    if p[0] in ('init', 'grid') and len(p) == 3:
                        rows = max(rows, p[2].count('data-id="r') - 1)
                if 'title1' in info and rows:
                    break
            info['filas'] = max(rows, 0)
    except Exception as e:
        info['error'] = type(e).__name__
    return info


async def tcp_open(port, timeout=3):
    try:
        r, w = await asyncio.wait_for(asyncio.open_connection(HOST, port), timeout)
        w.close()
        return True
    except Exception:
        return False


async def scan_ports(ports, concurrency=25):
    sem = asyncio.Semaphore(concurrency)
    found = []

    async def one(p):
        async with sem:
            if await tcp_open(p):
                info = await ws_probe(p)
                if info.get('vivo'):
                    found.append(info)
                    print(f"  puerto {p}: {info.get('title1', '')} | {info.get('title2', '')} | {info.get('track', '')}",
                          flush=True)
    await asyncio.gather(*(one(p) for p in ports))
    return found


def main():
    print('1) Probando nombres de circuito…', flush=True)
    by_slug = []
    for s in candidates():
        r = probe_slug(s)
        if r:
            print(f"  ✓ {s}: puerto {r['port']} gmt {r['gmt']} «{r['titulo_web']}»", flush=True)
            by_slug.append(r)
        time.sleep(0.2)
    known = ROOT / 'circuitos.json'
    for c in json.loads(known.read_text()) if known.exists() else []:
        if c.get('port') and not any(x['port'] == c['port'] for x in by_slug):
            by_slug.append({'slug': c['slug'], 'port': c['port'], 'url': c.get('url', ''), 'titulo_web': c['nombre']})

    print('2) Recorriendo puertos del servidor de Apex…', flush=True)
    ports = list(range(6003, 10000, 10))
    live = asyncio.run(scan_ports(ports))

    merged = {}
    for r in by_slug:
        merged[r['port']] = dict(r)
    for l in live:
        merged.setdefault(l['port'], {'port': l['port']}).update({k: v for k, v in l.items() if k != 'port'})
    out = sorted(merged.values(), key=lambda x: x['port'])
    dest = ROOT / 'data' / 'circuitos_detectados.json'
    dest.parent.mkdir(exist_ok=True)
    dest.write_text(json.dumps({'fecha': time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime()), 'circuitos': out},
                               ensure_ascii=False, indent=1))
    print(f"Listo: {len(by_slug)} por nombre, {len(live)} canales en directo. Guardado en {dest}")


if __name__ == '__main__':
    main()
