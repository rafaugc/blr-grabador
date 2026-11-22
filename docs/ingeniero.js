// ===== Ingeniero de pista: reglamento, cola de karts en box, clases por quintiles y recomendación de parada =====
// Necesita KartCore (core.js). Todo en segundos salvo el reglamento (minutos).
(function (root) {
  // Plantillas de reglamento
  const PRESETS = {
    ckh: { name: 'CKH Henakart 2026 · individual 50′', dur: 50, minDriver: 0, stintMin: 5, stintMax: 50, pitOpen: 5, pitClose: 0, stopsMin: 2, rows: 1, boxKarts: 4, pitLoss: 105, drivers: ['TÚ'],
      notes: 'Reglamento CKH 2026: carrera de 50′ (bandera al pasar el líder tras 50′), mínimo 5′ con cada kart antes de entrar, mínimo 2 paradas, cambio de kart por orden de llegada, cada pasada por pit lane mínimo 2′ (si no: tiempo adelantado + 1 vuelta). Sanciones por relevo corto: <2′ 1 vuelta · 2–5′ 2 vueltas · >5′ 5 vueltas. Parada no hecha: 6 vueltas. El último relevo se mide hasta el crono de 50′.' },
    equipos: { name: 'Resistencia por equipos · ejemplo 2 h', dur: 120, minDriver: 30, stintMin: 10, stintMax: 40, pitOpen: 10, pitClose: 10, stopsMin: 4, rows: 1, boxKarts: 4, pitLoss: 55, drivers: ['PILOTO 1', 'PILOTO 2', 'PILOTO 3'], notes: 'Valores de ejemplo.' }
  };
  const DEF = Object.assign({ preset: 'ckh' }, PRESETS.ckh);
  // Clases por quintiles de ritmo (de mejor a peor)
  const CLASSES = [
    { k: 'pepino', n: 'Pepino', c: '#3ddc84' },
    { k: 'bueno', n: 'Bueno', c: '#a6e36a' },
    { k: 'medio', n: 'Medio', c: '#c9cdd6' },
    { k: 'malo', n: 'Malo', c: '#ffa24c' },
    { k: 'cepo', n: 'Cepo', c: '#ff5f5f' }
  ];
  const UNKNOWN = { k: 'sorpresa', n: 'Sorpresa', c: '#5d636e' };

  // ---------- azar reproducible ----------
  function rng(seed) { let s = seed >>> 0; return () => { s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  const gauss = r => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);

  // ---------- mundo simulado (para el prototipo y para probar sin carrera real) ----------
  const TEAM_NAMES = ['BLR Racing', 'Escudería Fénix', 'Kart Attack', 'Los Rápidos', 'Team Turbo', 'Box Box', 'Apex Hunters',
    'Slipstream', 'La Cuadra', 'Neumático Frío', 'Gas a Fondo', 'Rookies KC', 'Vuelta Rápida', 'Drift Kings'];
  const FIRST = ['ALEX', 'DAVID', 'JAVI', 'MARCOS', 'PABLO', 'SERGIO', 'LUCÍA', 'IKER', 'DIEGO', 'RAFA', 'CARLOS', 'MARTA', 'HUGO', 'ÁLVARO',
    'NACHO', 'RUBÉN', 'LAURA', 'VÍCTOR', 'GONZALO', 'ADRIÁN', 'MARIO', 'EDU', 'ÓSCAR', 'SARA', 'TONI', 'DANI', 'JORGE', 'IVÁN',
    'BRUNO', 'PEDRO', 'ANDRÉS', 'MATÍAS', 'LIONEL', 'FRAN', 'GERMÁN', 'NICO', 'CHENG', 'ÁNGEL', 'BORJA', 'QUIQUE', 'TOMÁS', 'LUIS'];
  const LAST = ['GARCÍA', 'MORENO', 'LLAVE', 'RUIZ', 'SANZ', 'VELASCO', 'OBRERO', 'CUBAS', 'MÁRQUEZ', 'DE PAZ', 'SOBRINO', 'URBINA',
    'HU', 'LÓPEZ', 'DÍAZ', 'GIL', 'NAVARRO', 'ROMERO', 'TORRES', 'VEGA', 'CASTRO', 'PRIETO', 'MOLINA', 'ORTEGA'];

  function makeWorld(cfg, seed) {
    const r = rng(seed || 7);
    const N = TEAM_NAMES.length;
    const used = new Set();
    const pname = () => { let n; do { n = FIRST[Math.floor(r() * FIRST.length)] + ' ' + LAST[Math.floor(r() * LAST.length)]; } while (used.has(n)); used.add(n); return n; };
    const nD = Math.max(1, Math.min(4, cfg.drivers.length));
    const teams = TEAM_NAMES.map((tn, i) => {
      const drivers = (i === 0 ? cfg.drivers.slice(0, nD) : Array.from({ length: nD }, pname)).map((n, j) => ({ name: n, lvl: (i === 0 ? -0.25 : 0) + gauss(r) * 0.38 + (j === 2 ? 0.1 : 0) }));
      return { id: i, name: nD === 1 ? drivers[0].name : (i === 0 ? 'BLR Racing' : tn), dorsal: i + 1, drivers };
    });
    // karts físicos: los que salen con dorsal 1..N y los que esperan en el box (N+1..)
    const karts = [];
    const nk = N + cfg.boxKarts;
    for (let k = 1; k <= nk; k++) karts.push({ id: k, q: clamp(gauss(r) * 0.24, -0.5, 0.55) });
    // asegura algún pepino y algún cepo claros
    karts[N].q = -0.42; karts[N + 1].q = 0.48;
    const pool = Array.from({ length: 30 }, pname);
    return { seed: seed || 7, teams, karts, pool };
  }

  // Simula la carrera hasta tEnd (s). myPits: momentos (s) en que "mi equipo" decide entrar. myRows: fila elegida en cada parada propia.
  function simulate(W, cfg, tEnd, myPits, myRows) {
    myPits = myPits || []; myRows = myRows || [];
    const D = cfg.dur * 60, LAP = 45;
    const kq = {}; W.karts.forEach(k => kq[k.id] = k.q);
    const N = W.teams.length;
    const box = cfg.rows === 2 ? [[], []] : [[]];
    for (let k = N + 1; k <= N + cfg.boxKarts; k++) box[cfg.rows === 2 ? (k - N - 1) % 2 : 0].push(k);
    const events = [];
    const T = W.teams.map((tm, i) => {
      const r = rng(W.seed * 100 + i + 1);
      const stops = cfg.stopsMin + (r() < 0.25 ? 1 : 0);
      return { id: i, r, kart: tm.dorsal, drv: 0, stintStart: 0, stops: 0, plannedStops: stops, plan: 0, next: 0, laps: 0, lastLap: 0, done: false, drive: tm.drivers.map(() => 0) };
    });
    const planStint = t => {
      const left = D - t.stintStart, stintsLeft = Math.max(1, t.plannedStops - t.stops + 1);
      const base = left / stintsLeft / 60;
      return clamp(base + (t.r() - 0.5) * 8, cfg.stintMin + 1, cfg.stintMax - 1.2) * 60;
    };
    const lapT = (t, extra) => {
      const d = W.teams[t.id].drivers[t.drv];
      let x = LAP + d.lvl + kq[t.kart] + gauss(t.r) * 0.18;
      if (t.r() < 0.05) x += 1 + t.r() * 3.5; // tráfico, error, adelantamiento
      return Math.round((x + (extra || 0)) * 1000) / 1000;
    };
    T.forEach(t => { t.plan = planStint(t); t.curLap = lapT(t, 2 + t.id * 0.25); t.next = t.curLap; });
    let usedMy = 0;
    for (let guard = 0; guard < 20000; guard++) {
      let t = null; for (const x of T) if (!x.done && (!t || x.next < t.next)) t = x;
      if (!t || t.next > tEnd) break;
      const ts = t.next, lt = t.curLap;
      t.laps++; t.drive[t.drv] += lt; t.lastLap = ts;
      events.push({ type: 'lap', team: t.id, ts, t: lt, driver: W.teams[t.id].drivers[t.drv].name, kart: t.kart });
      if (ts >= D) { t.done = true; continue; }
      const stintT = ts - t.stintStart;
      const canPit = ts >= cfg.pitOpen * 60 && ts <= D - cfg.pitClose * 60 && stintT >= cfg.stintMin * 60;
      const mustPit = canPit && (stintT + LAP * 1.6 > cfg.stintMax * 60 || (t.stops < cfg.stopsMin && ts + LAP * 1.6 > D - cfg.pitClose * 60));
      let want = false;
      if (t.id === 0) {
        while (usedMy < myPits.length && myPits[usedMy] <= t.stintStart) usedMy++;
        if (usedMy < myPits.length && myPits[usedMy] <= ts) { want = canPit; usedMy++; }
      } else want = canPit && stintT >= t.plan;
      if (want || mustPit) {
        const row = box.length === 1 ? 0 : t.id === 0 && myRows[t.stops] != null ? myRows[t.stops] : (t.r() < 0.5 ? 0 : 1);
        const take = box[row].shift(); box[row].push(t.kart);
        events.push({ type: 'pit', team: t.id, ts, row, out: t.kart, in: take });
        t.kart = take; t.stops++;
        // cambio de piloto: el que menos ha conducido
        const nds = t.drive.map((_, j) => j).filter(j => j !== t.drv).sort((a, b) => t.drive[a] - t.drive[b]);
        if (nds.length) t.drv = nds[0]; t.stintStart = ts + cfg.pitLoss; t.plan = planStint(t);
        t.curLap = lapT(t, cfg.pitLoss + 1.5);
      } else t.curLap = lapT(t);
      t.next = ts + t.curLap;
    }
    return { events, box, now: tEnd };
  }

  // Sesiones cortas simuladas (para "Karts del día")
  function simulateSprints(W, n) {
    const r = rng(W.seed * 31 + 5), sessions = [];
    const kq = {}; W.karts.forEach(k => kq[k.id] = k.q);
    const lvl = {}; W.pool.forEach(p => lvl[p] = gauss(r) * 0.45);
    for (let s = 0; s < n; s++) {
      const drivers = W.pool.slice().sort(() => r() - 0.5).slice(0, 14);
      const ks = W.karts.map(k => k.id).sort(() => r() - 0.5).slice(0, 14);
      const hh = 10 + s * 2;
      sessions.push({ id: 'sim-' + s, date: '2026-11-22', time: `${hh}:00`, title: 'Carrera ' + (s + 1), type: 'Carrera', group: '', source: 'grabada',
        stints: drivers.map((d, i) => ({ kart: ks[i], driver: d, pos: i + 1,
          laps: Array.from({ length: 14 }, (_, j) => Math.round((45 + lvl[d] + kq[ks[i]] + gauss(r) * 0.18 + (j === 0 ? 1.8 : 0) + (r() < 0.06 ? 1 + r() * 3 : 0)) * 1000) / 1000) })) });
    }
    return sessions;
  }

  // ---------- seguimiento (lo que la app sabe de verdad: vueltas y paradas, NO la calidad real) ----------
  // teams: [{id,name,dorsal}] · events ordenados: {type:'lap',team,ts,t,driver} | {type:'pit',team,ts,row?}
  // knownRow(ev): fila conocida de esa parada (tu propia parada la sabes) o null.
  function track(cfg, teams, events, now, opts) {
    opts = opts || {};
    const two = cfg.rows === 2;
    const karts = {};       // id -> {id,label,box,pseudo}
    const N = teams.length;
    teams.forEach(t => karts[t.dorsal] = { id: t.dorsal, label: 'Salió con dorsal ' + t.dorsal });
    let pseudo = 5000;
    const box = two ? [[], []] : [[]];
    for (let i = 0; i < cfg.boxKarts; i++) {
      const id = 1000 + i + 1;
      karts[id] = { id, label: 'Box ' + (i + 1), surprise: true };
      box[two ? i % 2 : 0].push({ [id]: 1 });
    }
    const st = {};
    teams.forEach(t => st[t.id] = { id: t.id, name: t.name, dorsal: t.dorsal, cur: t.dorsal, curDist: { [t.dorsal]: 1 }, stints: [{ kart: t.dorsal, start: 0, laps: [], drivers: {} }], stops: 0, pitTimes: [], lastPit: null });
    const add = (a, b, w) => { for (const k in b) a[k] = (a[k] || 0) + b[k] * w; return a; };
    for (const ev of events) {
      if (ev.ts > now) break;
      const T = st[ev.team]; if (!T) continue;
      if (ev.type === 'lap') {
        const s = T.stints[T.stints.length - 1];
        s.laps.push({ t: ev.t, ts: ev.ts, driver: ev.driver });
        s.driver = ev.driver;
      } else if (ev.type === 'pit') {
        const s = T.stints[T.stints.length - 1]; s.end = ev.ts;
        const row = !two ? 0 : (opts.knownRow ? opts.knownRow(ev) : null);
        const old = { [T.cur]: 1 };
        let newId, dist;
        if (row != null) {
          dist = box[row].shift(); box[row].push(old);
        } else {
          // no sabemos en qué fila entró: mezcla 50/50 de los dos escenarios
          const A = box[0], B = box[1];
          dist = add(add({}, A[0], 0.5), B[0], 0.5);
          const A1 = A.slice(1).concat([old]), B1 = B.slice(1).concat([old]);
          box[0] = A.map((_, i) => add(add({}, A1[i], 0.5), A[i], 0.5));
          box[1] = B.map((_, i) => add(add({}, B1[i], 0.5), B[i], 0.5));
        }
        const ids = Object.keys(dist).filter(k => dist[k] > 0.001);
        if (ids.length === 1) newId = +ids[0];
        else { newId = ++pseudo; karts[newId] = { id: newId, label: `Cogido por ${T.name} (parada ${T.stops + 1})`, pseudo: true, prior: dist }; }
        T.cur = newId; T.curDist = dist; T.stops++; T.pitTimes.push(ev.ts); T.lastPit = ev.ts;
        T.stints.push({ kart: newId, start: ev.ts + cfg.pitLoss, laps: [], drivers: {} });
      }
    }
    // ritmo de cada kart: modelo "equipo + kart" con el núcleo de KartRank (el equipo hace de piloto)
    const stints = [];
    Object.values(st).forEach(T => T.stints.forEach(s => {
      if (s.laps.length) stints.push({ kart: s.kart, driver: T.name, laps: s.laps.map(l => l.t), pos: 0 });
    }));
    const A = stints.length ? root.KartCore.analyze([{ id: 'carrera', date: '0000-00-00', time: '', group: '', type: 'Carrera', stints: stints.map(x => Object.assign({}, x)) }],
      { method: 'model', minLaps: 4, dropFirst: true, cutPct: 3, tauKart: 0.25, tauDriver: 0.5 }) : { karts: [] };
    const est = {}; A.karts.forEach(k => est[k.kart] = k);
    // karts "mezcla" (2 filas): su estimación previa es la media de los posibles
    const value = id => est[id] ? est[id].effect : null;
    Object.values(karts).forEach(k => {
      k.est = value(k.id); k.n = est[k.id] ? est[k.id].n : 0;
      if (k.est == null && k.prior) { let s = 0, w = 0; for (const j in k.prior) { const v = value(j); if (v != null) { s += v * k.prior[j]; w += k.prior[j]; } } if (w > 0.5) { k.est = s / w; k.guess = true; } }
    });
    // clases por quintiles entre los karts con ritmo medido
    const measured = Object.values(karts).filter(k => est[k.id]).sort((a, b) => a.est - b.est);
    const cut = measured.map(k => k.est);
    const classOf = v => {
      if (v == null || !cut.length) return UNKNOWN;
      let i = 0; while (i < cut.length && cut[i] < v - 1e-9) i++;
      const p = cut.length > 1 ? i / (cut.length - 1) : 0.5;
      return CLASSES[Math.min(4, Math.floor(p * 5))];
    };
    Object.values(karts).forEach(k => k.cls = classOf(k.est));
    // dónde está cada kart ahora
    Object.values(st).forEach(T => { const k = karts[T.cur]; if (k) k.team = T.name; });
    const slotInfo = d => {
      const ids = Object.keys(d).filter(k => d[k] > 0.01);
      const probs = {}; let ev = 0, w = 0;
      ids.forEach(id => { const c = karts[id] ? karts[id].cls : UNKNOWN; probs[c.k] = (probs[c.k] || 0) + d[id]; if (karts[id] && karts[id].est != null) { ev += karts[id].est * d[id]; w += d[id]; } });
      const sure = ids.length === 1 ? karts[ids[0]] : null;
      return { ids, probs, sure, est: w > 0.5 ? ev / w : null, cls: sure ? sure.cls : classOf(w > 0.5 ? ev / w : null) };
    };
    const boxView = box.map((row, ri) => row.map((d, i) => Object.assign({ row: ri, pos: i }, slotInfo(d))));
    boxView.forEach(row => row.forEach(s => { if (s.sure) s.sure.inBox = s.row + 1 + '·' + (s.pos + 1); }));
    box.forEach(row => row.forEach(d => { for (const id in d) if (karts[id]) karts[id].boxP = (karts[id].boxP || 0) + d[id]; }));
    return { teams: st, karts, box: boxView, classOf, model: A, now };
  }

  // ---------- recomendación para mi equipo ----------
  function advise(cfg, TR, myId, now) {
    const D = cfg.dur * 60, T = TR.teams[myId];
    const out = { now, left: Math.max(0, D - now) };
    if (!T) return out;
    const s = T.stints[T.stints.length - 1];
    const stintStart = s.start;
    out.stintT = Math.max(0, now - stintStart);
    out.stops = T.stops;
    out.stopsLeft = Math.max(0, cfg.stopsMin - T.stops);
    out.pitOpenAt = cfg.pitOpen * 60;
    // cierre efectivo: el pit, y que el último relevo también cumpla el mínimo
    out.pitCloseAt = Math.min(D - cfg.pitClose * 60, D - cfg.stintMin * 60 - cfg.pitLoss);
    out.windowNow = now >= out.pitOpenAt && now <= out.pitCloseAt;
    out.minAt = stintStart + cfg.stintMin * 60;
    // último momento posible: relevo máximo, cierre del pit y que quepan las paradas que faltan
    const afterThis = Math.max(0, out.stopsLeft - 1);
    const fitStops = out.pitCloseAt - afterThis * cfg.stintMin * 60 - afterThis * cfg.pitLoss;
    out.maxAt = Math.min(stintStart + cfg.stintMax * 60, out.stopsLeft > 0 ? fitStops : out.pitCloseAt);
    if (out.stopsLeft === 0 && stintStart + cfg.stintMax * 60 >= D) out.maxAt = Infinity; // ya puede terminar sin parar
    out.earliest = Math.max(out.minAt, out.pitOpenAt);
    out.canPit = now >= out.earliest && now <= out.pitCloseAt;
    out.toMax = out.maxAt - now;
    // tiempo por piloto
    const drive = {};
    cfg.drivers.forEach(d => drive[d] = 0);
    T.stints.forEach(st => st.laps.forEach(l => { drive[l.driver] = (drive[l.driver] || 0) + l.t; }));
    out.drive = Object.entries(drive).map(([name, t]) => ({ name, t, need: Math.max(0, cfg.minDriver * 60 - t) }));
    out.driverNow = s.driver || (s.laps[0] && s.laps[0].driver) || '';
    const deficit = out.drive.reduce((a, d) => a + d.need, 0);
    out.driverWarn = deficit > out.left - 60 ? 'Ojo: no da tiempo a que todos cumplan el mínimo' : '';
    // kart actual y el que te tocaría
    const cur = TR.karts[T.cur];
    out.cur = cur;
    const fronts = TR.box.map(r => r[0]).filter(Boolean);
    out.fronts = fronts;
    const nextProbs = {}; let ev = 0, w = 0;
    fronts.forEach(f => { for (const c in f.probs) nextProbs[c] = (nextProbs[c] || 0) + f.probs[c] / fronts.length; if (f.est != null) { ev += f.est; w++; } });
    out.nextProbs = nextProbs;
    out.nextEst = w ? ev / w : null;
    out.nextCls = fronts.length === 1 ? fronts[0].cls : TR.classOf(out.nextEst);
    const curEst = cur && cur.est != null ? cur.est : 0;
    out.gainPerLap = out.nextEst != null ? curEst - out.nextEst : null;
    const nextStint = Math.min(cfg.stintMax * 60, Math.max(0, D - now - cfg.pitLoss));
    out.gainTotal = out.gainPerLap != null ? out.gainPerLap * nextStint / 45 : null;
    // rivales que van a parar pronto (se pueden llevar el kart bueno antes que tú)
    out.soon = Object.values(TR.teams).filter(x => x.id !== myId).map(x => {
      const xs = x.stints[x.stints.length - 1];
      const t = Math.max(0, now - xs.start);
      const left = Math.max(0, cfg.stopsMin - x.stops);
      const fit = left > 0 ? out.pitCloseAt - (left - 1) * (cfg.stintMin * 60 + cfg.pitLoss) : Infinity;
      const dl = Math.min(xs.start + cfg.stintMax * 60 < D ? xs.start + cfg.stintMax * 60 : Infinity, fit);
      return { name: x.name, stintT: t, toMax: dl - now, left, cls: (TR.karts[x.cur] || {}).cls || UNKNOWN };
    }).filter(x => x.stintT >= cfg.stintMin * 60 && now >= out.pitOpenAt && isFinite(x.toMax)).sort((a, b) => a.toMax - b.toMax).slice(0, 5);
    // decisión
    const pc = p => Math.round(100 * (p || 0));
    const good = (nextProbs.pepino || 0) + (nextProbs.bueno || 0);
    const bad = (nextProbs.cepo || 0) + (nextProbs.malo || 0);
    const curRank = cur ? CLASSES.indexOf(cur.cls) : -1;
    const lap = 47;
    if (now >= D) { out.level = 'end'; out.title = 'Carrera terminada'; out.text = ''; return out; }
    if (out.stopsLeft === 0 && out.maxAt === Infinity && !out.canPit) { out.level = 'ok'; out.title = 'Hasta el final'; out.text = 'Paradas cumplidas: puedes terminar sin volver a entrar.'; return out; }
    if (out.canPit && out.toMax <= lap * 1.2) { out.level = 'must'; out.title = 'ENTRA ESTA VUELTA'; out.text = 'Se acaba el tiempo máximo de relevo o la ventana para cumplir las paradas.'; return out; }
    if (!out.windowNow && now < out.pitOpenAt) { out.level = 'wait'; out.title = 'Pit cerrado'; out.text = `Abre en ${clockFmt(out.pitOpenAt - now)}.`; return out; }
    if (now < out.minAt) { out.level = 'wait'; out.title = 'Aún no puedes parar'; out.text = `Relevo mínimo cumplido en ${clockFmt(out.minAt - now)}.`; return out; }
    if (now > out.pitCloseAt) { if (out.stopsLeft > 0) { out.level = 'must'; out.title = `Faltan ${out.stopsLeft} parada${out.stopsLeft > 1 ? 's' : ''}`; out.text = 'Ya no da tiempo a cumplirlas con el relevo mínimo: cada parada no hecha penaliza (en CKH, 6 vueltas).'; } else { out.level = 'ok'; out.title = 'Pit cerrado'; out.text = 'Paradas cumplidas: hasta el final.'; } return out; }
    if (out.canPit && good >= 0.5 && (out.gainPerLap == null || out.gainPerLap > 0.08)) {
      out.level = 'go'; out.title = fronts.length === 1 ? `PARA YA: te espera un ${out.nextCls.n.toUpperCase()}` : `BUEN MOMENTO: ${pc(good)}% de coger kart bueno`;
      out.text = out.gainTotal != null ? `Ganarías unos ${Math.max(0, out.gainTotal).toFixed(1).replace('.', ',')} s en el próximo relevo frente a tu kart actual.` : 'Kart bueno en cabeza del box.';
      if (out.soon.length && out.soon[0].toMax < 120) out.text += ` ${out.soon[0].name} tiene que entrar en ${clockFmt(out.soon[0].toMax)}: si entra antes, se lo lleva.`;
      return out;
    }
    if (out.canPit && bad >= 0.5) { out.level = 'hold'; out.title = `NO PARES: en cabeza hay un ${fronts.length === 1 ? out.nextCls.n.toUpperCase() : 'kart malo (' + pc(bad) + '%)'}`; out.text = `Espera a que lo coja otro. Puedes aguantar ${clockFmt(out.toMax)} más.${out.soon.length ? ' Próximos en entrar: ' + out.soon.slice(0, 2).map(x => x.name).join(', ') + '.' : ''}`; return out; }
    if (out.canPit && curRank >= 3 && (out.nextEst == null || out.gainPerLap > 0)) { out.level = 'go'; out.title = 'Para cuando quieras'; out.text = out.nextEst == null ? `Tu kart es ${cur.cls.n.toLowerCase()} y en cabeza del box hay un kart sorpresa (aún sin datos): poco que perder.` : `Tu kart es ${cur.cls.n.toLowerCase()}; lo de cabeza del box es igual o mejor.`; return out; }
    out.level = 'ok'; out.title = 'Sigue en pista'; out.text = `Ventana abierta. Último momento para entrar: ${isFinite(out.maxAt) ? 'dentro de ' + clockFmt(out.toMax) : 'sin límite'}.`;
    return out;
  }
  function clockFmt(s) { if (!isFinite(s)) return '–'; s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); }

  // ritmo: media de las últimas n vueltas válidas, mejor media de n vueltas seguidas
  function validOf(laps) {
    const c = laps.slice(1);
    if (!c.length) return [];
    const m = mean(c);
    return c.filter(t => t <= m * 1.03);
  }
  const lastN = (laps, n) => { const v = validOf(laps).slice(-n); return v.length >= Math.min(n, 2) ? mean(v) : null; };
  function bestN(laps, n) {
    const c = laps.slice(1); let best = null;
    for (let i = 0; i + n <= c.length; i++) { const m = mean(c.slice(i, i + n)); if (best == null || m < best) best = m; }
    return best;
  }

  root.Ingeniero = { DEF, PRESETS, CLASSES, UNKNOWN, makeWorld, simulate, simulateSprints, track, advise, clockFmt, lastN, bestN, validOf };
})(typeof window !== 'undefined' ? window : globalThis);
