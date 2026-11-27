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
  function decode(p) {
    if (p.length < 80) return null;
    const d = new DataView(p.buffer, p.byteOffset, p.byteLength);
    const fix = d.getUint8(20), ff = d.getUint8(21), llf = d.getUint8(66), bat = d.getUint8(67);
    return {
      t: d.getUint32(0, true) / 1000, // segundos (reloj GPS): más fiable que la hora a la que llega el aviso
      fix, sv: d.getUint8(23), valid: fix === 3 && !!(ff & 1) && !(llf & 1),
      lon: d.getInt32(24, true) / 1e7, lat: d.getInt32(28, true) / 1e7,
      hAcc: d.getUint32(40, true) / 1000, v: d.getInt32(48, true) * 0.0036, hdg: d.getInt32(52, true) / 1e5,
      bat: bat & 127, charging: !!(bat & 128), gx: d.getInt16(68, true) / 1000, gy: d.getInt16(70, true) / 1000,
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
              E.laps.push({ T, bad: !!E.lap.bad, at: Date.now() });
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
      H.reader = Reader((cls, id, pl) => { if (cls === 0xFF && id === 0x01) { const s = decode(pl); if (s) { H.last = Date.now(); try { cb.sample && cb.sample(s); } catch (e) {} } } });
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

  const RB = { UART, TX, Reader, decode, Engine, connect, supported };
  if (typeof module !== 'undefined' && module.exports) module.exports = RB; else root.RaceBox = RB;
})(typeof window !== 'undefined' ? window : globalThis);
