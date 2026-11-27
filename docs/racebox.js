/* RaceBox Mini / Mini S / Micro → delta continuo contra tu vuelta rápida.
   Tres piezas:
   1. Reader / decode: lee los paquetes que manda el RaceBox por Bluetooth (protocolo oficial "RaceBox BLE Protocol", mensaje 0xFF 0x01).
   2. Engine: con la posición GPS (25 veces por segundo) detecta cada vuelta y calcula cuánto ganas o pierdes, punto a punto,
      contra tu mejor vuelta. No necesita saber dónde está la meta: pone una "meta virtual" en un punto del circuito y cuenta desde ahí.
   3. connect: la conexión Bluetooth desde el navegador (solo en navegadores con Web Bluetooth: Bluefy en iPhone, Chrome en Android/PC). */
(function (root) {
  'use strict';
  const UART = '6e400001-b5a3-f393-e0a9-e50e24dcca9e', TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

  // ---------- 1. paquetes ----------
  // Los avisos Bluetooth pueden traer un paquete partido o varios juntos: se acumulan y se sacan enteros, comprobando la suma de control.
  function Reader(onMsg) {
    let buf = new Uint8Array(0);
    const st = { ok: 0, bad: 0 };
    const fn = chunk => {
      const n = new Uint8Array(buf.length + chunk.length); n.set(buf); n.set(chunk, buf.length); buf = n;
      let i = 0;
      while (buf.length - i >= 8) {
        if (buf[i] !== 0xB5 || buf[i + 1] !== 0x62) { i++; continue; }
        const len = buf[i + 4] | (buf[i + 5] << 8);
        if (len > 504) { i += 2; continue; }
        if (buf.length - i < 8 + len) break;
        let a = 0, b = 0;
        for (let k = i + 2; k < i + 6 + len; k++) { a = (a + buf[k]) & 255; b = (b + a) & 255; }
        if (a === buf[i + 6 + len] && b === buf[i + 7 + len]) { st.ok++; onMsg(buf[i + 2], buf[i + 3], buf.slice(i + 6, i + 6 + len)); i += 8 + len; }
        else { st.bad++; i += 2; }
      }
      buf = buf.slice(i);
      if (buf.length > 4096) buf = new Uint8Array(0);
    };
    fn.stats = st;
    return fn;
  }
  // Todos los canales del mensaje (80 bytes): posición, velocidad, altura, fuerzas G, giros, calidad del GPS y batería.
  function decode(p) {
    if (p.length < 80) return null;
    const d = new DataView(p.buffer, p.byteOffset, p.byteLength);
    const fix = d.getUint8(20), ff = d.getUint8(21), llf = d.getUint8(66), bat = d.getUint8(67), vf = d.getUint8(11);
    const ns = d.getInt32(16, true);
    return {
      t: d.getUint32(0, true) / 1000, // segundos (reloj GPS): más fiable que la hora a la que llega el aviso
      utc: (vf & 3) === 3 ? Date.UTC(d.getUint16(4, true), d.getUint8(6) - 1, d.getUint8(7), d.getUint8(8), d.getUint8(9), d.getUint8(10)) + ns / 1e6 : null,
      fix, sv: d.getUint8(23), valid: fix === 3 && !!(ff & 1) && !(llf & 1),
      lon: d.getInt32(24, true) / 1e7, lat: d.getInt32(28, true) / 1e7,
      altW: d.getInt32(32, true) / 1000, alt: d.getInt32(36, true) / 1000,
      hAcc: d.getUint32(40, true) / 1000, vAcc: d.getUint32(44, true) / 1000,
      v: d.getInt32(48, true) * 0.0036, hdg: d.getInt32(52, true) / 1e5,
      sAcc: d.getUint32(56, true) * 0.0036, hdgAcc: d.getUint32(60, true) / 1e5, pdop: d.getUint16(64, true) / 100,
      bat: bat & 127, charging: !!(bat & 128),
      gx: d.getInt16(68, true) / 1000, gy: d.getInt16(70, true) / 1000, gz: d.getInt16(72, true) / 1000, // G: X delante/atrás, Y derecha/izquierda, Z arriba/abajo
      rx: d.getInt16(74, true) / 100, ry: d.getInt16(76, true) / 100, rz: d.getInt16(78, true) / 100,   // giro en °/s: X balanceo, Y cabeceo, Z guiñada
    };
  }

  // ---------- 2. vueltas y delta ----------
  const DEF = { gateHalf: 15, minLap: 12, maxLap: 400, gateSpeed: 25, gateAfter: 15, lostAfter: 180, off: 12, win: 45 };
  function Engine(opts) {
    const o = Object.assign({}, DEF, opts || {});
    const E = { o, origin: null, track: null, fixed: false, splits: [], gate: null, laps: [], ref: null, lap: null, last: null, delta: null, deltaRaw: null, idx: 0, miss: 0, moving: 0, sinceGate: 0, lastCross: null, endDelta: null, endAt: 0, n: 0, onLap: null, onGate: null };
    const xy = (lat, lon) => ({ x: (lon - E.origin.lon) * E.origin.k * 111320, y: (lat - E.origin.lat) * 110540 });
    E.setGate = g => { // meta virtual guardada de otro día en este circuito
      if (!g || !isFinite(g.lat)) return;
      E.savedGate = g;
    };
    // Circuito con meta y parciales definidos (como en RaceChrono): track = { start: { lat, lon, hdg }, splits: [{ lat, lon, hdg, name }] }
    // Cada línea es un punto de la pista y el rumbo con el que se pasa por él.
    E.setTrack = t => { E.track = t && t.start && isFinite(t.start.lat) ? t : null; };
    const mkG = (g) => { const q = xy(g.lat, g.lon), r = g.hdg * Math.PI / 180; return { x: q.x, y: q.y, dx: Math.sin(r), dy: Math.cos(r), lat: g.lat, lon: g.lon, hdg: g.hdg }; };
    // ¿el tramo prev→p cruza la línea G en su sentido? devuelve el instante y el punto
    function gcross(G, prev, p, dt) {
      const s0 = (prev.x - G.x) * G.dx + (prev.y - G.y) * G.dy, s1 = (p.x - G.x) * G.dx + (p.y - G.y) * G.dy;
      if (!(s0 < 0 && s1 >= 0 && s1 - s0 < 30)) return null;
      const f = -s0 / (s1 - s0), cx = prev.x + f * (p.x - prev.x), cy = prev.y + f * (p.y - prev.y);
      return Math.abs((cx - G.x) * -G.dy + (cy - G.y) * G.dx) <= o.gateHalf ? { tc: prev.t + f * dt, cx, cy } : null;
    }
    function makeGate(p, hdg, lat, lon) {
      const r = hdg * Math.PI / 180;
      E.gate = { x: p.x, y: p.y, dx: Math.sin(r), dy: Math.cos(r), lat, lon, hdg };
      E.sinceGate = 0; E.lap = null; E.idx = 0;
    }
    function segDist(p, a, b) {
      const vx = b.x - a.x, vy = b.y - a.y, L = vx * vx + vy * vy;
      let f = L ? ((p.x - a.x) * vx + (p.y - a.y) * vy) / L : 0; f = Math.max(0, Math.min(1, f));
      const cx = a.x + f * vx, cy = a.y + f * vy;
      return { d: Math.hypot(p.x - cx, p.y - cy), f, vx, vy };
    }
    function search(p, mv, from, to) {
      const R = E.ref.pts; let best = null;
      for (let j = Math.max(0, from); j <= Math.min(R.length - 2, to); j++) {
        const s = segDist(p, R[j], R[j + 1]);
        if (mv && s.vx * mv.x + s.vy * mv.y <= 0) continue; // tramo en sentido contrario (horquillas pegadas)
        if (!best || s.d < best.d) best = { d: s.d, j, f: s.f };
      }
      return best;
    }
    E.push = s => {
      E.n++;
      if (!s || !s.valid) return;
      if (!E.origin) {
        E.origin = { lat: s.lat, lon: s.lon, k: Math.cos(s.lat * Math.PI / 180) };
        if (E.track) {
          const q = xy(E.track.start.lat, E.track.start.lon);
          if (Math.hypot(q.x, q.y) > 5000) E.track = null; // ese circuito está en otro sitio
          else { E.gate = mkG(E.track.start); E.fixed = true; E.splits = (E.track.splits || []).map(mkG); }
        }
        if (E.savedGate && !E.track) { const g = xy(E.savedGate.lat, E.savedGate.lon); if (Math.hypot(g.x, g.y) < 3000) makeGate(g, E.savedGate.hdg, E.savedGate.lat, E.savedGate.lon); }
      }
      const p = xy(s.lat, s.lon); p.t = s.t; p.v = s.v;
      const prev = E.last; E.last = p;
      if (!prev) return;
      let dt = p.t - prev.t; if (dt < -300000) dt += 604800; // cambio de semana GPS
      if (dt <= 0 || dt > 5) { if (E.lap) E.lap.bad = true; E.miss = 99; if (dt <= 0) return; }
      else if (dt > 1.2 && E.lap) E.lap.bad = true; // hueco de datos: esa vuelta no vale como referencia
      if (s.v > o.gateSpeed) { E.moving += dt; E.sinceGate += dt; }
      // meta virtual: se fija sola cuando ya llevas un rato rodando; si no vuelves a pasar por ella (p. ej. cayó en la salida de boxes), se pone otra
      if (E.gate && !E.fixed && E.sinceGate > o.lostAfter && (!E.lastCross || p.t - E.lastCross > o.lostAfter)) { E.gate = null; E.ref = null; E.lap = null; E.delta = null; E.moving = o.gateAfter; }
      if (!E.gate) { if (E.moving >= o.gateAfter && s.v > o.gateSpeed && s.hAcc < 6) { makeGate(p, s.hdg, s.lat, s.lon); E.lap = { t0: p.t, pts: [{ x: p.x, y: p.y, t: 0 }], bad: false, sp: [] }; E.lastCross = p.t; if (E.onGate) E.onGate(E.gate); } return; }
      const c = gcross(E.gate, prev, p, dt);
      if (c && (!E.lastCross || c.tc - E.lastCross >= o.minLap || !E.lap)) finish(c.tc, c.cx, c.cy);
      if (E.lap) E.splits.forEach((G, i) => { const k = gcross(G, prev, p, dt); if (!k) return; const t = k.tc - E.lap.t0; if (t > 1 && !E.lap.sp.some(x => x.i === i)) E.lap.sp.push({ i, t }); });
      follow(prev, p, s);
    };
    // paso por meta: cierra la vuelta (si había una en marcha) y abre la siguiente
    function finish(tc, cx, cy) {
      if (E.lap) {
        const T = tc - E.lap.t0;
        E.lap.pts.push({ x: cx, y: cy, t: T });
        if (T >= o.minLap && T <= o.maxLap) {
          const isBest = !E.lap.bad && (!E.ref || T < E.ref.T);
          const prevBest = E.ref ? E.ref.T : null;
          // parciales: los cruces de cada línea, en el orden en que se pasaron
          let sec = null;
          if (E.splits.length && E.lap.sp && E.lap.sp.length === E.splits.length) { const ts = E.lap.sp.map(x => x.t).sort((a, b) => a - b).concat([T]); sec = ts.map((t, i) => t - (i ? ts[i - 1] : 0)); }
          E.laps.push({ T, bad: !!E.lap.bad, at: Date.now(), t0: E.lap.t0, t1: tc, sec });
          E.endDelta = prevBest != null ? T - prevBest : null; E.endAt = Date.now();
          if (isBest) E.ref = { T, pts: E.lap.pts };
          if (E.onLap) E.onLap({ T, best: E.ref ? E.ref.T : null, isBest, delta: E.endDelta, sec });
        }
      }
      E.lap = { t0: tc, pts: [{ x: cx, y: cy, t: 0 }], bad: false, sp: [] };
      E.lastCross = tc; E.sinceGate = 0; E.idx = 0; E.miss = 0; E.delta = null; E.deltaRaw = null;
    }
    function follow(prev, p, s) {
      if (!E.lap) return;
      const ct = p.t - E.lap.t0;
      if (ct > o.maxLap) { E.lap.bad = true; }
      E.lap.pts.push({ x: p.x, y: p.y, t: ct });
      if (E.lap.pts.length > 12000) E.lap.pts.splice(1, 2000);
      // delta: ¿por dónde iba la vuelta de referencia en este mismo punto de la pista?
      if (!E.ref) { E.delta = null; return; }
      // sentido de la marcha: el rumbo que da el propio GPS (la diferencia entre dos puntos seguidos tiene demasiado ruido)
      const hr = s.hdg * Math.PI / 180, mv = s.v > 8 ? { x: Math.sin(hr), y: Math.cos(hr) } : null;
      // primero se busca justo delante de donde íbamos (lo normal); solo si no encaja se mira más lejos
      let m = E.miss < 25 ? search(p, mv, E.idx - 2, E.idx + 8) : null;
      if (E.miss < 25 && (!m || m.d > 3)) { const w = search(p, mv, E.idx - 3, E.idx + o.win); if (w && (!m || w.d < m.d - 1.5)) m = w; }
      if (!m || m.d > o.off) { const g = search(p, mv, 0, E.ref.pts.length); if (g && g.d <= o.off && (E.miss >= 25 || !m)) m = g; }
      if (!m || m.d > o.off) { E.miss++; if (E.miss > 12) { E.delta = null; E.deltaRaw = null; } return; } // fuera de la trazada (boxes, trompo…)
      E.miss = 0; E.idx = m.j;
      const R = E.ref.pts, rt = R[m.j].t + m.f * (R[m.j + 1].t - R[m.j].t);
      E.deltaRaw = ct - rt;
      E.delta = E.delta == null ? E.deltaRaw : E.delta + 0.35 * (E.deltaRaw - E.delta);
    }
    // lo que hay que enseñar ahora mismo
    E.view = () => {
      const fresh = E.endAt && Date.now() - E.endAt < 4000; // al cruzar meta se queda 4 s el resultado de la vuelta
      return { delta: fresh && E.endDelta != null ? E.endDelta : E.delta, atLine: !!fresh && E.endDelta != null, best: E.ref ? E.ref.T : null, laps: E.laps.length,
        last: E.laps.length ? E.laps[E.laps.length - 1].T : null, gate: !!E.gate, lapT: E.lap && E.last ? E.last.t - E.lap.t0 : null };
    };
    return E;
  }

  // ---------- 3. Bluetooth ----------
  const supported = () => typeof navigator !== 'undefined' && !!navigator.bluetooth && !!navigator.bluetooth.requestDevice;
  // cb.sample(s) con cada dato; cb.status(texto, estado) con cada cambio. Devuelve { stop() }.
  async function connect(cb, opt) {
    cb = cb || {}; opt = opt || {};
    const say = (t, st) => { try { cb.status && cb.status(t, st); } catch (e) {} };
    const req = opt.all ? { acceptAllDevices: true, optionalServices: [UART] } : { filters: [{ namePrefix: 'RaceBox' }], optionalServices: [UART] };
    const dev = await navigator.bluetooth.requestDevice(req);
    const H = { dev, want: true, reader: null, last: 0, stop() { H.want = false; try { dev.gatt.disconnect(); } catch (e) {} say('Desconectado', 'off'); } };
    const open = async () => {
      say('Conectando con ' + (dev.name || 'RaceBox') + '…', 'wait');
      const srv = await dev.gatt.connect();
      const svc = await srv.getPrimaryService(UART);
      const ch = await svc.getCharacteristic(TX);
      H.reader = Reader((cls, id, pl) => { if (cls === 0xFF && id === 0x01) { const s = decode(pl); if (s) { H.last = Date.now(); try { cb.sample && cb.sample(s, pl); } catch (e) {} } } });
      ch.addEventListener('characteristicvaluechanged', ev => { const v = ev.target.value; H.reader(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)); });
      await ch.startNotifications();
      say((dev.name || 'RaceBox') + ' conectado', 'on');
    };
    let retrying = false;
    const retry = async () => {
      if (retrying) return; retrying = true;
      while (H.want) {
        say('RaceBox desconectado. Reconectando…', 'wait');
        try { await open(); break; } catch (e) { await new Promise(r => setTimeout(r, 2500)); }
      }
      retrying = false;
    };
    dev.addEventListener('gattserverdisconnected', () => { if (H.want) retry(); });
    await open();
    return H;
  }

  // ---------- 4. grabación (en la memoria del navegador) ----------
  // Se guarda el mensaje tal cual llega del RaceBox (los 80 bytes, 25 veces por segundo): así no se pierde ningún canal.
  const DB = 'kr-racebox', LEN = 80;
  let dbp = null;
  const db = () => dbp || (dbp = new Promise((ok, ko) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('ses', { keyPath: 'id' }); d.createObjectStore('chunks', { keyPath: ['sid', 'i'] }); };
    r.onsuccess = () => ok(r.result); r.onerror = () => { dbp = null; ko(r.error); };
  }));
  const tx = async (stores, mode, fn) => { const d = await db(); return new Promise((ok, ko) => { const t = d.transaction(stores, mode); let out; t.oncomplete = () => ok(out); t.onerror = t.onabort = () => ko(t.error); out = fn(t); }); };
  const req = r => new Promise((ok, ko) => { r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error); });
  const Store = {
    async list() { const d = await db(); const a = await req(d.transaction('ses').objectStore('ses').getAll()); return a.sort((x, y) => y.start - x.start); },
    async meta(id) { const d = await db(); return req(d.transaction('ses').objectStore('ses').get(id)); },
    async data(id) { // todos los mensajes de la sesión, seguidos
      const d = await db(); const cs = await req(d.transaction('chunks').objectStore('chunks').getAll(IDBKeyRange.bound([id, 0], [id, Infinity])));
      const n = cs.reduce((a, c) => a + c.buf.byteLength, 0), out = new Uint8Array(n); let o = 0;
      cs.sort((a, b) => a.i - b.i).forEach(c => { out.set(new Uint8Array(c.buf), o); o += c.buf.byteLength; });
      return out;
    },
    del(id) { return tx(['ses', 'chunks'], 'readwrite', t => { t.objectStore('ses').delete(id); t.objectStore('chunks').delete(IDBKeyRange.bound([id, 0], [id, Infinity])); }); },
    patch(id, o) { return tx(['ses'], 'readwrite', t => { const st = t.objectStore('ses'); st.get(id).onsuccess = e => { if (e.target.result) st.put(Object.assign(e.target.result, o)); }; }); },
  };
  function Recorder(meta) {
    const id = 'rb-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-' + Math.random().toString(36).slice(2, 6);
    const R = { id, n: 0, saved: 0, err: null, info: Object.assign({}, meta) };
    let buf = new Uint8Array(LEN * 300), fill = 0, chunk = 0, start = null, lastFlush = Date.now(), busy = false;
    R.add = pl => {
      if (pl.length !== LEN) return;
      if (start == null) start = Date.now();
      if (fill + LEN > buf.length) { const b = new Uint8Array(buf.length * 2); b.set(buf); buf = b; }
      buf.set(pl, fill); fill += LEN; R.n++;
      if (fill >= LEN * 250 || Date.now() - lastFlush > 10000) R.flush();
    };
    R.flush = async () => {
      if (busy || start == null) return; busy = true; lastFlush = Date.now();
      const part = buf.slice(0, fill), i = chunk; fill = 0;
      try {
        await tx(['ses', 'chunks'], 'readwrite', t => {
          if (part.length) t.objectStore('chunks').put({ sid: id, i, buf: part.buffer });
          t.objectStore('ses').put(Object.assign({}, R.info, { id, start, end: Date.now(), n: R.n }));
        });
        if (part.length) chunk++; R.saved = R.n - fill / LEN; R.err = null;
      } catch (e) { R.err = String(e && e.message || e); const b = new Uint8Array(Math.max(buf.length, part.length + fill + LEN * 300)); b.set(part); b.set(buf.subarray(0, fill), part.length); buf = b; fill += part.length; }
      busy = false;
    };
    // cerrar la sesión: espera a que acabe el guardado en curso y guarda lo que quede
    R.close = async () => { for (let i = 0; i < 60 && busy; i++) await new Promise(r => setTimeout(r, 50)); await R.flush(); for (let i = 0; i < 60 && busy; i++) await new Promise(r => setTimeout(r, 50)); };
    if (typeof addEventListener !== 'undefined') { addEventListener('pagehide', () => R.flush()); document.addEventListener('visibilitychange', () => { if (document.hidden) R.flush(); }); }
    try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {}
    return R;
  }

  // ---------- 5. análisis y exportación ----------
  function parseAll(u8) { const out = []; for (let o = 0; o + LEN <= u8.length; o += LEN) { const s = decode(u8.subarray(o, o + LEN)); if (s) out.push(s); } return out; }
  // vueltas de una sesión grabada: se vuelve a pasar por el mismo motor que en directo
  function lapsOf(samples, gate, track) {
    const E = Engine(); if (gate) E.setGate(gate); if (track) E.setTrack(track);
    samples.forEach(s => E.push(s));
    return { byLine: !!E.fixed, laps: E.laps.map((l, i) => ({ n: i + 1, T: l.T, t0: l.t0, t1: l.t1, bad: l.bad, sec: l.sec })), best: E.ref ? E.ref.T : null, gate: E.gate ? { lat: E.gate.lat, lon: E.gate.lon, hdg: E.gate.hdg } : null };
  }
  const lapAt = (laps, t) => { for (const l of laps) if (t >= l.t0 && t < l.t1) return l.n; return 0; };
  const p2 = n => String(n).padStart(2, '0');
  // CSV con la misma forma que el «CSV v3» de RaceChrono (mismas cabeceras, columnas y unidades; la velocidad va en m/s).
  function toCSV(samples, laps, name) {
    laps = laps || []; name = (name || 'KR DASH').replace(/"/g, "'");
    const ok = samples.filter(s => s.valid);
    const f = (x, n) => x == null || !isFinite(x) ? '' : String(+x.toFixed(n));
    const d0 = new Date(ok.length && ok[0].utc != null ? ok[0].utc : Date.now());
    const out = ['This file is created using KR DASH (RaceBox), in RaceChrono CSV v3 layout.', 'Format,3', 'Session title,"' + name + '"', 'Session type,Lap timing', 'Track name,"' + name + '"', 'Driver name,',
      'Created,' + p2(d0.getUTCDate()) + '/' + p2(d0.getUTCMonth() + 1) + '/' + d0.getUTCFullYear() + ',' + p2(d0.getUTCHours()) + ':' + p2(d0.getUTCMinutes()), 'Note,', '',
      'timestamp,fragment_id,lap_number,elapsed_time,distance_traveled,accuracy,altitude,bearing,device_battery_level,device_update_rate,fix_type,latitude,longitude,satellites,speed,combined_acc,device_update_rate,lateral_acc,lean_angle,longitudinal_acc,speed,device_update_rate,x_acc,y_acc,z_acc,device_update_rate,x_rate_of_rotation,y_rate_of_rotation,z_rate_of_rotation',
      'unix time,,,s,m,m,m,deg,%,Hz,,deg,deg,sats,m/s,G,Hz,G,deg,G,m/s,Hz,G,G,G,Hz,deg/s,deg/s,deg/s',
      ',,,,,100: gps,100: gps,100: gps,100: gps,100: gps,100: gps,100: gps,100: gps,100: gps,100: gps,calc,calc,calc,calc,calc,calc,101: acc,101: acc,101: acc,101: acc,102: gyro,102: gyro,102: gyro,102: gyro'];
    let dist = 0, prev = null; const t0 = ok.length ? ok[0].t : 0;
    for (const s of ok) {
      let la = 0, lo = 0;
      if (prev) {
        const dt = s.t - prev.t, k = Math.cos(s.lat * Math.PI / 180);
        dist += Math.hypot((s.lon - prev.lon) * k * 111320, (s.lat - prev.lat) * 110540);
        if (dt > 0 && dt < 1) { // aceleraciones calculadas a partir del GPS, como hace RaceChrono en sus canales «calc»
          let dh = s.hdg - prev.hdg; dh -= 360 * Math.round(dh / 360);
          const v = s.v / 3.6; lo = (s.v - prev.v) / 3.6 / dt / 9.80665; la = s.v > 5 ? v * (dh * Math.PI / 180 / dt) / 9.80665 : 0;
        }
      }
      const n = lapAt(laps, s.t), v = s.v / 3.6;
      out.push([s.utc != null ? (s.utc / 1000).toFixed(3) : '', 0, n || '', f(s.t - t0, 2), f(dist, 3), f(s.hAcc, 3), f(s.alt, 3), f(s.hdg, 3), f(s.bat, 1), '25.0', f(s.fix, 1), f(s.lat, 7), f(s.lon, 7), f(s.sv, 1), f(v, 4),
        f(Math.hypot(la, lo), 5), '25.0', f(la, 5), f(Math.atan(la) * 180 / Math.PI, 5), f(lo, 5), f(v, 4), '25.0', f(s.gx, 5), f(s.gy, 5), f(s.gz, 5), '25.0', f(s.rx, 3), f(s.ry, 3), f(s.rz, 3)].join(','));
      prev = s;
    }
    return out.join('\n') + '\n';
  }
  // Leer un CSV v3 de RaceChrono (o el nuestro, que tiene la misma forma)
  function fromCSV(text) {
    const L = text.split(/\r?\n/), hi = L.findIndex(l => l.startsWith('timestamp,')); if (hi < 0) return null;
    const H = L[hi].split(','), ix = n => H.indexOf(n), nm = /^Session title,"?(.*?)"?$/.exec(L.find(l => l.startsWith('Session title')) || '');
    const I = { ts: ix('timestamp'), el: ix('elapsed_time'), acc: ix('accuracy'), alt: ix('altitude'), hdg: ix('bearing'), bat: ix('device_battery_level'), fix: ix('fix_type'), lat: ix('latitude'), lon: ix('longitude'), sv: ix('satellites'), v: ix('speed'), gx: ix('x_acc'), gy: ix('y_acc'), gz: ix('z_acc'), rx: ix('x_rate_of_rotation'), ry: ix('y_rate_of_rotation'), rz: ix('z_rate_of_rotation') };
    const samples = [], g = (c, i) => i < 0 || c[i] === '' || c[i] == null ? null : +c[i];
    for (let r = hi + 3; r < L.length; r++) { if (!L[r]) continue; const c = L[r].split(','), lat = g(c, I.lat), lon = g(c, I.lon); if (lat == null || lon == null) continue;
      const ts = g(c, I.ts), fx = g(c, I.fix);
      samples.push({ t: ts != null ? ts : g(c, I.el), utc: ts != null ? ts * 1000 : null, lat, lon, v: (g(c, I.v) || 0) * 3.6, hdg: g(c, I.hdg) || 0, alt: g(c, I.alt), altW: null, sv: g(c, I.sv), fix: fx == null ? 3 : fx, valid: fx == null || fx >= 2,
        hAcc: g(c, I.acc), vAcc: null, sAcc: null, hdgAcc: null, pdop: null, bat: g(c, I.bat), gx: g(c, I.gx), gy: g(c, I.gy), gz: g(c, I.gz), rx: g(c, I.rx), ry: g(c, I.ry), rz: g(c, I.rz) }); }
    return { samples, name: nm ? nm[1] : '' };
  }

  // Formato .vbo con la misma forma que el que exporta RaceChrono (cabecera, líneas del circuito y nombres de canal),
  // para que lo abran los mismos programas. Latitud y longitud van en minutos, y la longitud OESTE es positiva.
  function toVBO(samples, track, name) {
    const ok = samples.filter(s => s.valid && s.utc != null);
    const d0 = new Date(ok.length ? ok[0].utc : Date.now());
    const sg = (x, w, n) => (x < 0 ? '-' : '+') + Math.abs(x || 0).toFixed(n).padStart(w, '0');
    const head = ['File created on ' + p2(d0.getUTCDate()) + '/' + p2(d0.getUTCMonth() + 1) + '/' + d0.getUTCFullYear() + ' at ' + p2(d0.getUTCHours()) + ':' + p2(d0.getUTCMinutes()) + ':' + p2(d0.getUTCSeconds()), '',
      '[header]', 'satellites', 'time', 'latitude', 'longitude', 'velocity kmh', 'heading', 'height', 'long accel g', 'lat accel g', 'device_battery_level', 'fix_type', 'accuracy',
      'x_acc-acc g', 'y_acc-acc g', 'z_acc-acc g', 'x_rate_of_rotation-gyro', 'y_rate_of_rotation-gyro', 'z_rate_of_rotation-gyro', '',
      '[comments]', 'Generated by KR DASH (RaceBox)', '', '[session data]', 'name ' + (name || 'KR DASH'), ''];
    if (track && track.start) {
      // cada línea: el punto de paso y otro 50 m antes (de dónde vienes)
      const line = g => { const r = g.hdg * Math.PI / 180, k = Math.cos(g.lat * Math.PI / 180), lat2 = g.lat - 50 * Math.cos(r) / 110540, lon2 = g.lon - 50 * Math.sin(r) / (k * 111320);
        return sg(-g.lon * 60, 10, 6) + ' ' + sg(g.lat * 60, 11, 6) + ' ' + sg(-lon2 * 60, 10, 6) + ' ' + sg(lat2 * 60, 11, 6); };
      head.push('[laptiming]', 'Start   ' + line(track.start) + ' ¬ Start/Finish');
      (track.splits || []).forEach((g, i) => head.push('Split   ' + line(g) + ' ¬ ' + (g.name || 'Sector ' + (i + 1))));
      head.push('');
    }
    head.push('[column names]', 'sats time lat long velocity heading height longacc latacc device_battery_level fix_type accuracy x_acc-acc y_acc-acc z_acc-acc x_rate_of_rotation-gyro y_rate_of_rotation-gyro z_rate_of_rotation-gyro', '', '[data]');
    const rows = ok.map(s => { const d = new Date(Math.round(s.utc / 10) * 10);
      return [String(s.sv || 0).padStart(3, '0'), p2(d.getUTCHours()) + p2(d.getUTCMinutes()) + p2(d.getUTCSeconds()) + '.' + p2(Math.floor(d.getUTCMilliseconds() / 10)),
        sg(s.lat * 60, 11, 6), sg(-s.lon * 60, 12, 6), Math.max(0, s.v).toFixed(3).padStart(7, '0'), (((s.hdg % 360) + 360) % 360).toFixed(2).padStart(6, '0'), sg(s.alt, 8, 2),
        sg(s.gx, 7, 3), sg(s.gy, 7, 3), sg(s.bat, 7, 3), s.fix, (s.hAcc || 0).toFixed(3).padStart(11, '0'),
        sg(s.gx, 7, 3), sg(s.gy, 7, 3), sg(s.gz, 7, 3), sg(s.rx, 7, 3), sg(s.ry, 7, 3), sg(s.rz, 7, 3)].join(' '); });
    return head.concat(rows).join('\r\n') + '\r\n';
  }

  // Leer un .vbo (por ejemplo, exportado de RaceChrono): saca los datos y, si las trae, las líneas de meta y parciales del circuito.
  function fromVBO(text) {
    const L = text.split(/\r?\n/); let sec = '', cols = [], samples = [], track = null, name = '', day = null;
    const m0 = /created on (\d+)\/(\d+)\/(\d+)/i.exec(L[0] || ''); if (m0) day = Date.UTC(+m0[3], +m0[2] - 1, +m0[1]);
    // En el archivo cada línea son dos puntos (longitud y latitud en minutos, oeste positivo): el primero es el punto de paso
    // y el segundo marca de dónde vienes. Comprobado con una sesión real de DR7: reproduce los tiempos de RaceChrono a la centésima.
    const ln = a => { const lat = a[1] / 60, lon = -a[0] / 60, lat2 = a[3] / 60, lon2 = -a[2] / 60, k = Math.cos(lat * Math.PI / 180);
      return { lat, lon, hdg: (Math.atan2((lon - lon2) * k * 111320, (lat - lat2) * 110540) * 180 / Math.PI + 360) % 360 }; };
    let prevT = null;
    for (const raw of L) {
      const r = raw.trim(); if (!r) continue;
      if (r[0] === '[') { sec = r.toLowerCase(); continue; }
      if (sec === '[session data]' && /^name /i.test(r)) name = r.slice(5).trim();
      else if (sec === '[laptiming]') {
        const m = /^(start|split)\s+([+\-\d.]+)\s+([+\-\d.]+)\s+([+\-\d.]+)\s+([+\-\d.]+)(?:\s*¬\s*(.*))?/i.exec(r); if (!m) continue;
        track = track || { start: null, splits: [] };
        const a = ln([+m[2], +m[3], +m[4], +m[5]]);
        if (/start/i.test(m[1])) track.start = a; else { a.name = (m[6] || '').trim(); track.splits.push(a); }
      } else if (sec === '[column names]') cols = r.split(/\s+/);
      else if (sec === '[data]') {
        const c = r.split(/\s+/), g = n => { const i = cols.indexOf(n); return i < 0 ? null : +c[i]; };
        const tm = c[cols.indexOf('time')]; if (!tm) continue;
        let t = (+tm.slice(0, 2)) * 3600 + (+tm.slice(2, 4)) * 60 + (+tm.slice(4));
        if (prevT != null && t < prevT - 43200) { day += 86400000; } prevT = t;
        const fx = g('fix_type');
        samples.push({ t, utc: day != null ? day + t * 1000 : null, sv: g('sats'), lat: g('lat') / 60, lon: -g('long') / 60, v: g('velocity'), hdg: g('heading'), alt: g('height'), altW: null,
          fix: fx == null ? 3 : fx, valid: fx == null ? g('sats') > 3 : fx >= 2, hAcc: g('accuracy'), vAcc: null, sAcc: null, hdgAcc: null, pdop: null, bat: g('device_battery_level'),
          gx: g('x_acc-acc') ?? g('longacc'), gy: g('y_acc-acc') ?? g('latacc'), gz: g('z_acc-acc'), rx: g('x_rate_of_rotation-gyro'), ry: g('y_rate_of_rotation-gyro'), rz: g('z_rate_of_rotation-gyro') });
      }
    }
    if (track && !track.start) track = null;
    return { samples, track, name };
  }

  // ---------- 6. copia en GitHub ----------
  // Las sesiones se suben solas a una rama aparte ("telemetria") del proyecto, para verlas desde cualquier aparato.
  // Leer no necesita llave (el proyecto es público); subir sí: la llave se guarda en este navegador.
  const Cloud = (() => {
    const repo = () => { const h = location.hostname.match(/^([\w-]+)\.github\.io$/i), seg = location.pathname.split('/')[1]; return h && seg ? h[1] + '/' + seg : 'rafaugc/rafa_krtrnk'; };
    const BR = 'telemetria';
    const tok = () => { try { return JSON.parse(localStorage.getItem('blr_ghToken') || '""') || ''; } catch (e) { return ''; } };
    const hdr = () => Object.assign({ Accept: 'application/vnd.github+json' }, tok() ? { Authorization: 'Bearer ' + tok() } : {});
    const api = (path, opt) => fetch('https://api.github.com/repos/' + repo() + (path ? '/' + path : ''), Object.assign({ headers: Object.assign(hdr(), opt && opt.body ? { 'Content-Type': 'application/json' } : {}) }, opt || {}));
    const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
    const pipe = async (u8, T) => new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new T('gzip'))).arrayBuffer());
    const gzip = u8 => pipe(u8, CompressionStream), gunzip = u8 => pipe(u8, DecompressionStream);
    const utf8 = t => new TextEncoder().encode(t);
    async function put(path, u8, branch, msg) {
      let sha; const g = await api('contents/' + path + '?ref=' + branch); if (g.ok) sha = (await g.json()).sha;
      const r = await api('contents/' + path, { method: 'PUT', body: JSON.stringify({ message: msg, content: b64(u8), branch, sha }) });
      if (!r.ok) { const e = new Error(r.status === 401 ? 'la llave no vale o ha caducado' : r.status === 403 || r.status === 404 ? 'la llave no tiene permiso de «Contents» (lectura y escritura)' : 'GitHub respondió ' + r.status); e.status = r.status; throw e; }
    }
    let busy = false;
    // sube lo que falte; devuelve { subidas, pendientes, error }
    // Sin opciones: solo sube sesiones terminadas (45 s sin datos nuevos). { force: true } sube ya todo lo pendiente; con { id } solo esa sesión.
    async function syncUp(opt) {
      opt = opt || {};
      if (busy) return { subidas: 0, pendientes: 0, error: null, ocupado: true };
      if (!tok() || typeof CompressionStream === 'undefined') return { subidas: 0, pendientes: 0, error: !tok() ? 'sin llave' : 'este navegador no puede comprimir' };
      busy = true; let subidas = 0, error = null, pend = [];
      try {
        pend = (await Store.list()).filter(s => !s.up && (opt.force ? (s.n || 0) >= 25 && (!opt.id || s.id === opt.id) : (s.n || 0) >= 750 && Date.now() - (s.end || 0) > 45000)); // terminadas y con más de 30 s de datos
        for (const s of pend) {
          const raw = await Store.data(s.id); if (!raw.length) continue;
          await put('rb/' + s.id + '.krb.gz', await gzip(raw), BR, 'Telemetría ' + s.id);
          const meta = Object.assign({}, s); delete meta.up;
          await put('rb/' + s.id + '.json', utf8(JSON.stringify(meta)), BR, 'Telemetría ' + s.id + ' (ficha)');
          await Store.patch(s.id, { up: Date.now() }); subidas++;
        }
      } catch (e) { error = String(e && e.message || e); }
      busy = false;
      return { subidas, pendientes: pend.length - subidas, error };
    }
    // sesiones grabadas en este aparato que aún no están en GitHub
    async function pending() { try { return (await Store.list()).filter(s => !s.up && (s.n || 0) >= 25); } catch (e) { return []; } }
    async function listRemote() {
      const r = await api('git/trees/' + BR + '?recursive=1'); if (!r.ok) return [];
      const files = ((await r.json()).tree || []).filter(f => /^rb\/.+\.json$/.test(f.path));
      let cache = {}; try { cache = JSON.parse(localStorage.getItem('kr_rb_remote') || '{}'); } catch (e) {}
      const out = [], next = {};
      await Promise.all(files.map(async f => { let m = cache[f.sha];
        if (!m) { try { m = await (await fetch('https://raw.githubusercontent.com/' + repo() + '/' + BR + '/' + f.path)).json(); } catch (e) { return; } }
        next[f.sha] = m; out.push(Object.assign({ remote: true }, m)); }));
      try { localStorage.setItem('kr_rb_remote', JSON.stringify(next)); } catch (e) {}
      return out.sort((a, b) => b.start - a.start);
    }
    async function getRemote(id) { const r = await fetch('https://raw.githubusercontent.com/' + repo() + '/' + BR + '/rb/' + id + '.krb.gz'); if (!r.ok) throw new Error('no se pudo descargar'); return gunzip(new Uint8Array(await r.arrayBuffer())); }
    async function delRemote(id) { for (const ext of ['.krb.gz', '.json']) { const p = 'contents/rb/' + id + ext, g = await api(p + '?ref=' + BR); if (!g.ok) continue; await api(p, { method: 'DELETE', body: JSON.stringify({ message: 'Borrar ' + id, sha: (await g.json()).sha, branch: BR }) }); } }
    // circuitos (meta, parciales y trazado): un archivo común en el proyecto
    async function pistas() { try { return await (await fetch('https://raw.githubusercontent.com/' + repo() + '/main/data/pistas.json?t=' + Date.now(), { cache: 'no-store' })).json(); } catch (e) { return {}; } }
    async function savePista(slug, def) {
      const g = await api('contents/data/pistas.json?ref=main'); let all = {};
      if (g.ok) { const j = await g.json(); all = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(j.content.replace(/\s/g, '')), c => c.charCodeAt(0)))); }
      all[slug] = def;
      await put('data/pistas.json', utf8(JSON.stringify(all, null, 1)), 'main', 'Circuito ' + slug + ': meta y parciales');
    }
    // comprueba la llave de verdad: escribe un archivo diminuto de prueba en la rama de telemetría
    async function check() {
      if (!tok()) return 'sin llave';
      let r; try { r = await api(''); } catch (e) { return 'no se pudo contactar con GitHub (revisa la conexión a internet)'; }
      if (r.status === 401) return 'GitHub no reconoce la llave (¿copiada entera?)';
      if (!r.ok) return 'la llave no da acceso al proyecto rafa_krtrnk (paso 3)';
      try { await put('rb/.llave-ok', utf8('Llave comprobada el ' + new Date().toISOString() + '\n'), BR, 'Comprobación de llave'); } catch (e) { return String(e.message || e) + ' (paso 4)'; }
      return 'ok';
    }
    return { repo, tok, syncUp, pending, listRemote, getRemote, delRemote, pistas, savePista, check, setToken: t => localStorage.setItem('blr_ghToken', JSON.stringify(t)) };
  })();

  const RB = { UART, TX, Reader, decode, Engine, connect, supported, Store, Recorder, parseAll, lapsOf, toCSV, toVBO, fromVBO, fromCSV, Cloud };

  if (typeof module !== 'undefined' && module.exports) module.exports = RB; else root.RaceBox = RB;
})(typeof window !== 'undefined' ? window : globalThis);
