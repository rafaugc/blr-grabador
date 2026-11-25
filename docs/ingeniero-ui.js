// ===== Vistas compartidas: pop-up de kart, desglose por piloto de un equipo, pantalla del ingeniero =====
(function (root) {
  const I = root.Ingeniero;
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtT = x => { if (x == null || !isFinite(x)) return '–'; const m = Math.floor(x / 60), s = x - m * 60; return (m ? m + ':' + (s < 10 ? '0' : '') : '') + s.toFixed(3).replace('.', ','); };
  const fmt = (x, d = 2) => x == null || !isFinite(x) ? '–' : (x < 0 ? '−' : x > 0 ? '+' : '±') + Math.abs(x).toFixed(d).replace('.', ',');
  const clk = I.clockFmt;
  const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
  const badge = c => `<span class="kcls" style="color:${c.c};border-color:${c.c}55;background:${c.c}14">${c.n}</span>`;

  // clase por quintiles de una lista de karts ya ordenada de más rápido a más lento
  function quintile(i, n) { return I.CLASSES[Math.min(4, Math.floor((n > 1 ? i / (n - 1) : 0.5) * 5))]; }

  // ---------- pop-up de un kart ----------
  // k: kart del análisis (KartCore.analyze), A: análisis completo, sessions: sesiones con vueltas, idOf: id de sesión
  function kartPopup(k, A, sessions, idOf, cls) {
    const dmap = {}; A.drivers.forEach(d => dmap[d.driver] = d);
    const keff = {}; A.karts.forEach(x => keff[x.kart] = x.effect);
    const clean = d => String(d || '').replace(/^\d{1,3}\s*-\s*/, '').replace(/\s*\[\d{1,2}:\d{2}(?::\d{2})?\]\s*$/, '').trim().toUpperCase().replace(/[ÁÀÂÄ]/g, 'A').replace(/[ÉÈÊË]/g, 'E').replace(/[ÍÌÎÏ]/g, 'I').replace(/[ÓÒÔÖ]/g, 'O').replace(/[ÚÙÛÜ]/g, 'U').replace(/\s+/g, ' ');
    const label = s => (s.title || s.type || '') + ' · ' + (s.time || '');
    const by = {};
    sessions.forEach(s => s.stints.forEach(t => {
      if (String(t.kart) !== String(k.kart) || !t.laps || !t.laps.length) return;
      const d = clean(t.driver);
      const o = by[d] = by[d] || { driver: d, team: t.team || '', laps: 0, best: Infinity, bestSes: '', b3: null, b5: null, top5: [], all: [], tandas: 0 };
      o.tandas++; o.laps += t.laps.length;
      const best = Math.min(...t.laps);
      if (best < o.best) { o.best = best; o.bestSes = label(s); }
      const b3 = I.bestN(t.laps, 3), b5 = I.bestN(t.laps, 5);
      if (b3 != null && (o.b3 == null || b3 < o.b3)) o.b3 = b3;
      if (b5 != null && (o.b5 == null || b5 < o.b5)) o.b5 = b5;
      o.all.push(t.laps);
    }));
    // ¿cuánto mejor fue ese piloto con este kart que con los demás?
    const vsSelf = d => {
      const v = (dmap[d] ? dmap[d].stints : []); const mine = v.filter(t => String(t.kart) === String(k.kart)), others = v.filter(t => String(t.kart) !== String(k.kart));
      const dv = t => t.adj != null ? t.adj : t.delta; // frente al nivel de la sesión según el modelo: así no engaña comparar categorías de peso distintas
      return mine.length && others.length ? mean(mine.map(dv)) - mean(others.map(dv)) : null;
    };
    const rows = Object.values(by).sort((a, b) => a.best - b.best);
    const vrDriver = rows[0];
    const vsList = rows.map(r => vsSelf(r.driver)).filter(x => x != null);
    // gráfico vuelta a vuelta
    const W = 560, H = 150, pad = 26;
    const series = rows.map(r => r.all.reduce((a, l) => a.length >= l.length ? a : l, []).slice(1));
    const allT = series.flat().filter(Boolean); const lo = Math.min(...allT), hi = Math.min(Math.max(...allT), lo + 3);
    const maxN = Math.max(1, ...series.map(s => s.length));
    const colors = ['#b38cff', '#ffd23f', '#3ddc84', '#4cc3ff', '#ff8fb1', '#ffa24c', '#a6e36a', '#c9cdd6'];
    const chart = allT.length > 2 ? `<svg viewBox="0 0 ${W} ${H}" class="kchart">${[0, 0.5, 1].map(f => { const y = pad / 2 + f * (H - pad); return `<line x1="${pad + 10}" x2="${W}" y1="${y}" y2="${y}" stroke="#262a33"/><text x="0" y="${y + 4}" fill="#5d636e" font-size="10">${(lo + f * (hi - lo)).toFixed(1).replace('.', ',')}</text>`; }).join('')}
      ${series.map((s, i) => `<polyline fill="none" stroke="${colors[i % 8]}" stroke-width="1.8" points="${s.map((t, j) => `${pad + 10 + j * (W - pad - 12) / Math.max(1, maxN - 1)},${pad / 2 + (Math.min(t, hi) - lo) / (hi - lo || 1) * (H - pad)}`).join(' ')}"/>`).join('')}</svg>
      <div class="legend">${rows.map((r, i) => `<span><i style="background:${colors[i % 8]}"></i>${esc(r.driver)}</span>`).join('')}</div>` : '';
    return `<div class="mhead">
        <div class="mk ${cls || ''}">${esc(k.kart)}</div>
        <div><div class="mtitle">Kart ${esc(k.kart)} ${k.qcls ? badge(k.qcls) : ''}</div>
          <div class="mini">${fmt(k.effect)} s/vuelta frente a un kart medio · ${k.n} tandas · ${k.drivers} pilotos</div>
          ${vrDriver ? `<div class="mini">VR del kart: <b class="purple num">${fmtT(vrDriver.best)}</b> · <span class="purple">${esc(vrDriver.driver)}</span> · ${esc(vrDriver.bestSes)}</div>` : ''}</div>
        <button class="mclose" data-close>✕</button></div>
      <div class="mstats">
        <div><span>Mejor ritmo 3v</span><b class="num">${fmtT(Math.min(...rows.map(r => r.b3 ?? Infinity)))}</b></div>
        <div><span>Mejor ritmo 5v</span><b class="num">${fmtT(Math.min(...rows.map(r => r.b5 ?? Infinity)))}</b></div>
        <div><span>Pilotos más rápidos con él que con otros karts</span><b class="num">${vsList.filter(x => x < 0).length} de ${vsList.length}</b></div>
      </div>
      <div class="scroll"><table><thead><tr><th class="l">Piloto</th><th>VR</th><th class="l">Sesión de la VR</th><th>Mejor ritmo 3v</th><th>Mejor ritmo 5v</th><th title="Lo rápido que es el piloto, con el kart descontado">Nivel piloto</th><th title="Cuánto más rápido fue con este kart que con los otros que llevó">Vs. sus otros karts</th><th>Vueltas</th></tr></thead><tbody>
      ${rows.map((r, i) => { const v = vsSelf(r.driver); return `<tr><td class="l ${i === 0 ? 'purple' : ''}"><b>${esc(r.driver)}</b>${r.team ? `<div class="mini">${esc(r.team)}</div>` : ''}</td>
        <td class="num ${i === 0 ? 'purple' : ''}">${fmtT(r.best)}</td><td class="l mini">${esc(r.bestSes)}</td>
        <td class="num">${fmtT(r.b3)}</td><td class="num">${fmtT(r.b5)}</td>
        <td class="num">${dmap[r.driver] ? fmt(dmap[r.driver].skill) : '–'}</td>
        <td class="num ${v == null ? '' : v < -0.05 ? 't-fast' : v > 0.05 ? 't-slow' : ''}">${v == null ? '–' : fmt(v)}</td><td class="num">${r.laps}</td></tr>`; }).join('')}
      </tbody></table></div>
      ${chart ? `<h4 style="margin-top:14px">Vuelta a vuelta (sin la 1ª)</h4>${chart}` : ''}
      <div class="mini" style="margin-top:8px"><span class="purple">Morado</span> = vuelta rápida del kart y quien la hizo · “Mejor ritmo 3v/5v” = mejor media de 3 o 5 vueltas seguidas · “Vs. sus otros karts” negativo = ese piloto fue más rápido con este kart.</div>`;
  }

  // ---------- desglose por piloto de un equipo ----------
  // laps: [{t, ts, driver, pits?}] del equipo (orden de paso), now: s, pitTs: momentos de parada del equipo, curDriver
  function driverRows(laps, now, pitTs, curDriver, colspan, allPace) {
    const by = {};
    let stintIdx = 0; const pits = (pitTs || []).slice().sort((a, b) => a - b);
    laps.forEach(l => {
      while (stintIdx < pits.length && l.ts > pits[stintIdx]) stintIdx++;
      const d = l.driver || '—';
      const o = by[d] = by[d] || { driver: d, t: 0, laps: [], stints: new Set(), stintLaps: {} };
      o.t += l.t; o.laps.push(l.t); o.stints.add(stintIdx);
      (o.stintLaps[stintIdx] = o.stintLaps[stintIdx] || []).push(l.t);
    });
    const lastPit = pits.length ? pits[pits.length - 1] : null;
    const list = Object.values(by).sort((a, b) => b.t - a.t);
    return list.map(o => {
      const segs = Object.values(o.stintLaps);
      const b3 = Math.min(...segs.map(s => I.bestN(s, 3) ?? Infinity)), b5 = Math.min(...segs.map(s => I.bestN(s, 5) ?? Infinity));
      const curSeg = o.stintLaps[pits.length];
      const isCur = o.driver === curDriver;
      const l3 = isCur && curSeg ? I.lastN(curSeg, 3) : null, l5 = isCur && curSeg ? I.lastN(curSeg, 5) : null;
      const rank = allPace && isFinite(b5) ? allPace.filter(x => x < b5 - 1e-9).length + 1 : null;
      return `<tr class="sub-row"><td></td><td class="l" colspan="2">${isCur ? '<span class="dot"></span>' : ''}<b>${esc(o.driver)}</b>
        <div class="mini">${isCur ? 'en pista' + (lastPit != null ? ' · relevo ' + clk(now - lastPit) : ' · desde la salida') : 'descansando'}</div></td>
        <td class="num" title="Tiempo conducido">${clk(o.t)}</td><td class="num">${o.laps.length} v</td>
        <td class="num purple">${fmtT(Math.min(...o.laps))}</td>
        <td class="num">${fmtT(l3)}</td><td class="num">${fmtT(l5)}</td>
        <td class="num">${fmtT(isFinite(b3) ? b3 : null)}</td><td class="num">${fmtT(isFinite(b5) ? b5 : null)}</td>
        <td class="num">${rank ? rank + 'º' : '–'}</td><td class="num">${o.stints.size}</td>${colspan ? `<td colspan="${colspan}"></td>` : ''}</tr>`;
    }).join('');
  }

  // ---------- pantalla del ingeniero ----------
  function engineer(cfg, TR, adv, myId, opts) {
    opts = opts || {};
    const D = cfg.dur * 60, now = adv.now;
    const T = TR.teams[myId];
    const LV = { must: ['#b3261e', '#fff'], go: ['#1f7a3a', '#fff'], hold: ['#1d3a6b', '#fff'], wait: ['#2a2f3a', '#e9ebf0'], ok: ['#2a2f3a', '#e9ebf0'], end: ['#2a2f3a', '#e9ebf0'] }[adv.level || 'ok'];
    const pct = x => Math.max(0, Math.min(100, x / D * 100));
    // línea de tiempo
    const stints = T ? T.stints : [];
    const drvColor = {}; const pal = ['#ffd23f', '#4cc3ff', '#ff8fb1', '#a6e36a'];
    cfg.drivers.forEach((d, i) => drvColor[d] = pal[i % 4]);
    const tl = `<div class="tl">
      <div class="tlwin" style="left:${pct(cfg.pitOpen * 60)}%;width:${pct(adv.pitCloseAt) - pct(cfg.pitOpen * 60)}%"></div>
      ${stints.map((s, i) => { const a = s.start, b = s.end ?? now; const d = (s.laps[0] || {}).driver || ''; return `<div class="tlst" style="left:${pct(a)}%;width:${Math.max(0.3, pct(b) - pct(a))}%;background:${drvColor[d] || '#8a909c'}" title="${esc(d)} ${clk(b - a)}"><span>${esc(d)}</span></div>`; }).join('')}
      ${T ? T.pitTimes.map(p => `<div class="tlpit" style="left:${pct(p)}%"></div>`).join('') : ''}
      ${isFinite(adv.maxAt) && adv.maxAt > now ? `<div class="tlmax" style="left:${pct(adv.maxAt)}%" title="Último momento para parar"></div>` : ''}
      ${adv.earliest > now ? `<div class="tlmin" style="left:${pct(adv.earliest)}%"></div>` : ''}
      <div class="tlnow" style="left:${pct(now)}%"></div>
    </div>
    <div class="tlax"><span>0:00</span><span>pit abre ${clk(cfg.pitOpen * 60)}</span><span>${clk(D / 2)}</span><span>última entrada ${clk(adv.pitCloseAt)}</span><span>${clk(D)}</span></div>`;
    // barra del relevo actual
    const sMax = cfg.stintMax * 60, sMin = cfg.stintMin * 60;
    const stBar = `<div class="sbar"><div class="sfill" style="width:${Math.min(100, adv.stintT / sMax * 100)}%;background:${adv.stintT < sMin ? '#5d636e' : adv.stintT > sMax - 180 ? '#ff5f5f' : '#3ddc84'}"></div><div class="smin" style="left:${sMin / sMax * 100}%"></div></div>
      <div class="tlax"><span>0</span><span>mín ${cfg.stintMin}′</span><span>máx ${cfg.stintMax}′</span></div>`;
    // box
    const slot = s => {
      const sure = s.sure;
      const probs = Object.entries(s.probs).filter(([, p]) => p > 0.04).sort((a, b) => b[1] - a[1]);
      const allC = I.CLASSES.concat([I.UNKNOWN]);
      return `<div class="slot" style="border-color:${s.cls.c}">
        <div class="slpos">${s.pos === 0 ? 'SIGUIENTE' : s.pos + 1 + 'º'}</div>
        <div class="slk" style="color:${s.cls.c}">${sure ? (sure.surprise ? '?' : esc(sure.id > 4999 ? '•' : sure.id)) : '?'}</div>
        <div class="slc" style="color:${s.cls.c}">${sure ? s.cls.n : 'Probable'}</div>
        ${sure ? `<div class="mini">${sure.est != null ? fmt(sure.est) + ' s' : 'sin datos'}</div><div class="mini">${esc(sure.label)}</div>` :
          `<div class="pbar">${probs.map(([c, p]) => { const cc = allC.find(x => x.k === c); return `<i style="width:${p * 100}%;background:${cc.c}" title="${cc.n} ${Math.round(p * 100)}%"></i>`; }).join('')}</div>
           <div class="mini">${probs.slice(0, 2).map(([c, p]) => allC.find(x => x.k === c).n + ' ' + Math.round(p * 100) + '%').join(' · ')}</div>`}
      </div>`;
    };
    const boxHTML = TR.box.map((row, ri) => `<div class="boxrow"><div class="boxlab">${TR.box.length > 1 ? 'Fila ' + 'AB'[ri] : 'Fila'}<span>salida ➜</span></div>${row.map(slot).join('')}</div>`).join('');
    // pilotos
    const drv = adv.drive || [];
    const need = cfg.minDriver * 60;
    const drvHTML = drv.map(d => `<div class="drow"><span class="dname"><i style="background:${drvColor[d.name] || '#8a909c'}"></i>${esc(d.name)}${d.name === adv.driverNow ? ' <span class="mini">(al volante)</span>' : ''}</span>
      <div class="dbar"><div style="width:${Math.min(100, d.t / Math.max(need * 1.6, 1) * 100)}%;background:${d.need > 0 ? '#ffa24c' : '#3ddc84'}"></div><div class="dmin" style="left:${100 / 1.6}%"></div></div>
      <span class="num">${clk(d.t)}</span><span class="mini">${!cfg.minDriver ? '' : d.need > 0 ? 'faltan ' + clk(d.need) : '✓ mínimo'}</span></div>`).join('');
    // ranking de karts en tiempo real
    const ks = Object.values(TR.karts).filter(k => k.est != null && !k.guess).sort((a, b) => a.est - b.est);
    const where = k => k.inBox ? `box ${TR.box.length > 1 ? 'fila ' + 'AB'[+k.inBox[0] - 1] + ' ' : ''}${k.inBox.split('·')[1]}º` : k.team ? esc(k.team) : k.boxP > 0.05 ? `box (${Math.round(Math.min(1, k.boxP) * 100)}% prob.)` : 'en pista (equipo no seguro)';
    const cur = adv.cur;
    return `
    <div class="adv" style="background:${LV[0]};color:${LV[1]}">
      <div class="advt">${esc(adv.title || '')}</div><div class="advx">${esc(adv.text || '')}</div>
      ${opts.controls || ''}
    </div>
    <div class="kpis">
      <div class="kpi"><span>Carrera</span><b class="num">${clk(now)}</b><small>quedan ${clk(adv.left)}</small></div>
      <div class="kpi"><span>Relevo actual</span><b class="num">${clk(adv.stintT)}</b><small>${esc(adv.driverNow || '')}</small></div>
      <div class="kpi"><span>Paradas</span><b class="num">${adv.stops} / ${cfg.stopsMin}</b><small>${adv.stopsLeft ? 'faltan ' + adv.stopsLeft : 'cumplidas'}</small></div>
      <div class="kpi"><span>Ventana de pit</span><b style="color:${adv.windowNow ? '#3ddc84' : '#ff5f5f'}">${adv.windowNow ? 'Abierta' : 'Cerrada'}</b><small>${now < adv.earliest ? 'puedes parar en ' + clk(adv.earliest - now) : 'puedes parar ya'}</small></div>
      <div class="kpi"><span>Para antes de</span><b class="num" style="color:${adv.toMax < 180 ? '#ff5f5f' : ''}">${isFinite(adv.toMax) ? clk(adv.toMax) : '—'}</b><small>${isFinite(adv.maxAt) ? 'min. ' + clk(adv.maxAt) + ' de carrera' : 'sin obligación'}</small></div>
    </div>
    <div class="card"><h4>Tu carrera</h4>${tl}<h4 style="margin-top:14px">Relevo actual</h4>${stBar}</div>
    <div class="grid2">
      <div class="card"><h4>Box ahora mismo</h4>${boxHTML}
        <div class="mini" style="margin-top:8px">${TR.box.length === 1 ? 'Una fila: el que entra coge el primero y deja el suyo al final. Los karts del box al empezar son sorpresa hasta que alguien los lleva; a partir de ahí se siguen uno a uno aunque cambien de dorsal.' : 'Dos filas: no sabemos a qué fila entra cada equipo, así que se calcula la probabilidad de cada clase. Cuando tú entres, marca tu fila para afinar.'}</div></div>
      <div class="card"><h4>Tu kart vs. el que te tocaría</h4>
        <div class="vs"><div><span class="mini">Ahora llevas</span><div class="vsk" style="color:${cur ? cur.cls.c : '#888'}">${cur ? cur.cls.n : '–'}</div><div class="mini num">${cur && cur.est != null ? fmt(cur.est) + ' s/v' : 'sin datos'}</div></div>
        <div class="vsarrow">➜</div>
        <div><span class="mini">Si entras ya</span><div class="vsk" style="color:${adv.nextCls ? adv.nextCls.c : '#888'}">${adv.nextCls ? (adv.fronts.length > 1 ? '~' : '') + adv.nextCls.n : '–'}</div><div class="mini num">${adv.nextEst != null ? fmt(adv.nextEst) + ' s/v' : 'sin datos'}</div></div></div>
        ${adv.gainTotal != null ? `<div class="mini" style="text-align:center;margin-top:6px">Diferencia en el próximo relevo: <b class="${adv.gainTotal > 0 ? 't-fast' : 't-slow'}">${adv.gainTotal > 0 ? 'ganas' : 'pierdes'} ~${Math.abs(adv.gainTotal).toFixed(1).replace('.', ',')} s</b></div>` : ''}
        <h4 style="margin-top:14px">${cfg.drivers.length > 1 ? `Pilotos · mínimo ${cfg.minDriver}′` : 'Tiempo al volante'}</h4>${drvHTML}
        ${adv.driverWarn ? `<div class="mini t-vslow">${esc(adv.driverWarn)}</div>` : ''}</div>
    </div>
    <div class="grid2">
      <div class="card"><h4>Rivales que tienen que parar pronto</h4><div class="mini" style="margin:-4px 0 6px">Por relevo máximo o porque si no, no les da tiempo a hacer las paradas que les faltan.</div>
        ${adv.soon && adv.soon.length ? `<table><thead><tr><th class="l">${cfg.drivers.length > 1 ? 'Equipo' : 'Piloto'}</th><th>Relevo</th><th>Debe parar en</th><th class="l">Su kart</th></tr></thead><tbody>${adv.soon.map(x => `<tr><td class="l">${esc(x.name)}</td><td class="num">${clk(x.stintT)}</td><td class="num ${x.toMax < 120 ? 't-vslow' : ''}">${clk(x.toMax)}</td><td class="l">${badge(x.cls)}</td></tr>`).join('')}</tbody></table>` : '<div class="mini">Nadie cerca de su máximo.</div>'}
        <div class="mini" style="margin-top:6px">Cada uno que entre antes que tú se lleva el primer kart del box.</div></div>
      <div class="card"><h4>Ranking de karts en tiempo real</h4><div class="scroll" style="max-height:300px">
        <table><thead><tr><th class="l">#</th><th class="l">Kart</th><th class="l">Clase</th><th>s/vuelta</th><th class="l">Dónde está</th></tr></thead><tbody>
        ${ks.map((k, i) => `<tr class="${T && k.id === T.cur ? 'me' : ''}"><td class="l mini">${i + 1}</td><td class="l mini">${esc(k.label)}</td><td class="l">${badge(k.cls)}</td><td class="num">${fmt(k.est)}</td><td class="l mini">${where(k)}</td></tr>`).join('')}
        </tbody></table></div>
        <div class="mini" style="margin-top:6px">Calidad = ritmo del kart quitando el nivel de cada equipo (mismo modelo que el ranking de karts). Clases por quintiles: Pepino 20% más rápido · Bueno · Medio · Malo · Cepo 20% más lento.</div></div>
    </div>`;
  }

  function rulesForm(cfg) {
    const f = (k, l, h, step) => `<label class="fld"><span>${l}</span><input type="number" data-cfg="${k}" value="${cfg[k]}" step="${step || 1}" min="0"><small>${h || ''}</small></label>`;
    const P = I.PRESETS;
    return `<div class="card"><h4>Plantilla</h4><div class="row">${Object.entries(P).map(([k, p]) => `<button class="${cfg.preset === k ? 'btn' : 'btn ghost'}" data-preset="${k}">${esc(p.name)}</button>`).join('')}</div>
      ${P[cfg.preset] ? `<div class="mini" style="margin-top:8px">${esc(P[cfg.preset].notes)}</div>` : ''}</div>
      <div class="card"><h4>Reglamento de la carrera</h4>
      <div class="flds">
        ${f('dur', 'Duración (min)')}
        ${f('minDriver', 'Mínimo por piloto (min)')}
        ${f('stintMin', 'Relevo mínimo (min)')}
        ${f('stintMax', 'Relevo máximo (min)', 'igual a la duración = sin máximo')}
        ${f('pitOpen', 'El pit abre a los (min)', 'desde la salida')}
        ${f('pitClose', 'El pit cierra a falta de (min)', '0 = abierto hasta el final')}
        ${f('stopsMin', 'Paradas obligatorias')}
        ${f('pitLoss', 'Tiempo perdido por parada (s)', 'frente a dar la vuelta normal')}
        <label class="fld"><span>Filas de karts en el box</span><select data-cfg="rows"><option value="1" ${cfg.rows === 1 ? 'selected' : ''}>1 fila</option><option value="2" ${cfg.rows === 2 ? 'selected' : ''}>2 filas</option></select></label>
        ${f('boxKarts', 'Karts esperando en el box')}
        <label class="fld" style="grid-column:1/-1"><span>Pilotos de tu equipo (separados por comas; uno solo si es individual)</span><input type="text" data-cfg="drivers" value="${esc(cfg.drivers.join(', '))}"></label>
      </div></div>`;
  }
  function readRules(el, cfg) {
    const c = Object.assign({}, cfg);
    el.querySelectorAll('[data-cfg]').forEach(i => { const k = i.dataset.cfg; c[k] = k === 'drivers' ? i.value.split(',').map(x => x.trim().toUpperCase()).filter(Boolean) : +i.value; });
    if (c.drivers.length < 1) c.drivers = cfg.drivers;
    c.preset = 'propio';
    return c;
  }

  const CSS = `
.kcls{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid;font-weight:600;white-space:nowrap}
.modal[hidden]{display:none!important}
.modal{position:fixed;inset:0;background:rgba(0,0,0,.65);display:flex;align-items:flex-start;justify-content:center;z-index:50;padding:30px 12px;overflow:auto}
.modal .box{background:#14161b;border:1px solid #262a33;border-radius:14px;max-width:880px;width:100%;padding:16px}
.mhead{display:flex;gap:14px;align-items:center;margin-bottom:12px}.mk{font:700 46px/1 "Barlow Condensed";min-width:60px;text-align:center}
.mtitle{font:700 22px "Barlow Condensed";display:flex;gap:8px;align-items:center}.mclose{margin-left:auto;background:none;border:1px solid #262a33;border-radius:8px;color:#e9ebf0;font-size:18px;width:36px;height:36px;cursor:pointer}
.mstats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px}.mstats div{background:#1b1e25;border-radius:10px;padding:8px 10px}.mstats span{display:block;font-size:11px;color:#8a909c}.mstats b{font-size:18px}
.kchart{width:100%;height:auto;display:block}.legend{display:flex;gap:12px;flex-wrap:wrap;font-size:12px;color:#8a909c;margin-top:4px}.legend i{display:inline-block;width:10px;height:3px;margin-right:5px;vertical-align:middle}
tr.team{cursor:pointer}tr.team:hover td{background:#171a20}tr.team td:first-child:before{content:"▸ ";color:#5d636e}tr.team.open td:first-child:before{content:"▾ "}
tr.sub-row td{background:#101216;font-size:13px;padding:6px 7px}.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#3ddc84;margin-right:6px}
tr.me td{background:#221e0e}
.adv{border-radius:14px;padding:16px 18px;margin-bottom:12px}.advt{font:700 30px/1.05 "Barlow Condensed";letter-spacing:.3px}.advx{margin-top:4px;opacity:.9}
.kpis{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-bottom:12px}@media(max-width:760px){.kpis{grid-template-columns:repeat(2,1fr)}}
.kpi{background:#14161b;border:1px solid #262a33;border-radius:12px;padding:10px 12px}.kpi span{display:block;font-size:11px;color:#8a909c;text-transform:uppercase;letter-spacing:.05em}.kpi b{font-size:22px;display:block;margin:2px 0}.kpi small{color:#8a909c;font-size:12px}
.tl{position:relative;height:34px;background:#1b1e25;border-radius:8px;overflow:hidden}.tlwin{position:absolute;top:0;bottom:0;background:#3ddc8414;border-left:1px dashed #3ddc8466;border-right:1px dashed #3ddc8466}
.tlst{position:absolute;top:6px;height:22px;border-radius:4px;opacity:.85;overflow:hidden}.tlst span{font-size:10px;color:#111;padding-left:4px;font-weight:600;white-space:nowrap}
.tlpit{position:absolute;top:0;bottom:0;width:2px;background:#e9ebf0}.tlnow{position:absolute;top:-2px;bottom:-2px;width:2px;background:#ffd23f;box-shadow:0 0 6px #ffd23f}
.tlmax{position:absolute;top:0;bottom:0;width:3px;background:#ff5f5f}.tlmin{position:absolute;top:0;bottom:0;width:2px;background:#3ddc84}
.tlax{display:flex;justify-content:space-between;font-size:11px;color:#5d636e;margin-top:3px}
.sbar{position:relative;height:14px;background:#1b1e25;border-radius:7px;overflow:hidden}.sfill{height:100%;border-radius:7px}.smin{position:absolute;top:0;bottom:0;width:2px;background:#e9ebf0aa}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media(max-width:760px){.grid2{grid-template-columns:1fr}}
.boxrow{display:flex;gap:8px;align-items:stretch;margin-bottom:8px;overflow-x:auto}.boxlab{display:flex;flex-direction:column;justify-content:center;font-size:12px;color:#8a909c;min-width:52px}.boxlab span{font-size:10px;color:#5d636e}
.slot{flex:0 0 110px;border:2px solid;border-radius:12px;padding:8px;text-align:center;background:#101216}.slot:first-of-type{flex-basis:130px}
.slpos{font-size:10px;color:#8a909c;letter-spacing:.08em}.slk{font:700 34px/1 "Barlow Condensed";margin:2px 0}.slc{font-weight:700;font-size:14px}
.pbar{display:flex;height:8px;border-radius:4px;overflow:hidden;margin:6px 0 2px}
.vs{display:flex;align-items:center;justify-content:space-around;text-align:center}.vsk{font:700 34px/1.1 "Barlow Condensed"}.vsarrow{font-size:26px;color:#5d636e}
.drow{display:grid;grid-template-columns:150px 1fr 60px 90px;gap:8px;align-items:center;margin:6px 0;font-size:13px}.dname i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:6px}
.dbar{position:relative;height:10px;background:#1b1e25;border-radius:5px;overflow:hidden}.dbar>div:first-child{height:100%}.dmin{position:absolute;top:0;bottom:0;width:2px;background:#e9ebf0}
.flds{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px}.fld span{display:block;font-size:12px;color:#8a909c;margin-bottom:3px}.fld input,.fld select{width:100%;background:#1b1e25;border:1px solid #262a33;border-radius:8px;padding:7px 10px;color:#e9ebf0}.fld small{font-size:11px;color:#5d636e}
`;
  root.IngUI = { kartPopup, driverRows, engineer, rulesForm, readRules, quintile, badge, CSS, esc, fmtT, fmt };
})(typeof window !== 'undefined' ? window : globalThis);
