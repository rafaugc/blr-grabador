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
  const DEF = { gateHalf: 14, minLap: 12, maxLap: 400, gateSpeed: 25, gateAfter: 15, lostAfter: 180, off: 12, win: 45 };
  function Engine(opts) {
    const o = Object.assign({}, DEF, opts || {});
    const E = { o, origin: null, gate: null, laps: [], ref: null, lap: null, last: null, delta: null, deltaRaw: null, idx: 0, miss: 0, moving: 0, sinceGate: 0, lastCross: null, endDelta: null, endAt: 0, n: 0, onLap: null, onGate: null };
    const xy = (lat, lon) => ({ x: (lon - E.origin.lon) * E.origin.k * 111320, y: (lat - E.origin.lat) * 110540 });
    E.setGate = g => { // meta virtual guardada de otro día en este circuito
      if (!g || !isFinite(g.lat)) return;
      E.savedGate = g;
    };
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
        if (E.savedGate) { const g = xy(E.savedGate.lat, E.savedGate.lon); if (Math.hypot(g.x, g.y) < 3000) makeGate(g, E.savedGate.hdg, E.savedGate.lat, E.savedGate.lon); }
      }
      const p = xy(s.lat, s.lon); p.t = s.t; p.v = s.v;
      const prev = E.last; E.last = p;
      if (!prev) return;
      let dt = p.t - prev.t; if (dt < -300000) dt += 604800; // cambio de semana GPS
      if (dt <= 0 || dt > 5) { if (E.lap) E.lap.bad = true; E.miss = 99; if (dt <= 0) return; }
      else if (dt > 1.2 && E.lap) E.lap.bad = true; // hueco de datos: esa vuelta no vale como referencia
      if (s.v > o.gateSpeed) { E.moving += dt; E.sinceGate += dt; }
      // meta virtual: se fija sola cuando ya llevas un rato rodando; si no vuelves a pasar por ella (p. ej. cayó en la salida de boxes), se pone otra
      if (E.gate && E.sinceGate > o.lostAfter && (!E.lastCross || p.t - E.lastCross > o.lostAfter)) { E.gate = null; E.ref = null; E.lap = null; E.delta = null; E.moving = o.gateAfter; }
      if (!E.gate) { if (E.moving >= o.gateAfter && s.v > o.gateSpeed && s.hAcc < 6) { makeGate(p, s.hdg, s.lat, s.lon); E.lap = { t0: p.t, pts: [{ x: p.x, y: p.y, t: 0 }], bad: false }; E.lastCross = p.t; if (E.onGate) E.onGate(E.gate); } return; }
      const G = E.gate;
      const s0 = (prev.x - G.x) * G.dx + (prev.y - G.y) * G.dy, s1 = (p.x - G.x) * G.dx + (p.y - G.y) * G.dy;
      if (s0 < 0 && s1 >= 0 && s1 - s0 < 30) {
        const f = -s0 / (s1 - s0), cx = prev.x + f * (p.x - prev.x), cy = prev.y + f * (p.y - prev.y);
        const lat = Math.abs((cx - G.x) * -G.dy + (cy - G.y) * G.dx), tc = prev.t + f * dt;
        if (lat <= o.gateHalf && (!E.lastCross || tc - E.lastCross >= o.minLap || !E.lap)) {
          if (E.lap) {
            const T = tc - E.lap.t0;
            E.lap.pts.push({ x: cx, y: cy, t: T });
            if (T >= o.minLap && T <= o.maxLap) {
              const isBest = !E.lap.bad && (!E.ref || T < E.ref.T);
              const prevBest = E.ref ? E.ref.T : null;
              E.laps.push({ T, bad: !!E.lap.bad, at: Date.now(), t0: E.lap.t0, t1: tc });
              E.endDelta = prevBest != null ? T - prevBest : null; E.endAt = Date.now();
              if (isBest) E.ref = { T, pts: E.lap.pts };
              if (E.onLap) E.onLap({ T, best: E.ref ? E.ref.T : null, isBest, delta: E.endDelta });
            }
          }
          E.lap = { t0: tc, pts: [{ x: cx, y: cy, t: 0 }], bad: false };
          E.lastCross = tc; E.sinceGate = 0; E.idx = 0; E.miss = 0; E.delta = null; E.deltaRaw = null;
        }
      }
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
    };
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
    if (typeof addEventListener !== 'undefined') { addEventListener('pagehide', () => R.flush()); document.addEventListener('visibilitychange', () => { if (document.hidden) R.flush(); }); }
    try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {}
    return R;
  }

  // ---------- 5. análisis y exportación ----------
  function parseAll(u8) { const out = []; for (let o = 0; o + LEN <= u8.length; o += LEN) { const s = decode(u8.subarray(o, o + LEN)); if (s) out.push(s); } return out; }
  // vueltas de una sesión grabada: se vuelve a pasar por el mismo motor que en directo
  function lapsOf(samples, gate) {
    const E = Engine(); if (gate) E.setGate(gate);
    samples.forEach(s => E.push(s));
    return { laps: E.laps.map((l, i) => ({ n: i + 1, T: l.T, t0: l.t0, t1: l.t1, bad: l.bad })), best: E.ref ? E.ref.T : null, gate: E.gate ? { lat: E.gate.lat, lon: E.gate.lon, hdg: E.gate.hdg } : null };
  }
  const lapAt = (laps, t) => { for (const l of laps) if (t >= l.t0 && t < l.t1) return l.n; return 0; };
  const p2 = n => String(n).padStart(2, '0');
  function toCSV(samples, laps) {
    laps = laps || [];
    const t0 = samples.length ? samples[0].t : 0, f = (x, n) => x == null || !isFinite(x) ? '' : x.toFixed(n);
    const rows = ['utc,tiempo_s,vuelta,latitud,longitud,velocidad_kmh,rumbo_grados,altura_m,altura_wgs_m,g_longitudinal,g_lateral,g_vertical,giro_balanceo_gs,giro_cabeceo_gs,giro_guinada_gs,satelites,fix,gps_valido,precision_horizontal_m,precision_vertical_m,precision_velocidad_kmh,precision_rumbo_grados,pdop,bateria_pct'];
    for (const s of samples) rows.push([s.utc != null ? new Date(s.utc).toISOString() : '', f(s.t - t0, 2), lapAt(laps, s.t), f(s.lat, 7), f(s.lon, 7), f(s.v, 2), f(s.hdg, 2), f(s.alt, 2), f(s.altW, 2), f(s.gx, 3), f(s.gy, 3), f(s.gz, 3), f(s.rx, 2), f(s.ry, 2), f(s.rz, 2), s.sv, s.fix, s.valid ? 1 : 0, f(s.hAcc, 2), f(s.vAcc, 2), f(s.sAcc, 2), f(s.hdgAcc, 2), f(s.pdop, 2), s.bat].join(','));
    return rows.join('\r\n') + '\r\n';
  }
  // Formato .vbo (Racelogic VBOX): lo abren Circuit Tools, RaceChrono, etc. Latitud y longitud van en minutos, y la longitud OESTE es positiva.
  function toVBO(samples) {
    const ok = samples.filter(s => s.valid && s.utc != null);
    const d0 = new Date(ok.length ? ok[0].utc : Date.now());
    const sg = (x, w, n) => (x < 0 ? '-' : '+') + Math.abs(x).toFixed(n).padStart(w, '0');
    const head = ['File created on ' + p2(d0.getUTCDate()) + '/' + p2(d0.getUTCMonth() + 1) + '/' + d0.getUTCFullYear() + ' at ' + p2(d0.getUTCHours()) + ':' + p2(d0.getUTCMinutes()) + ':' + p2(d0.getUTCSeconds()), '',
      '[header]', 'satellites', 'time', 'latitude', 'longitude', 'velocity kmh', 'heading', 'height', 'longitudinal acceleration g', 'lateral acceleration g', 'vertical acceleration g', 'roll rate deg/s', 'pitch rate deg/s', 'yaw rate deg/s', '',
      '[comments]', 'KR DASH · RaceBox', 'Log Rate (Hz) : 25.00', '',
      '[column names]', 'sats time lat long velocity heading height longacc latacc vertacc rollrate pitchrate yawrate', '', '[data]'];
    const rows = ok.map(s => { const d = new Date(Math.round(s.utc / 10) * 10);
      return [String(s.sv).padStart(3, '0'), p2(d.getUTCHours()) + p2(d.getUTCMinutes()) + p2(d.getUTCSeconds()) + '.' + p2(Math.floor(d.getUTCMilliseconds() / 10)),
        sg(s.lat * 60, 12, 6), sg(-s.lon * 60, 13, 6), Math.max(0, s.v).toFixed(3).padStart(7, '0'), (((s.hdg % 360) + 360) % 360).toFixed(2).padStart(6, '0'), sg(s.alt, 8, 2),
        sg(s.gx, 5, 3), sg(s.gy, 5, 3), sg(s.gz, 5, 3), sg(s.rx, 6, 2), sg(s.ry, 6, 2), sg(s.rz, 6, 2)].join(' '); });
    return head.concat(rows).join('\r\n') + '\r\n';
  }

  const RB = { UART, TX, Reader, decode, Engine, connect, supported, Store, Recorder, parseAll, lapsOf, toCSV, toVBO };

  if (typeof module !== 'undefined' && module.exports) module.exports = RB; else root.RaceBox = RB;
})(typeof window !== 'undefined' ? window : globalThis);
