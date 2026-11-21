"""Decide si este turno debe grabar o si ya hay otro grabador cubriendo.

Hay un turno nuevo cada 30 min. Solo graba si no hay otro grabador en marcha
que haya empezado hace menos de RELEVO minutos. Así siempre hay un grabador
activo y, al final de cada uno, el siguiente ya está conectado (solapan ~50 min).
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
        url = f'https://api.github.com/repos/{repo}/actions/workflows/grabar.yml/runs?status=in_progress&per_page=20'
        req = urllib.request.Request(url, headers={'Authorization': f'Bearer {token}', 'Accept': 'application/vnd.github+json'})
        try:
            runs = json.load(urllib.request.urlopen(req, timeout=20)).get('workflow_runs', [])
        except Exception as e:
            print('No pude consultar otros turnos, grabo por si acaso:', e)
            runs = []
        now = datetime.now(timezone.utc)
        for r in runs:
            if str(r['id']) == str(run_id):
                continue
            started = datetime.fromisoformat((r.get('run_started_at') or r['created_at']).replace('Z', '+00:00'))
            age = (now - started).total_seconds() / 60
            print(f"Turno {r['id']} en marcha desde hace {age:.0f} min")
            if age < RELEVO:
                decision = False
    print('Grabar en este turno:', decision)
    out = os.environ.get('GITHUB_OUTPUT')
    if out:
        with open(out, 'a') as f:
            f.write(f"grabar={'true' if decision else 'false'}\n")


if __name__ == '__main__':
    sys.exit(main())
