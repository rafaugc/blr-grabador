// ===== Núcleo: lectura de PDFs de Apex Timing + análisis estadístico =====
(function (root) {
  const TIME = '(?:\\d{1,2}:)?\\d{2}\\.\\d{3}';
  const TIME_G = new RegExp(TIME, 'g');
  const TIME_START = new RegExp('^' + TIME);
  const SESSION_RE = /^(CRONOS|CARRERA \d+|ENTRENAMIENTO\S*|QUALY\S*|CLASIFICACION\S*)\b.*?(\d{2}\/\d{2}\/\d{4}) - (\d{2}:\d{2})/;

  function tsec(t) {
    if (t.includes(':')) { const [m, s] = t.split(':'); return +m * 60 + parseFloat(s); }
    return parseFloat(t);
  }
  function cleanName(n) {
    n = n.replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
    // quita la categoría del final: " P", " A", " A MASTER", " A JUNIOR", " A 105", " A M 105"...
    const m = n.match(/\s([AP])(\s+[A-Z0-9]{1,8}){0,2}$/);
    let cls = '';
    if (m && n.length - m.index <= 14) { cls = m[0].trim(); n = n.slice(0, m.index).trim(); }
    return { name: n, cls };
  }

  // Reconstruye líneas de texto a partir de los elementos de pdf.js
  function linesFromItems(items) {
    const rows = [];
    for (const it of items) {
      if (!it.str || !it.str.trim()) continue;
      const y = it.transform[5], x = it.transform[4];
      let row = rows.find(r => Math.abs(r.y - y) < 2.2);
      if (!row) { row = { y, items: [] }; rows.push(row); }
      row.items.push({ x, w: it.width, s: it.str });
    }
    rows.sort((a, b) => b.y - a.y);
    return rows.map(r => {
      r.items.sort((a, b) => a.x - b.x);
      let out = '', end = null;
      for (const it of r.items) {
        if (end !== null) { const gap = it.x - end; out += gap > 4 ? '   ' : gap > 0.8 ? ' ' : ''; }
        out += it.s; end = it.x + it.w;
      }
      return out;
    });
  }

  // Convierte las líneas de un "Resumen" en vueltas
  function parseResumen(lines, fileLabel) {
    lines = lines.map(l => l.trim()).filter(Boolean);
    const group = (lines[0] || '').split(/\s+/)[0];
    let circuit = '';
    const sessions = []; let cur = null, mode = null, histKart = null;
    for (const s of lines) {
      if (/SANTOS/.test(s) && !circuit) circuit = 'Karting Los Santos';
      const m = s.match(SESSION_RE);
      if (m && (!cur || cur.name !== m[1] || cur.time !== m[3])) {
        cur = { group, name: m[1], date: m[2], time: m[3], results: {}, tokens: {} };
        sessions.push(cur); mode = null; continue;
      }
      if (s.startsWith('Clasif.')) { mode = 'class'; continue; }
      if (s.startsWith('Histórico de records')) { mode = 'hist'; histKart = null; continue; }
      if (s.startsWith('Lapchart')) { mode = null; continue; }
      if (/Apex Timing|KARTING|SANTOS|Resumen|Kart Piloto|CLASIFICACI/.test(s) || s === group) continue;
      if (!cur) continue;
      if (mode === 'class') {
        const mm = s.match(/^(\d+)\s+(\d+)\s+(.+?)\s{2,}(.*)$/);
        if (!mm) continue;
        const [, pos, kart, name, rest] = mm;
        const times = rest.match(TIME_G) || [];
        let laps, best;
        if (cur.name === 'CRONOS') {
          const lm = (' ' + rest).match(new RegExp('\\s(\\d{1,3})\\s+' + TIME + '$'));
          laps = lm ? +lm[1] : null; best = times[0];
        } else { laps = +rest.split(/\s+/)[0]; best = times[times.length - 2]; }
        const cn = cleanName(name);
        cur.results[kart] = { pos: +pos, kart, name: cn.name, cls: cn.cls, laps, best: best ? tsec(best) : null };
      } else if (mode === 'hist') {
        const mm = s.match(/^(\d{1,2})\s+([A-ZÁÉÍÓÚÑÜ].*)$/);
        if (mm && cur.results[mm[1]] && !TIME_START.test(s)) {
          histKart = mm[1]; cur.tokens[histKart] = mm[2].match(TIME_G) || [];
        } else if (histKart) cur.tokens[histKart].push(...(s.match(TIME_G) || []));
      }
    }
    const out = []; const warnings = [];
    for (const ses of sessions) {
      const [d, mo, y] = ses.date.split('/');
      const iso = `${y}-${mo}-${d}`;
      const stype = ses.name === 'CRONOS' ? 'Cronos' : ses.name.replace('CARRERA', 'Carrera');
      const id = `${iso}_${ses.time.replace(':', '')}_${ses.group}_${stype}`.replace(/[^\w+-]/g, '');
      const sess = { id, circuit: circuit || 'Circuito', date: iso, time: ses.time, group: ses.group,
        type: stype, source: fileLabel || '', stints: [] };
      for (const kart in ses.results) {
        const r = ses.results[kart];
        const toks = (ses.tokens[kart] || []).map(tsec);
        const n = (r.laps || 0) - 1;
        if (toks.length !== n + 1) warnings.push(`${stype} ${ses.group} kart ${kart}: ${toks.length} tiempos (esperados ${n + 1})`);
        const idx = n > 9 ? 9 : toks.length - 1;
        if (toks.length) toks.splice(idx, 1); // quita la "Media"
        if (toks.length && r.best && Math.abs(Math.min(...toks) - r.best) > 0.002)
          warnings.push(`${stype} ${ses.group} kart ${kart}: mejor vuelta no cuadra`);
        sess.stints.push({ kart: +kart, driver: r.name, cls: r.cls, pos: r.pos, laps: toks.map(t => Math.round(t * 1000) / 1000) });
      }
      if (sess.stints.length) out.push(sess);
    }
    return { sessions: out, warnings };
  }

  // ---------- utilidades estadísticas ----------
  const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
  const median = a => { if (!a.length) return NaN; const b = [...a].sort((x, y) => x - y), m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };

  // Une nombres que son el mismo piloto (p.ej. nombre cortado en el PDF)
  function nameMap(names) {
    const uniq = [...new Set(names)].sort((a, b) => b.length - a.length);
    const map = {};
    for (const n of uniq) {
      const longer = uniq.find(o => o !== n && o.length > n.length && n.length >= 12 && o.startsWith(n));
      map[n] = longer ? (map[longer] || longer) : n;
    }
    return map;
  }

  /* opts: {dropFirst:bool, cutPct:number(ej 3), pace:'top5'|'median'|'best', method:'raw'|'driver'|'model', minLaps}
     Devuelve {karts, drivers, stints, sessions} */
  function analyze(sessions, opts) {
    opts = Object.assign({ dropFirst: true, cutPct: 3, pace: 'top5', method: 'model', minLaps: 4, noTraffic: false, trafficGap: 0.5 }, opts || {});
    const clean = d => String(d || '').replace(/^\d{1,3}\s*-\s*/, '').replace(/\s*\[\d{1,2}:\d{2}(?::\d{2})?\]\s*$/, '').trim().toUpperCase().replace(/[ÁÀÂÄ]/g, 'A').replace(/[ÉÈÊË]/g, 'E').replace(/[ÍÌÎÏ]/g, 'I').replace(/[ÓÒÔÖ]/g, 'O').replace(/[ÚÙÛÜ]/g, 'U').replace(/\s+/g, ' ');
    sessions.forEach(s => s.stints.forEach(t => { t.driver = clean(t.driver); }));
    const nm = nameMap(sessions.flatMap(s => s.stints.map(t => t.driver)));
    const stints = [];
    for (const s of sessions) {
      for (const t of s.stints) {
        const start = opts.dropFirst ? 1 : 0;
        let laps = t.laps.slice(start);
        if (opts.noTraffic && t.gaps) laps = laps.filter((x, i) => { const g = t.gaps[i + start]; return g == null || g >= opts.trafficGap; });
        if (!laps.length) continue;
        const best = Math.min(...t.laps);
        const clean = laps.filter(x => x <= best * (1 + opts.cutPct / 100));
        if (clean.length < opts.minLaps) continue;
        const sorted = [...clean].sort((a, b) => a - b);
        const pace = opts.pace === 'best' ? sorted[0] : opts.pace === 'median' ? median(sorted) : mean(sorted.slice(0, 5));
        stints.push({ session: s.id, sessionLabel: `${s.date.slice(8, 10)}/${s.date.slice(5, 7)} ${s.time} ${s.group} ${s.type}`,
          date: s.date, kart: t.kart, driver: nm[t.driver], pace, best, top5: mean(sorted.slice(0, 5)),
          clean: clean.length, total: t.laps.length + 1, pos: t.pos });
      }
    }
    // referencia por sesión = mediana de ritmos de esa sesión
    const bySes = {};
    stints.forEach(t => (bySes[t.session] = bySes[t.session] || []).push(t.pace));
    const ref = {}; for (const k in bySes) ref[k] = median(bySes[k]);
    stints.forEach(t => { t.delta = t.pace - ref[t.session]; });

    const K = {}, D = {};
    stints.forEach(t => { (K[t.kart] = K[t.kart] || []).push(t); (D[t.driver] = D[t.driver] || []).push(t); });
    let kEff = {}, dEff = {}, sEff = {}, sigma = 0.3, lamK = 1.5, lamD = 1;
    for (const k in K) kEff[k] = 0; for (const d in D) dEff[d] = 0; for (const s in bySes) sEff[s] = 0;

    if (opts.method === 'raw') {
      for (const k in K) kEff[k] = mean(K[k].map(t => t.delta));
      for (const d in D) dEff[d] = mean(D[d].map(t => t.delta));
    } else if (opts.method === 'driver') {
      // cuánto mejor/peor fue cada piloto con este kart frente a su media en el resto de karts
      const dm = {}; for (const d in D) dm[d] = mean(D[d].map(t => t.delta));
      for (const k in K) {
        const v = K[k].filter(t => D[t.driver].length > 1).map(t => {
          const others = D[t.driver].filter(o => o !== t);
          return t.delta - mean(others.map(o => o.delta));
        });
        kEff[k] = v.length ? mean(v) : NaN; K[k].relN = v.length;
      }
      for (const d in D) dEff[d] = dm[d];
    } else {
      // modelo completo: ritmo = sesión + piloto + kart + ruido (mínimos cuadrados con "freno" a valores extremos)
      // Efectos aleatorios (piloto y kart) con "freno" según cuánto varía cada cosa de verdad:
      // los pilotos se diferencian mucho (~0,7 s), los karts poco (~0,15 s). Si un piloto solo tiene una tanda,
      // su diferencia se reparte entre piloto y kart en esa proporción; un kart que va rápido con varios pilotos distintos destaca.
      const TAU_D = opts.tauDriver || 0.7, TAU_K = opts.tauKart || 0.15;
      sigma = 0.25;
      for (let pass = 0; pass < 3; pass++) {
        const lamD = (sigma / TAU_D) ** 2;
        lamK = (sigma / TAU_K) ** 2;
        for (let it = 0; it < 150; it++) {
          for (const s in bySes) { const v = stints.filter(t => t.session === s).map(t => t.delta - dEff[t.driver] - kEff[t.kart]); sEff[s] = mean(v); }
          for (const d in D) { const v = D[d].map(t => t.delta - sEff[t.session] - kEff[t.kart]); dEff[d] = v.reduce((a, b) => a + b, 0) / (v.length + lamD); }
          for (const k in K) { const v = K[k].map(t => t.delta - sEff[t.session] - dEff[t.driver]); kEff[k] = v.reduce((a, b) => a + b, 0) / (v.length + lamK); }
          const mk = mean(Object.values(kEff)); for (const k in K) kEff[k] -= mk;
        }
        const res = stints.map(t => t.delta - sEff[t.session] - dEff[t.driver] - kEff[t.kart]);
        const repeated = Object.values(D).filter(v => v.length > 1).reduce((a, v) => a + v.length, 0);
        const dof = Math.max(3, repeated - Object.keys(D).length + Object.keys(K).length);
        sigma = Math.min(0.6, Math.max(0.12, Math.sqrt(res.reduce((a, r) => a + r * r, 0) / Math.max(dof, stints.length * 0.3))));
      }
    }
    if (opts.method !== 'model') {
      const all = stints.map(t => t.delta - kEff[t.kart]).filter(x => !isNaN(x));
      sigma = Math.sqrt(mean(all.map(x => x * x))) || 0.3;
    }

    const karts = Object.keys(K).map(k => {
      const v = K[k], n = opts.method === 'driver' ? (v.relN || 0) : v.length;
      const se = opts.method === 'model'
        ? Math.sqrt(1 / (n / (sigma * sigma + (opts.tauDriver || 0.7) ** 2 * (v.every(t => D[t.driver].length === 1) ? 1 : 0.3)) + 1 / ((opts.tauKart || 0.15) ** 2)))
        : 1.15 * sigma / Math.sqrt(Math.max(n, 0.5));
      const drivers = new Set(v.map(t => t.driver)).size;
      return { kart: +k, effect: kEff[k], se, n: v.length, drivers, best: Math.min(...v.map(t => t.best)),
        top5raw: mean(v.map(t => t.top5)), luckyDrivers: [...new Set(v.map(t => t.driver))], stints: v };
    }).filter(k => !isNaN(k.effect)).sort((a, b) => a.effect - b.effect);

    const drivers = Object.keys(D).map(d => {
      const v = D[d];
      const kartLuck = mean(v.map(t => kEff[t.kart] || 0));
      return { driver: d, skill: dEff[d], n: v.length, karts: [...new Set(v.map(t => t.kart))],
        best: Math.min(...v.map(t => t.best)), kartLuck, se: sigma / Math.sqrt(v.length), stints: v };
    }).sort((a, b) => a.skill - b.skill);
    return { karts, drivers, stints, sigma, opts };
  }

  root.KartCore = { linesFromItems, parseResumen, analyze, tsec, median, mean, normName: d => String(d || '').replace(/^\d{1,3}\s*-\s*/, '').replace(/\s*\[\d{1,2}:\d{2}(?::\d{2})?\]\s*$/, '').trim().toUpperCase().replace(/[ÁÀÂÄ]/g, 'A').replace(/[ÉÈÊË]/g, 'E').replace(/[ÍÌÎÏ]/g, 'I').replace(/[ÓÒÔÖ]/g, 'O').replace(/[ÚÙÛÜ]/g, 'U').replace(/\s+/g, ' ') };
})(typeof window !== 'undefined' ? window : globalThis);
