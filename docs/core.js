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

  // ===================== Lector general de PDFs de Apex Timing =====================
  // Entiende: "Resumen" (Los Santos), "Resultados" / "Resultados por nivel" con "Histórico de records" (vueltas en tabla),
  // "Análisis de tiempos" (vuelta a vuelta en columnas) y "Resultados" sin vueltas (solo para poner la posición).
  // Lee solo el circuito, el día, la hora y el nombre de la sesión.
  const TIME_FULL = new RegExp('^' + TIME + '$');
  const LETTERS = /[A-Za-zÁÉÍÓÚÑÜÇáéíóúñüç]{2,}/;
  const FOOT_RE = /Apex Timing|apex-timing|P[áa]gina\s+\d|MEJORES TIEMPOS|Record de la sesi|Lapchart|^Histórico|GoKarts/i;
  const deacc = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const ucw = s => s.toLowerCase().replace(/(^|[\s(+\-/])([a-zñ])/g, (m, a, b) => a + b.toUpperCase());

  function pageRows(items) {
    const rows = [];
    const hs = items.filter(i => i.ocr && i.height).map(i => i.height);
    const tol = hs.length ? Math.max(2.4, median(hs) * 1.1) : 2.4;
    for (const it of items) {
      const s = (it.str || '').trim(); if (!s) continue;
      const x = it.transform[4], y = it.transform[5], w = it.width || 0;
      let row = rows.find(r => Math.abs(r.y - y) < tol);
      if (!row) { row = { y, items: [] }; rows.push(row); }
      row.items.push({ x, w, c: x + w / 2, s });
    }
    rows.sort((a, b) => b.y - a.y);
    rows.forEach(r => { r.items.sort((a, b) => a.x - b.x); r.text = r.items.map(i => i.s).join('  '); });
    return rows;
  }

  // Cabecera: "KARTED ALFA - CARRERA 1 - RACING        14/11/2026 - 12:18"
  function findHeader(rows) {
    for (const r of rows.slice(0, 16)) {
      if (FOOT_RE.test(r.text)) continue;
      const m = r.text.match(/^(.*?)\s*(\d{2})\/(\d{2})\/(\d{4})\s*-\s*(\d{1,2}):(\d{2})\s*$/);
      if (m && LETTERS.test(m[1])) return { raw: m[1].trim(), date: `${m[4]}-${m[3]}-${m[2]}`, time: `${m[5].padStart(2, '0')}:${m[6]}` };
    }
    return null;
  }
  const SES_WORD = /^(CRONOS?|CRONO\b|CARRERA|FINAL|SEMIFINAL|MANGA|HEAT|SPRINT|CLASIFICACI|QUALY|QUALI|ENTRENO|ENTRENAMIENTO|LIBRES?|PR[AÁ]CTICA|WARM|RESISTENCIA|SUPERPOLE|POLE|TANDA)/i;
  const CODE = [[/^Q\d?$/i, () => 'Clasificación'], [/^R(\d+)$/i, m => 'Carrera ' + m[1]], [/^(FP|P|L)(\d*)$/i, m => 'Libres' + (m[2] ? ' ' + m[2] : '')], [/^F$/i, () => 'Final']];
  function splitTitle(raw, ocr) {
    raw = raw.replace(/\s+/g, ' ').replace(/\s?-\s?/g, ' - ');
    if (ocr) raw = raw.replace(/^([A-Za-z]\d?)\s+(?!-)/, '$1 - ');
    let parts = raw.split(/\s+-\s+/).map(p => p.trim()).filter(Boolean).filter(p => !/^RACING$/i.test(p))
      .flatMap(p => { const m = p.match(/^(R\d{1,2}|Q\d?)\s+(.+)$/i); return m ? [m[1], m[2]] : [p]; });
    if (ocr && parts.length > 1 && parts[0].length <= 2 && !CODE.some(([re]) => re.test(parts[0]))) parts[0] = 'Q';   // "Q" mal leída
    let type = '', rest = [];
    for (const p of parts) {
      const code = !type && CODE.find(([re]) => re.test(p));
      if (code) { type = code[1](p.match(code[0])); continue; }
      if (!type && SES_WORD.test(deacc(p))) { type = ucw(p); continue; }
      rest.push(p);
    }
    if (!type && rest.length > 1) type = ucw(rest.pop());
    return { group: ucw(rest.join(' ')).slice(0, 30), type: (type || 'Sesión').slice(0, 30) };
  }

  // Circuito: busca en todo el texto (pie de página "HENAKART - Pista Principal", "KARTING CLUB LOS SANTOS"...)
  const GENERIC = new Set(['KARTING', 'KART', 'KARTS', 'CIRCUITO', 'CIRCUIT', 'RACING', 'CLUB', 'DE', 'DEL', 'LA', 'LAS', 'LOS', 'EL', 'PISTA', 'KARTODROMO', 'INDOOR', 'OUTDOOR', 'PRINCIPAL', 'GOKARTS', 'TIMING', 'LIVE', 'SPORT', 'CENTER']);
  function detectCircuit(text, circs) {
    const T = ' ' + deacc(text).toUpperCase().replace(/[^A-Z0-9]+/g, ' ') + ' ';
    let best = null, bestScore = 0, tie = false;
    for (const c of circs || []) {
      const words = [...new Set(deacc((c.nombre || '') + ' ' + (c.slug || '').replace(/-/g, ' ')).toUpperCase().split(/[^A-Z0-9]+/))]
        .filter(w => w.length >= 3 && !GENERIC.has(w));
      const score = words.filter(w => T.includes(' ' + w + ' ')).length;
      if (score > bestScore) { best = c; bestScore = score; tie = false; } else if (score && score === bestScore) tie = true;
    }
    return best && !tie ? best.slug : null;
  }

  // Columnas de una fila de cabecera: devuelve el centro de cada título
  function dist(a, b) {
    let prev = Array.from({ length: b.length + 1 }, (_, k) => k);
    for (let i = 1; i <= a.length; i++) { const cur = [i]; for (let k = 1; k <= b.length; k++) cur[k] = Math.min(prev[k] + 1, cur[k - 1] + 1, prev[k - 1] + (a[i - 1] === b[k - 1] ? 0 : 1)); prev = cur; }
    return prev[b.length];
  }
  function lev1(a, b) { // ¿iguales o casi? (1 letra mal; 2 en palabras largas como "piloto")
    if (a === b) return true; if (b.length < 4 || Math.abs(a.length - b.length) > 2) return false;
    let prev = Array.from({ length: b.length + 1 }, (_, k) => k);
    for (let i = 1; i <= a.length; i++) { const cur = [i]; for (let k = 1; k <= b.length; k++) cur[k] = Math.min(prev[k] + 1, cur[k - 1] + 1, prev[k - 1] + (a[i - 1] === b[k - 1] ? 0 : 1)); prev = cur; }
    return prev[b.length] <= (b.length >= 6 ? 2 : 1);
  }
  const ALIAS = { kart: ['kan', 'karl', 'kar', 'kari'], clasif: ['clas', 'clasit', 'ciasif'] };
  const hdr = (row, word) => { const w = word.toLowerCase(), al = ALIAS[w] || [];
    return row.items.filter(i => { const t = deacc(i.s).replace(/[.:|,]/g, '').toLowerCase().trim(); return lev1(t, w) || al.includes(t); }); };
  const near = (items, c, tol) => items.filter(i => Math.abs(i.c - c) <= tol);
  const isInt = s => /^\d{1,3}$/.test(s);
  const nameOf = s => s.replace(new RegExp(TIME, 'g'), '').replace(/\s+/g, ' ').trim();

  // Clasificación (una o dos columnas de pilotos): {kart: {pos, name}}
  function readClassification(rows) {
    const res = {};
    let blocks = null;
    for (const r of rows) {
      const cl = hdr(r, 'Clasif'), ka = hdr(r, 'Kart'), pi = hdr(r, 'Piloto');
      if (cl.length && ka.length && pi.length) {
        const mv = hdr(r, 'Mejor vuelta');
        blocks = cl.map((c, i) => { const to = cl[i + 1] ? cl[i + 1].x - 8 : 1e9, b = mv.find(m => m.x > c.x && m.x < to);
          return { from: c.x - 8, to, pos: c.c, kart: (ka.find(k => k.x > c.x - 2) || ka[i] || ka[0]).c, name: (pi.find(p => p.x > c.x - 2) || pi[i] || pi[0]).x, best: b ? b.c : null }; });
        continue;
      }
      if (!blocks) continue;
      if (/Hist[oó]rico|Lapchart|MEJORES/.test(r.text)) { blocks = null; continue; }
      for (const b of blocks) {
        const its = r.items.filter(i => i.x >= b.from && i.x < b.to);
        const tl = its.some(i => i.ocr) ? 11 : 6;   // un escaneo no cuadra tan exacto
        const p = near(its, b.pos, tl).find(i => isInt(i.s)), k = near(its, b.kart, tl + 1).find(i => isInt(i.s) && i !== p);
        const n = its.find(i => Math.abs(i.x - b.name) < tl && LETTERS.test(i.s));
        const bt = b.best != null ? near(its, b.best, 18).find(i => TIME_FULL.test(i.s)) : null;
        if (p && k && n && +p.s > 0 && +p.s < 100) res[k.s] = { pos: +p.s, name: nameOf(n.s), kart: k.s, best: bt ? tsec(bt.s) : null };
      }
    }
    return res;
  }

  // "Histórico de records": una fila por kart con sus vueltas (puede seguir en la fila siguiente)
  function readHistory(rows) {
    // La tabla puede seguir en las páginas siguientes (con o sin títulos de columna): se sigue leyendo con la misma disposición.
    const out = []; let on = false, kartC = null, nameX = null, mediaC = null, cur = null;
    const ocr = rows.some(r => r.items.some(i => i.ocr)), tk = ocr ? 12 : 8;
    for (const r of rows) {
      if (hdr(r, 'Clasif').length) { on = false; cur = null; continue; }
      const ka = hdr(r, 'Kart'), pi = hdr(r, 'Piloto');
      const nums = r.items.filter(i => /^(\d|10)$/.test(i.s)).length;
      if ((ka.length === 1 && pi.length === 1) || ((pi.length === 1 || (on && ka.length === 1)) && nums >= 3)) {
        if (pi.length === 1) { nameX = pi[0].x; kartC = ka.length === 1 ? ka[0].c : (kartC != null ? kartC : nameX - 12); }
        else kartC = ka[0].c;
        on = true;
        const me = rows.filter(o => Math.abs(o.y - r.y) < 9).flatMap(o => hdr(o, 'Media'))[0]; if (me) mediaC = me.c;
        continue;
      }
      if (!on || FOOT_RE.test(r.text)) continue;
      const k = near(r.items, kartC, tk).find(i => isInt(i.s));
      const nm = r.items.find(i => i.x > kartC - 4 && i.x < nameX + 40 && LETTERS.test(i.s) && i.s.replace(/[^A-Za-zÁÉÍÓÚÑÜÇáéíóúñüç]/g, '').length >= (ocr ? 5 : 2));
      const times = [];
      r.items.forEach(i => { if (mediaC != null && Math.abs(i.c - mediaC) < 14) return; if (i.x < nameX + 30 && !TIME_FULL.test(i.s)) return; (i.s.match(new RegExp(TIME, 'g')) || []).forEach(t => times.push(tsec(t))); });
      if (nm && (k || ocr)) { cur = { kart: k ? k.s : null, name: nameOf(nm.s), laps: times }; out.push(cur); }
      else if (ocr && k && times.length >= 3) { cur = { kart: k.s, name: null, laps: times }; out.push(cur); }   // nombre ilegible: se saca de la clasificación
      else if (cur && !k && (times.length >= 2 || (times.length && !ocr))) cur.laps.push(...times);
    }
    return out;
  }

  // "Análisis de tiempos": bloques por piloto en 5–6 columnas. En cada columna, de arriba abajo:
  // NOMBRE, luego filas "kart  tiempo  nº vuelta". Un bloque puede seguir en la columna siguiente.
  function readAnalysis(pages) {
    const drivers = []; let cur = null;
    for (const rows of pages) {
      const head = rows.find(r => hdr(r, 'Kart').length && /Temps|Vueltas/.test(r.text));
      if (!head) continue;
      const cols = hdr(head, 'Kart').map(k => k.x).sort((a, b) => a - b);
      const body = rows.filter(r => r.y < head.y - 3 && !FOOT_RE.test(r.text));
      for (let ci = 0; ci < cols.length; ci++) {
        const x0 = cols[ci] - 4, x1 = ci + 1 < cols.length ? cols[ci + 1] - 4 : 1e9;
        for (const r of body) {
          const its = r.items.filter(i => i.x >= x0 && i.x < x1);
          if (!its.length) continue;
          const nm = its.find(i => LETTERS.test(i.s));
          if (nm) { cur = { name: nameOf(nm.s), laps: [] }; drivers.push(cur); continue; }
          if (!cur) continue;
          const t = its.find(i => TIME_FULL.test(i.s));
          const k = its.find(i => isInt(i.s) && i.x - cols[ci] < 30);
          const n = its.find(i => isInt(i.s) && i.x - cols[ci] > 50);
          if (k) cur.kart = cur.kart || k.s;
          if (t) cur.laps.push({ kart: k ? k.s : cur.kart, n: n ? +n.s : cur.laps.length + 1, t: tsec(t.s) });
        }
      }
    }
    return drivers;
  }

  function fallbackPos(stints, type) {
    const cron = /crono|clasif|qual/i.test(type);
    const key = t => cron ? [Math.min(...t.laps)] : [-t.laps.length, t.laps.reduce((a, b) => a + b, 0)];
    [...stints].sort((a, b) => { const A = key(a), B = key(b); return A[0] - B[0] || (A[1] || 0) - (B[1] || 0); }).forEach((t, i) => { if (t.pos == null) t.pos = i + 1; });
  }

  // pages = [[items de pdf.js de la página 1], [página 2], ...]   (opts.ocr = el texto viene de leer un escaneo)
  function parsePdf(pages, fileLabel, circs, opts) {
    opts = opts || {};
    const rowsP = pages.map(pageRows);
    const allRows = rowsP.flat();
    const text = allRows.map(r => r.text).join('\n');
    const warnings = [];
    const base = { sessions: [], warnings, scanned: false, kind: '', circuit: detectCircuit(text, circs) };
    if (allRows.length < 5) return Object.assign(base, { scanned: true });
    // 1) formato "Resumen" de siempre
    if (!opts.ocr) {
      const lines = pages.map(it => linesFromItems(it)).flat();
      const old = parseResumen(lines, fileLabel);
      if (old.sessions.length) { old.sessions.forEach(s => { s.slug = base.circuit; }); return Object.assign(base, old, { kind: 'Resumen', circuit: base.circuit }); }
    }
    // 2) cada cabecera "NOMBRE - SESIÓN    dd/mm/aaaa - hh:mm" empieza una sesión; las páginas sin cabecera la continúan
    const segs = [];
    rowsP.forEach(rows => {
      const h = findHeader(rows);
      const last = segs[segs.length - 1];
      if (h && (!last || last.head.raw !== h.raw || last.head.time !== h.time)) segs.push({ head: h, rows: [rows] });
      else if (last) last.rows.push(rows);
    });
    const kinds = new Set();
    for (const seg of segs) {
      const r = parseSegment(seg.head, seg.rows, fileLabel, base.circuit, opts, warnings);
      if (r.sess) base.sessions.push(r.sess);
      if (r.kind) kinds.add(r.kind);
    }
    if (opts.ocr && base.sessions.length > 1) {   // nombres de grupo mal leídos: se usa el del resto de sesiones del mismo PDF si se parece
      const cnt = {}; base.sessions.forEach(s => cnt[s.group] = (cnt[s.group] || 0) + 1);
      const best = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a] || b.length - a.length)[0];
      base.sessions.forEach(s => { if (s.group !== best && dist(s.group.toUpperCase(), best.toUpperCase()) <= Math.max(4, best.length * 0.45)) s.group = best; });
    }
    base.kind = [...kinds].join(', ') + (opts.ocr ? ' (escaneo)' : '');
    return base;
  }

  function parseSegment(head, rowsP, fileLabel, slug, opts, warnings) {
    const allRows = rowsP.flat(), text = allRows.map(r => r.text).join('\n');
    const { group, type } = splitTitle(head.raw, opts.ocr);
    const sess = { circuit: '', slug, date: head.date, time: head.time, group, type, rawTitle: head.raw, source: fileLabel || 'PDF', stints: [] };
    if (opts.ocr) sess.ocr = true;
    const cls = readClassification(allRows);
    const byName = {}; Object.values(cls).forEach(c => byName[deacc(c.name).toUpperCase()] = c);
    let kind = '';
    if (/An[aá]lisis de tiempos/i.test(text)) {
      kind = 'Análisis de tiempos';
      for (const d of readAnalysis(rowsP)) {
        d.laps.sort((a, b) => a.n - b.n);
        let st = null;
        for (const l of d.laps) {        // si cambia de kart a mitad de sesión, es otra tanda
          if (!st || st.kart !== +l.kart) { st = { kart: +l.kart, driver: d.name, cls: '', pos: null, laps: [] }; sess.stints.push(st); }
          st.laps.push(Math.round(l.t * 1000) / 1000);
        }
      }
    } else if (/Hist[oó]rico/i.test(text)) {
      kind = 'Resultados con vueltas';
      const nk = n => deacc(n).toUpperCase().replace(/[^A-Z]/g, '');
      for (const h of readHistory(allRows)) {
        if (!h.laps.length) continue;
        const byN = () => h.name && Object.values(cls).find(c => nk(c.name).slice(0, 8) === nk(h.name).slice(0, 8));
        if (opts.ocr && (h.kart == null || !cls[h.kart] || +h.kart > 99)) { const c = byN(); if (c && +c.kart <= 99) h.kart = c.kart; }   // kart mal leído
        if (opts.ocr && h.kart != null && +h.kart > 99) h.kart = String(+h.kart % 100);       // "139" = un "1" de la columna de al lado + kart 39
        if (h.kart != null && +h.kart < 1) continue;
        if (h.kart == null) continue;
        const c = cls[h.kart];
        const laps = h.laps.map(t => Math.round(t * 1000) / 1000), same = sess.stints.find(t => t.kart === +h.kart);
        if (same && opts.ocr) { same.laps.push(...laps); continue; }   // el mismo kart partido en dos filas
        sess.stints.push({ kart: +h.kart, driver: h.name || (c ? c.name : ''), cls: '', pos: c ? c.pos : null, laps });
      }
    } else if (Object.keys(cls).length) {
      sess.resultsOnly = cls;
      return { sess, kind: 'Resultados (sin vueltas)' };
    }
    sess.stints.forEach(st => {
      const c = cls[st.kart] || byName[deacc(st.driver).toUpperCase()];
      if (c && st.pos == null) st.pos = c.pos;
      if (c && c.best) st._best = c.best;
    });
    if (opts.ocr) { cleanOcrLaps(sess, warnings); tidyOcr(sess, cls); }
    sess.stints.forEach(st => delete st._best);
    sess.stints = sess.stints.filter(t => t.laps.length);
    return { sess: sess.stints.length ? sess : null, kind };
  }

  // Vueltas leídas de un escaneo: fuera las imposibles (más rápidas que su mejor vuelta oficial, o absurdas)
  function cleanOcrLaps(sess, warnings) {
    const all = sess.stints.flatMap(t => t.laps), med = median(all);
    let out = 0;
    for (const t of sess.stints) {
      const n = t.laps.length;
      t.laps = t.laps.map(x => x > med * 1.3 && Math.abs(x - 60 - med) < med * 0.1 ? Math.round((x - 60) * 1000) / 1000 : x);
      t.laps = t.laps.filter(x => x > med * 0.9 && x < med * 1.6 && !(t._best && x < t._best - 0.005));
      out += n - t.laps.length;
      if (t._best && t.laps.length && Math.abs(Math.min(...t.laps) - t._best) > 0.005) t.laps.push(t._best); // su mejor vuelta oficial no se pierde
    }
    if (out) warnings.push(`${sess.group} ${sess.type}: ${out} números del escaneo descartados por mal leídos`);
  }

  // Escaneo: nombres sin números, sin pilotos repetidos, posiciones imposibles fuera y sin vueltas de otro piloto pegadas
  function tidyOcr(sess, cls) {
    const nk = n => deacc(n).toUpperCase().replace(/[^A-Z]/g, '');
    sess.stints.forEach(t => { t.driver = t.driver.replace(/[^A-Za-zÁÉÍÓÚÑÜÇáéíóúñüç .'-]+.*$/, '').replace(/\s+/g, ' ').replace(/(\s[A-Za-z]){1,2}$/, '').trim(); const c = cls[t.kart]; if ((!t.driver || t.driver.length < 4) && c) t.driver = c.name; });
    const keep = [];
    for (const t of [...sess.stints].sort((a, b) => (cls[b.kart] ? 1 : 0) - (cls[a.kart] ? 1 : 0) || b.laps.length - a.laps.length)) {
      const twin = keep.find(o => nk(o.driver).length >= 6 && dist(nk(t.driver).slice(0, 12), nk(o.driver).slice(0, 12)) <= 2);
      if (!twin) keep.push(t);
    }
    sess.stints = sess.stints.filter(t => keep.includes(t));
    const n = sess.stints.length, used = new Set();
    sess.stints.forEach(t => { if (t.pos != null && (t.pos > n + 2 || used.has(t.pos))) t.pos = null; if (t.pos != null) used.add(t.pos); });
    const cap = Math.ceil(median(sess.stints.map(t => t.laps.length)) * 1.25) + 1;
    sess.stints.forEach(t => { if (t.laps.length > cap) t.laps = t.laps.slice(0, cap); });
  }

  // ---------- escaneos: limpiar la imagen y convertir lo leído (OCR) en "texto de PDF" ----------
  // Las casillas resaltadas (número blanco sobre negro) se invierten para que se puedan leer.
  function cleanScan(px, w, h, bin) {   // bin = además pasar a blanco y negro según el fondo de alrededor (2ª lectura)
    const N = w * h, g = new Uint8Array(N);
    for (let i = 0; i < N; i++) g[i] = (px[i * 4] * 0.3 + px[i * 4 + 1] * 0.59 + px[i * 4 + 2] * 0.11) | 0;
    const out = Uint8Array.from(g);   // fuera de las casillas resaltadas, la imagen tal cual (el lector ya umbraliza bien)
    if (bin) {
      const r = Math.max(8, Math.round(w / 90)), I = new Float64Array((w + 1) * (h + 1));
      for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += g[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row; } }
      for (let y = 0; y < h; y++) { const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
        for (let x = 0; x < w; x++) { const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
          const m = (I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0]) / ((x1 - x0) * (y1 - y0));
          out[y * w + x] = g[y * w + x] < Math.min(m * 0.8, 190) ? 0 : 255; } }
    }
    // casillas resaltadas: manchas oscuras grandes y macizas → número en negro sobre blanco, sin el marco
    const lab = new Int32Array(N), stack = new Int32Array(N), minH = Math.round(w / 65), minW = Math.round(w / 30);
    let id = 0;
    for (let s0 = 0; s0 < N; s0++) {
      if (lab[s0] || g[s0] >= 110) continue;
      id++; let sp = 0, cnt = 0, x0 = w, x1 = 0, y0 = h, y1 = 0; stack[sp++] = s0; lab[s0] = id;
      while (sp) { const p = stack[--sp], x = p % w, y = (p - x) / w; cnt++;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
        for (const q of nb) if (q >= 0 && !lab[q] && g[q] < 110) { lab[q] = id; stack[sp++] = q; } }
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      if (bw >= minW && bh >= minH && cnt / (bw * bh) > 0.65 && bh < h / 10) {
        const e = Math.max(2, Math.round(bh / 12));
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
          const k = y * w + x; out[k] = (x - x0 < e || x1 - x < e || y - y0 < e || y1 - y < e) ? 255 : g[k] > 135 ? 0 : 255; }
      }
    }
    for (let i = 0; i < N; i++) { px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = out[i]; px[i * 4 + 3] = 255; }
    return px;
  }
  function normTok(s) {
    s = s.replace(/[|‘’'"`©®«»“”_~]/g, '').trim();
    if (/[0-9A-Za-z]/.test(s)) s = s.replace(/^[^0-9A-Za-zÁÉÍÓÚÑÜÇáéíóúñüç]+|[^0-9A-Za-zÁÉÍÓÚÑÜÇáéíóúñüç.]+$/g, '');
    if (/^\d{1,2}:?\d{2}[.,:]\d{3}$/.test(s) || /^\d[.,:]\d{2}[.,:]\d{3}$/.test(s)) {
      const d = s.replace(/\D/g, ''); return d.length === 5 ? d.slice(0, 2) + '.' + d.slice(2) : d.slice(0, d.length - 5) + ':' + d.slice(-5, -3) + '.' + d.slice(-3);
    }
    if (/^\d{5}$/.test(s)) return s.slice(0, 2) + '.' + s.slice(2);
    if (/^\d{6}$/.test(s) && +s[1] <= 5) return s[0] + ':' + s.slice(1, 3) + '.' + s.slice(3);
    if (/^\d{1,3}[.,:;]$/.test(s)) return s.slice(0, -1);
    return s;
  }
  // words = [{text, bbox:{x0,y0,x1,y1}, line}] en píxeles de la imagen → elementos como los de pdf.js (en puntos)
  function ocrToItems(words, imgW, imgH, pageW, pageH) {
    const sx = pageW / imgW, sy = pageH / imgH, out = [];
    const ws = words.map(w => ({ t: normTok(w.text || ''), b: w.bbox, line: w.line })).filter(w => w.t);
    let cur = null;
    const flush = () => { if (cur) out.push({ str: cur.t, transform: [1, 0, 0, 1, cur.b.x0 * sx, pageH - (cur.b.y0 + cur.b.y1) / 2 * sy], width: (cur.b.x1 - cur.b.x0) * sx, height: (cur.b.y1 - cur.b.y0) * sy, ocr: true }); cur = null; };
    for (const w of ws) {
      if (cur && cur.line === w.line) {
        const hgt = Math.max(cur.b.y1 - cur.b.y0, w.b.y1 - w.b.y0), gap = w.b.x0 - cur.b.x1;
        const head = t => /^(kart|kan|karl|piloto|plloto|clasif|clas|vueltas|vuela|gap|media|tiempos|temps|pits|interv|nivel|categor)/i.test(deacc(t));
        const letters = LETTERS.test(cur.t) && /^[A-Za-zÁÉÍÓÚÑÜÇáéíóúñüç.]/.test(w.t) && gap < hgt * 1.1 && !head(cur.t) && !head(w.t);
        const split = /^\d{2}$/.test(cur.t) && /^\d{3}$/.test(w.t) && gap < hgt * 0.9;   // "44 348" → 44.348
        if (letters || split) { cur.t = split ? cur.t + '.' + w.t : cur.t + ' ' + w.t; cur.b = { x0: cur.b.x0, y0: Math.min(cur.b.y0, w.b.y0), x1: w.b.x1, y1: Math.max(cur.b.y1, w.b.y1) }; continue; }
      }
      flush(); cur = { t: w.t, b: Object.assign({}, w.b), line: w.line };
    }
    flush();
    return out;
  }

  // Junta lo leído de varios PDF: el "Resultados" sin vueltas pone las posiciones al "Análisis" de la misma sesión;
  // si la misma sesión llega dos veces, se queda la que tenga más vueltas.
  function mergePdfSessions(list) {
    const nk = n => deacc(n).toUpperCase().replace(/[^A-Z]/g, '');
    const groups = [];
    for (const s of list) {   // misma sesión = mismo día y hora (y mismo circuito si se sabe)
      let g = groups.find(g => g.date === s.date && g.time === s.time && (!g.slug || !s.slug || g.slug === s.slug));
      if (!g) { g = { date: s.date, time: s.time, slug: s.slug, items: [] }; groups.push(g); }
      if (!g.slug) g.slug = s.slug;
      g.items.push(s);
    }
    const out = [], orphan = [];
    for (const g of groups) {
      const laps = g.items.filter(s => !s.resultsOnly), res = g.items.filter(s => s.resultsOnly);
      if (!laps.length) { orphan.push(...res); continue; }
      laps.sort((a, b) => (a.ocr ? 1 : 0) - (b.ocr ? 1 : 0) || b.stints.reduce((x, t) => x + t.laps.length, 0) - a.stints.reduce((x, t) => x + t.laps.length, 0));
      const m = Object.assign({}, laps[0], { slug: g.slug, stints: laps[0].stints.map(t => Object.assign({}, t)) });
      const srcs = new Set([laps[0].source]);
      const find = t => m.stints.find(o => o.kart === t.kart && (nk(o.driver) === nk(t.driver) || nk(o.driver).startsWith(nk(t.driver).slice(0, 6)) || nk(t.driver).startsWith(nk(o.driver).slice(0, 6))))
        || m.stints.find(o => o.kart === t.kart && m.stints.filter(x => x.kart === t.kart).length === 1)
        || (s0 => s0.ocr ? m.stints.find(o => nk(o.driver).length >= 6 && dist(nk(o.driver).slice(0, 12), nk(t.driver).slice(0, 12)) <= 2) : null)(curSrc);
      let curSrc = null;
      for (const s of laps.slice(1)) {          // juntar: cada piloto se queda con la lista de vueltas más completa
        srcs.add(s.source); curSrc = s;
        for (const t of s.stints) {
          const o = find(t);
          if (!o) { m.stints.push(Object.assign({}, t)); continue; }
          if (t.laps.length > o.laps.length && !(s.ocr && !laps[0].ocr)) o.laps = t.laps;
          if (o.pos == null) o.pos = t.pos;
          if (!o.cls) o.cls = t.cls;
          if (t.driver.length > o.driver.length && !s.ocr) o.driver = t.driver;
        }
      }
      for (const r of res) {                    // las posiciones oficiales mandan
        srcs.add(r.source);
        const byName = {}; Object.values(r.resultsOnly).forEach(c => byName[nk(c.name)] = c);
        m.stints.forEach(t => { const c = r.resultsOnly[t.kart] || byName[nk(t.driver)]; if (c) t.pos = c.pos; });
      }
      m.source = [...srcs].join(' + ').slice(0, 80);
      m.ocr = laps.every(s => s.ocr);
      if (m.stints.every(t => t.pos == null)) fallbackPos(m.stints, m.type);   // si se sabe alguna posición, no se inventan las demás
      out.push(m);
    }
    out.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    return { sessions: out, onlyResults: orphan };
  }

  // ---------- utilidades estadísticas ----------
  const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
  // mejor media de n vueltas SEGUIDAS de una tanda (sin la 1ª vuelta, que es de salida)
  function bestN(laps, n) {
    const c = (laps || []).slice(1); let best = null;
    for (let i = 0; i + n <= c.length; i++) { const m = mean(c.slice(i, i + n)); if (best == null || m < best) best = m; }
    return best;
  }
  // ---------- evolución de la pista dentro de una sesión (lluvia que empieza, pista que se seca o coge goma) ----------
  // Con TODOS los karts a la vez: cada vuelta se compara con la mediana de su propia tanda; la mediana de esas
  // proporciones minuto a minuto es la "curva de la pista". Si cambia más de un 1,5 %, se descuenta de cada vuelta.
  const tsOf = t => { if (t.ts && t.ts.length === t.laps.length && t.ts.every(x => x)) return t.ts; let c = 0; return t.laps.map(x => (c += x)); };
  function trackCurve(s, minAmp) {
    const pts = [];
    for (const t of s.stints || []) {
      const L = (t.laps || []).slice(1); if (L.length < 3) continue;
      const ts = tsOf(t).slice(1), ref = median(L);
      L.forEach((x, i) => { const r = x / ref; if (r > 0.9 && r < 1.15) pts.push([ts[i], r]); });
    }
    if (pts.length < 30) return null;
    pts.sort((a, b) => a[0] - b[0]);
    const t0 = pts[0][0], t1 = pts[pts.length - 1][0], span = t1 - t0;
    if (span < 240) return null;
    const w = Math.max(90, span / 12), nb = Math.ceil(span / w) || 1, bins = Array.from({ length: nb }, () => []);
    pts.forEach(([t, r]) => bins[Math.min(nb - 1, Math.floor((t - t0) / w))].push(r));
    let c = bins.map(b => b.length >= 4 ? median(b) : null);
    const known = c.map((v, i) => v == null ? null : i).filter(i => i != null);
    if (known.length < 3) return null;
    c = c.map((v, i) => { if (v != null) return v; const a = known.filter(k => k < i).pop(), b = known.find(k => k > i); return a == null ? c[b] : b == null ? c[a] : c[a] + (c[b] - c[a]) * (i - a) / (b - a); });
    c = c.map((v, i) => mean(c.slice(Math.max(0, i - 1), i + 2)));
    const mid = t => t0 + (t + 0.5) * w;
    const at0 = t => { const x = (t - t0) / w - 0.5; if (x <= 0) return c[0]; if (x >= nb - 1) return c[nb - 1]; const i = Math.floor(x); return c[i] + (c[i + 1] - c[i]) * (x - i); };
    const norm = median(pts.map(p => at0(p[0])));
    const curve = c.map(v => v / norm);
    const amp = Math.max(...curve) - Math.min(...curve);
    const third = Math.max(1, Math.floor(nb / 3));
    const trend = mean(curve.slice(-third)) - mean(curve.slice(0, third)); // + = más lenta al final
    const out = { t0, w, curve, amp, trend, times: curve.map((_, i) => mid(i)), at: t => at0(t) / norm };
    out.apply = amp >= (minAmp ?? 0.015);
    return out;
  }
  const minN = a => { const v = a.filter(x => x != null && isFinite(x)); return v.length ? Math.min(...v) : null; };
  const median = a => { if (!a.length) return NaN; const b = [...a].sort((x, y) => x - y), m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };

  // Une nombres que son el mismo piloto (p.ej. nombre cortado en el PDF)
  function nameMap(names) {
    // mismo piloto escrito en otro orden ("OSCAR PEREZ" / "PEREZ OSCAR"): se usa la forma más repetida
    const cnt = {}; names.forEach(n => cnt[n] = (cnt[n] || 0) + 1);
    const key = n => n.replace(/-/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
    const rep = {}; Object.keys(cnt).forEach(n => { const k = key(n); if (!(k in rep) || cnt[n] > cnt[rep[k]]) rep[k] = n; });
    const order = {}; Object.keys(cnt).forEach(n => order[n] = rep[key(n)]);
    names = names.map(n => order[n]);
    const uniq = [...new Set(names)].sort((a, b) => b.length - a.length);
    const map = {};
    for (const n of uniq) {
      const longer = uniq.find(o => o !== n && o.length > n.length && n.length >= 12 && o.startsWith(n));
      map[n] = longer ? (map[longer] || longer) : n;
    }
    Object.keys(order).forEach(n => { if (!(n in map)) map[n] = map[order[n]]; });
    return map;
  }

  // Vueltas repetidas por el grabador: mismo tiempo exacto que la anterior y la hora de paso no cuadra con una vuelta entera
  // (llega a mitad de vuelta, o la vuelta siguiente llega demasiado pronto). Sin hora de paso (PDF) no se toca nada.
  function dedupe(t) {
    const L = t.laps || [], ts = t.ts;
    if (!ts || ts.length !== L.length || !ts.every(x => x)) return t;
    const keep = [];
    for (let i = 0; i < L.length; i++) {
      let dup = false;
      if (i > 0 && Math.abs(L[i] - L[i - 1]) < 0.0005) {
        if (ts[i] - ts[i - 1] < 0.85 * L[i]) dup = true;
        else if (i + 1 < L.length && ts[i + 1] - ts[i] < 0.6 * L[i + 1]) dup = true;
      }
      if (!dup) keep.push(i);
    }
    if (keep.length === L.length) return t;
    ['laps', 'ts', 'gaps', 'posv', 'lider', 'pitsv'].forEach(k => { if (Array.isArray(t[k]) && t[k].length === L.length) t[k] = keep.map(i => t[k][i]); });
    t.dups = L.length - keep.length;
    return t;
  }
  function invert(A, n) { // inversa de una matriz simétrica definida positiva (Gauss-Jordan con pivote)
    const M = A.map(r => Float64Array.from(r)), I = Array.from({ length: n }, (_, i) => { const r = new Float64Array(n); r[i] = 1; return r; });
    for (let c = 0; c < n; c++) {
      let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      if (Math.abs(M[p][c]) < 1e-14) M[p][c] = 1e-14;
      if (p !== c) { [M[p], M[c]] = [M[c], M[p]]; [I[p], I[c]] = [I[c], I[p]]; }
      const d = M[c][c], Mc = M[c], Ic = I[c];
      for (let j = 0; j < n; j++) { Mc[j] /= d; Ic[j] /= d; }
      for (let r = 0; r < n; r++) { if (r === c) continue; const f = M[r][c]; if (!f) continue; const Mr = M[r], Ir = I[r]; for (let j = 0; j < n; j++) { Mr[j] -= f * Mc[j]; Ir[j] -= f * Ic[j]; } }
    }
    return I;
  }
  /* Modelo mixto: log(ritmo) = sesión (libre) + piloto + kart + ruido. Piloto y kart son efectos "con freno", y cuánto
     varían de verdad pilotos, karts y el ruido se APRENDE de los datos del circuito (máxima verosimilitud restringida, por EM).
     Todo en proporción de vuelta (log), así vale igual para una pista de 36 s que para una de 107 s.
     Tandas sin nombre de piloto = piloto desconocido: cuentan, pero con el peso que les toca (su ruido incluye lo que varían los pilotos).
     x: [{y, s, d, k, anon}] con índices ya numerados. fixed: {td, tk} (desviaciones en log) si se quieren fijar. prior: por piloto {m, w}. */
  function mixedFit(x, S, D, K, fixed, prior) {
    const n = x.length, m = S + K, T0 = { td: 0.012, tk: 0.005, s: 0.004 }, NU = 2;
    let td = (fixed && fixed.td ? fixed.td : T0.td) ** 2, tk = (fixed && fixed.tk ? fixed.tk : T0.tk) ** 2, s = T0.s ** 2;
    const pm = new Float64Array(D), pw = new Float64Array(D); if (prior) for (let d = 0; d < D; d++) if (prior[d]) { pm[d] = prior[d].m; pw[d] = prior[d].w; }
    // por piloto: en qué sesiones y karts ha estado (siempre con peso 1: los que tienen nombre)
    const bd = Array.from({ length: D }, () => new Map()), nd = new Float64Array(D), ty0 = new Float64Array(D);
    x.forEach(o => { if (o.anon) return; const b = bd[o.d]; b.set(o.s, (b.get(o.s) || 0) + 1); b.set(S + o.k, (b.get(S + o.k) || 0) + 1); nd[o.d]++; ty0[o.d] += o.y; });
    const bdl = bd.map(b => [...b.entries()]);
    let v, Ri, ud = new Float64Array(D), cd = new Float64Array(D), Cdd = new Float64Array(D), it = 0;
    for (; it < 80; it++) {
      const lamD = s / td, lamK = s / tk, wa = s / (s + td);
      const G = Array.from({ length: m }, () => new Float64Array(m)), r = new Float64Array(m);
      for (const o of x) { const w = o.anon ? wa : 1, a = o.s, b = S + o.k; G[a][a] += w; G[b][b] += w; G[a][b] += w; G[b][a] += w; r[a] += w * o.y; r[b] += w * o.y; }
      for (let k = 0; k < K; k++) G[S + k][S + k] += lamK;
      const td_ = new Float64Array(D);
      for (let d = 0; d < D; d++) {
        const lam = lamD + pw[d]; cd[d] = nd[d] + lam; td_[d] = ty0[d] + lam * pm[d];
        const b = bdl[d], f = 1 / cd[d];
        for (const [i, vi] of b) { r[i] -= vi * td_[d] * f; const Gi = G[i]; for (const [j, vj] of b) Gi[j] -= vi * vj * f; }
      }
      Ri = invert(G, m);
      v = new Float64Array(m); for (let i = 0; i < m; i++) { let a = 0; const Rr = Ri[i]; for (let j = 0; j < m; j++) a += Rr[j] * r[j]; v[i] = a; }
      let sd2 = 0, trD = 0, peff = S;
      for (let d = 0; d < D; d++) {
        const b = bdl[d]; let bv = 0, q = 0;
        for (const [i, vi] of b) { bv += vi * v[i]; const Rr = Ri[i]; for (const [j, vj] of b) q += vi * vj * Rr[j]; }
        ud[d] = (td_[d] - bv) / cd[d]; Cdd[d] = 1 / cd[d] + q / (cd[d] * cd[d]);
        sd2 += (ud[d] - pm[d]) ** 2; trD += Cdd[d]; peff += 1 - (lamD + pw[d]) * Cdd[d];
      }
      let sk2 = 0, trK = 0; for (let k = 0; k < K; k++) { sk2 += v[S + k] ** 2; trK += Ri[S + k][S + k]; peff += 1 - lamK * Ri[S + k][S + k]; }
      let sse = 0; for (const o of x) { const e = o.y - v[o.s] - v[S + o.k] - (o.anon ? 0 : ud[o.d]); sse += (o.anon ? wa : 1) * e * e; }
      const td2 = fixed && fixed.td ? td : (sd2 + s * trD + NU * T0.td ** 2) / (D + NU);
      const tk2 = fixed && fixed.tk ? tk : (sk2 + s * trK + NU * T0.tk ** 2) / (K + NU);
      const s2 = Math.max(1e-9, (sse + s * peff + NU * T0.s ** 2) / (n + NU));
      const ch = Math.abs(Math.log(td2 / td)) + Math.abs(Math.log(tk2 / tk)) + Math.abs(Math.log(s2 / s));
      td = td2; tk = tk2; s = s2;
      if (ch < 2e-4) break;
    }
    // probabilidad de estar entre los N mejores / peores: se sortean rankings posibles con el margen de error real de cada kart
    const topN = K >= 12 ? 5 : Math.max(1, Math.round(K / 3));
    const cov = Array.from({ length: K }, (_, i) => Float64Array.from({ length: K }, (_, j) => s * Ri[S + i][S + j]));
    const Lc = Array.from({ length: K }, () => new Float64Array(K));
    for (let i = 0; i < K; i++) for (let j = 0; j <= i; j++) { let a = cov[i][j]; for (let q = 0; q < j; q++) a -= Lc[i][q] * Lc[j][q]; Lc[i][j] = i === j ? Math.sqrt(Math.max(a, 1e-14)) : a / Lc[j][j]; }
    let seed = 20261125; const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    const pTop = new Float64Array(K), pBot = new Float64Array(K), DR = K > 1 ? 1500 : 0, z = new Float64Array(K), g = new Float64Array(K), ord = Array.from({ length: K }, (_, i) => i);
    for (let t = 0; t < DR; t++) {
      for (let i = 0; i < K; i += 2) { const u1 = Math.max(rnd(), 1e-12), u2 = rnd(), R = Math.sqrt(-2 * Math.log(u1)); z[i] = R * Math.cos(6.283185307179586 * u2); if (i + 1 < K) z[i + 1] = R * Math.sin(6.283185307179586 * u2); }
      for (let i = 0; i < K; i++) { let a = v[S + i]; const Li = Lc[i]; for (let j = 0; j <= i; j++) a += Li[j] * z[j]; g[i] = a; }
      ord.sort((a, b) => g[a] - g[b]);
      for (let i = 0; i < topN && i < K; i++) { pTop[ord[i]]++; pBot[ord[K - 1 - i]]++; }
    }
    for (let k = 0; k < K; k++) { pTop[k] /= DR || 1; pBot[k] /= DR || 1; }
    return { ses: v.slice(0, S), uk: v.slice(S), ud, kSd: Float64Array.from({ length: K }, (_, k) => Math.sqrt(Math.max(0, s * Ri[S + k][S + k]))), dSd: Cdd.map(c => Math.sqrt(Math.max(0, s * c))),
      td: Math.sqrt(td), tk: Math.sqrt(tk), s: Math.sqrt(s), pTop, pBot, topN, it };
  }

  /* opts: {dropFirst:bool, cutPct:number(ej 3), pace:'top3'|'top5'|'median'|'best', method:'raw'|'driver'|'model', minLaps}
     Devuelve {karts, drivers, stints, sessions} */
  function analyze(sessions, opts) {
    opts = Object.assign({ dropFirst: true, cutPct: 3, pace: 'top3', method: 'model', minLaps: 4, noTraffic: false, trafficGap: 0.5 }, opts || {});
    const clean = d => String(d || '').replace(/^\d{1,3}\s*-\s*/, '').replace(/\s*\[\d{1,2}:\d{2}(?::\d{2})?\]\s*$/, '').trim().toUpperCase().replace(/[ÁÀÂÄ]/g, 'A').replace(/[ÉÈÊË]/g, 'E').replace(/[ÍÌÎÏ]/g, 'I').replace(/[ÓÒÔÖ]/g, 'O').replace(/[ÚÙÛÜ]/g, 'U').replace(/\s+/g, ' ');
    sessions.forEach(s => s.stints.forEach(t => { t.driver = clean(t.driver); dedupe(t); }));
    const nm = nameMap(sessions.flatMap(s => s.stints.map(t => t.driver)));
    const stints = [];
    for (const s of sessions) {
      const cv = opts.evo === false ? null : trackCurve(s);
      s._evo = cv; // para mostrarlo
      for (const t of s.stints) {
        // sin número de kart (Apex lo mostraba en blanco) no se sabe qué kart era: fuera, para no inventar un "kart 0"
        if (!String(t.kart ?? '').trim() || !(+t.kart > 0)) continue;
        const start = opts.dropFirst ? 1 : 0;
        const ts = cv && cv.apply ? tsOf(t) : null;
        const corr = ts ? t.laps.map((x, i) => x / cv.at(ts[i])) : t.laps;
        let laps = corr.slice(start);
        if (opts.noTraffic && t.gaps) laps = laps.filter((x, i) => { const g = t.gaps[i + start]; return g == null || g >= opts.trafficGap; });
        if (!laps.length) continue;
        const best = Math.min(...t.laps), cbest = Math.min(...corr);
        const clean = laps.filter(x => x <= cbest * (1 + opts.cutPct / 100));
        if (clean.length < opts.minLaps) continue;
        const sorted = [...clean].sort((a, b) => a - b);
        const pace = opts.pace === 'best' ? sorted[0] : opts.pace === 'median' ? median(sorted) : mean(sorted.slice(0, opts.pace === 'top5' ? 5 : 3));
        stints.push({ session: s.id, sessionLabel: `${s.date.slice(8, 10)}/${s.date.slice(5, 7)} ${s.time} ${s.group} ${s.type}`,
          date: s.date, kart: t.kart, driver: nm[t.driver], pace, best, top5: mean(sorted.slice(0, 5)), top3: mean(sorted.slice(0, 3)),
          clean: clean.length, total: t.laps.length + 1, pos: t.pos, b3: bestN(t.laps, 3), b5: bestN(t.laps, 5) });
      }
    }
    // referencia por sesión = mediana de ritmos de esa sesión
    const bySes = {};
    stints.forEach(t => (bySes[t.session] = bySes[t.session] || []).push(t.pace));
    let ref = {}; for (const k in bySes) ref[k] = median(bySes[k]);
    // opcional: fuera las tandas que están muy lejos de la mediana de su sesión (otra categoría de kart en la misma tanda, incidencias…)
    if (opts.maxDeltaPct) {
      for (let i = stints.length - 1; i >= 0; i--) { const t = stints[i]; if (Math.abs(t.pace / ref[t.session] - 1) * 100 > opts.maxDeltaPct) stints.splice(i, 1); }
      for (const k in bySes) delete bySes[k];
      stints.forEach(t => (bySes[t.session] = bySes[t.session] || []).push(t.pace));
      ref = {}; for (const k in bySes) ref[k] = median(bySes[k]);
    }
    const refLap = median(stints.map(t => t.pace));
    stints.forEach(t => { t.delta = t.pace - ref[t.session]; });

    const K = {}, D = {};
    // sin nombre de piloto (vacío o "KART 12") no se sabe quién conducía: se supone un piloto medio y la diferencia es del kart
    const anon = d => !d || /^KART\s*\d+$/i.test(d);
    stints.forEach(t => { (K[t.kart] = K[t.kart] || []).push(t); (D[t.driver] = D[t.driver] || []).push(t); });
    let kEff = {}, dEff = {}, sEff = {}, sigma = 0.3, result_prior = {}, model = null; const kSe = {}, dSe = {}, kP = {};
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
      // modelo completo (ver mixedFit): ritmo = sesión + piloto + kart + ruido, en proporción de vuelta, con las dispersiones
      // de pilotos, karts y ruido aprendidas de los datos de esta selección. opts.tauDriver / opts.tauKart (en segundos) las fijan a mano.
      const sIdx = {}, dIdx = {}, kIdx = {}, sN = [], dN = [], kN = [];
      const ix = (m, l, v) => { if (!(v in m)) { m[v] = l.length; l.push(v); } return m[v]; };
      const x = stints.map(t => { const an = anon(t.driver); return { y: Math.log(t.pace), s: ix(sIdx, sN, t.session), d: an ? -1 : ix(dIdx, dN, t.driver), k: ix(kIdx, kN, String(t.kart)), anon: an }; });
      // score general de pilotos (opcional): su nivel en % de vuelta, sacado de TODO lo grabado, cuenta como 0,5 tandas
      // por cada tanda suya fuera de esta selección (máx. 5)
      const prior = {}; let pr = null;
      if (opts.priorPct) dN.forEach((d, i) => { const g = opts.priorPct[d]; if (!g) return; const w = 0.5 * Math.min(10, Math.max(0, g.n - D[d].length)); if (w > 0) { prior[d] = { s: g.pct / 100 * refLap, w }; (pr = pr || {})[i] = { m: g.pct / 100, w }; } });
      result_prior = prior;
      const fixed = (opts.tauDriver || opts.tauKart) ? { td: opts.tauDriver ? opts.tauDriver / refLap : 0, tk: opts.tauKart ? opts.tauKart / refLap : 0 } : null;
      const F = mixedFit(x, sN.length, dN.length, kN.length, fixed, pr);
      const mk = mean(Array.from(F.uk));
      kN.forEach((k, i) => { kEff[k] = (F.uk[i] - mk) * refLap; kSe[k] = F.kSd[i] * refLap; kP[k] = [F.pTop[i], F.pBot[i]]; });
      for (const d in D) { dEff[d] = 0; dSe[d] = F.td * refLap; }
      dN.forEach((d, i) => { dEff[d] = F.ud[i] * refLap; dSe[d] = F.dSd[i] * refLap; });
      sN.forEach((q, i) => { sEff[q] = Math.exp(F.ses[i] + mk) - ref[q]; });
      // ritmo frente al nivel real de su sesión (el del modelo: descuenta peso de la categoría, estado de la pista y nivel del grupo)
      stints.forEach(t => { t.adj = t.delta - sEff[t.session]; });
      sigma = F.s * refLap; model = { tauK: F.tk * refLap, tauD: F.td * refLap, topN: F.topN, pct: { kart: F.tk * 100, driver: F.td * 100, noise: F.s * 100 } };
    }
    if (opts.method !== 'model') {
      const all = stints.map(t => t.delta - kEff[t.kart]).filter(x => !isNaN(x));
      sigma = Math.sqrt(mean(all.map(x => x * x))) || 0.3;
    }

    const karts = Object.keys(K).map(k => {
      const v = K[k], n = opts.method === 'driver' ? (v.relN || 0) : v.length;
      const se = opts.method === 'model' ? kSe[k] : 1.15 * sigma / Math.sqrt(Math.max(n, 0.5));
      // fiabilidad real (0–1): cuánto de lo que se ve es kart y cuánto es margen de error
      const rel = opts.method === 'model' && model ? Math.max(0, Math.min(1, 1 - (se * se) / (model.tauK * model.tauK))) : null;
      const drivers = new Set(v.map(t => t.driver)).size;
      return { kart: +k, effect: kEff[k], se, rel, pTop: kP[k] ? kP[k][0] : null, pBot: kP[k] ? kP[k][1] : null, n: v.length, drivers, best: Math.min(...v.map(t => t.best)), b3: minN(v.map(t => t.b3)), b5: minN(v.map(t => t.b5)),
        top5raw: mean(v.map(t => t.top5)), luckyDrivers: [...new Set(v.map(t => t.driver))], stints: v };
    }).filter(k => !isNaN(k.effect)).sort((a, b) => a.effect - b.effect);

    const drivers = Object.keys(D).map(d => {
      const v = D[d];
      const kartLuck = mean(v.map(t => kEff[t.kart] || 0));
      return { driver: d, skill: dEff[d], n: v.length, karts: [...new Set(v.map(t => t.kart))],
        best: Math.min(...v.map(t => t.best)), b3: minN(v.map(t => t.b3)), b5: minN(v.map(t => t.b5)), kartLuck, avgPos: (p => p.length ? mean(p) : null)(v.map(t => t.pos).filter(q => q != null && q > 0)), se: opts.method === 'model' && dSe[d] != null ? dSe[d] : sigma / Math.sqrt(v.length), usedPrior: !!result_prior[d], stints: v };
    }).sort((a, b) => a.skill - b.skill);
    return { karts, drivers, stints, sigma, opts, refLap, model, priorUsed: Object.keys(result_prior).length };
  }

  root.KartCore = { linesFromItems, parseResumen, parsePdf, mergePdfSessions, detectCircuit, cleanScan, ocrToItems, analyze, dedupe, mixedFit, tsec, median, mean, bestN, trackCurve, tsOf, normName: d => String(d || '').replace(/^\d{1,3}\s*-\s*/, '').replace(/\s*\[\d{1,2}:\d{2}(?::\d{2})?\]\s*$/, '').trim().toUpperCase().replace(/[ÁÀÂÄ]/g, 'A').replace(/[ÉÈÊË]/g, 'E').replace(/[ÍÌÎÏ]/g, 'I').replace(/[ÓÒÔÖ]/g, 'O').replace(/[ÚÙÛÜ]/g, 'U').replace(/\s+/g, ' ') };
})(typeof window !== 'undefined' ? window : globalThis);
