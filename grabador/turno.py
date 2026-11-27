"""Decide si este turno debe grabar o si ya hay otro grabador cubriendo.

Los turnos nuevos los lanza el propio grabador cuando lleva RELEVO minutos (ver relevo() en grabar.py);
el aviso programado de GitHub (cada 30 min) queda de reserva, porque llega tarde o no llega.
Un turno solo graba si no hay otro turno en marcha, ANTERIOR a él, que haya empezado hace menos
de RELEVO minutos. Mirar solo los anteriores evita que dos turnos lanzados a la vez se cedan el paso
el uno al otro y no grabe ninguno. Así, al final de cada turno, el siguiente ya está conectado (~50 min).
Escribe grabar=true/false en $GITHUB_OUTPUT.
"""
import json
import os
import sys
import urllib.request
from datetime import datetime, timezone

RELEVO = 300  # minutos


def main():
    repo, run_id, token = os.environ.get('GITHUB_REPOSITORY'), os.environ.get('GITHUB_RUN_ID'), os.environ.get('GITHUB_TOKEN')
    forced = os.environ.get('FORZAR', '') == 'true'
    decision = True
    if not forced and repo and token:
        wf = os.environ.get('WORKFLOW', 'grabar.yml')  # el fotógrafo usa fotos.yml
        url = f'https://api.github.com/repos/{repo}/actions/workflows/{wf}/runs?status=in_progress&per_page=20'
        req = urllib.request.Request(url, headers={'Authorization': f'Bearer {token}', 'Accept': 'application/vnd.github+json'})
        try:
            runs = json.load(urllib.request.urlopen(req, timeout=20)).get('workflow_runs', [])
        except Exception as e:
            print('No pude consultar otros turnos, grabo por si acaso:', e)
            runs = []
        now = datetime.now(timezone.utc)
        start = lambda r: datetime.fromisoformat((r.get('run_started_at') or r['created_at']).replace('Z', '+00:00'))
        me = next((r for r in runs if str(r['id']) == str(run_id)), None)
        my_key = (start(me), int(me['id'])) if me else (now, int(run_id or 0))
        for r in runs:
            if str(r['id']) == str(run_id):
                continue
            started = start(r)
            age = (now - started).total_seconds() / 60
            antes = (started, int(r['id'])) < my_key
            print(f"Turno {r['id']} en marcha desde hace {age:.0f} min" + ('' if antes else ' (posterior a este: no cuenta)'))
            if age < RELEVO and antes:
                decision = False
    print('Grabar en este turno:', decision)
    out = os.environ.get('GITHUB_OUTPUT')
    if out:
        with open(out, 'a') as f:
            f.write(f"grabar={'true' if decision else 'false'}\n")


if __name__ == '__main__':
    sys.exit(main())
