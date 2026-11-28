/* Puente de Bluetooth para la app de iPhone / Mac.
   La web usa "Web Bluetooth" (navigator.bluetooth), que en iPhone solo existe dentro de Bluefy.
   Dentro de la app este archivo ofrece ese mismo navigator.bluetooth, pero hablando con el Bluetooth
   del propio iPhone. Así racebox.js funciona tal cual, sin cambiar una línea.
   En un navegador normal (Safari, Chrome, Bluefy) este archivo no hace nada. */
(function () {
  'use strict';
  var cap = window.Capacitor;
  if (!cap || !cap.isNativePlatform || !cap.isNativePlatform() || !cap.nativePromise) return;
  if (navigator.bluetooth && navigator.bluetooth.requestDevice) return;

  var P = 'BluetoothLe', NUS = '6e400001-b5a3-f393-e0a9-e50e24dcca9e', BASE = '-0000-1000-8000-00805f9b34fb';
  var call = function (m, o) { return cap.nativePromise(P, m, o || {}); };
  // 0xffe0 → "0000ffe0-0000-1000-8000-00805f9b34fb"; texto → minúsculas
  var full = function (u) {
    if (typeof u === 'number') return ('00000000' + u.toString(16)).slice(-8) + BASE;
    u = String(u).toLowerCase();
    if (u.length === 4) return '0000' + u + BASE;
    if (u.length === 8) return u + BASE;
    return u;
  };
  // forma corta que usa iOS por dentro para los servicios estándar ("ffe0")
  var corto = function (u) { u = full(u); return u.slice(8) === BASE ? (u.slice(0, 4) === '0000' ? u.slice(4, 8) : u.slice(0, 8)) : u; };
  var hexToView = function (h) {
    h = h || ''; var n = h.length >> 1, b = new Uint8Array(n);
    for (var i = 0; i < n; i++) b[i] = parseInt(h.substr(i * 2, 2), 16);
    return new DataView(b.buffer);
  };
  var viewToHex = function (v) {
    var u = v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength), s = '';
    for (var i = 0; i < u.length; i++) s += (u[i] < 16 ? '0' : '') + u[i].toString(16);
    return s;
  };
  var fallo = function (name, msg) { var e = new Error(msg); e.name = name; return e; };

  var listo = null;
  var init = function () { return listo || (listo = call('initialize').catch(function (e) { listo = null; throw e; })); };

  // ---------- objetos que espera la web ----------
  function Canal(dev, svc, c) {
    var t = new EventTarget();
    t.uuid = full(c.uuid); t.service = svc; t.properties = c.properties || {}; t.value = null;
    t.startNotifications = function () {
      var visto = {}, claves = [[full(svc.uuid), t.uuid], [corto(svc.uuid), corto(t.uuid)], [corto(svc.uuid), t.uuid], [full(svc.uuid), corto(t.uuid)]];
      claves.forEach(function (k) {
        var key = 'notification|' + dev.id + '|' + k[0] + '|' + k[1];
        if (visto[key]) return; visto[key] = 1;
        dev._oyentes.push(cap.addListener(P, key, function (ev) {
          t.value = hexToView(ev && ev.value);
          t.dispatchEvent(new Event('characteristicvaluechanged'));
        }));
      });
      return call('startNotifications', { deviceId: dev.id, service: full(svc.uuid), characteristic: t.uuid }).then(function () { return t; });
    };
    t.stopNotifications = function () { return call('stopNotifications', { deviceId: dev.id, service: full(svc.uuid), characteristic: t.uuid }).then(function () { return t; }); };
    t.writeValue = t.writeValueWithResponse = function (v) { return call('write', { deviceId: dev.id, service: full(svc.uuid), characteristic: t.uuid, value: viewToHex(v) }); };
    t.writeValueWithoutResponse = function (v) { return call('writeWithoutResponse', { deviceId: dev.id, service: full(svc.uuid), characteristic: t.uuid, value: viewToHex(v) }); };
    t.readValue = function () { return call('read', { deviceId: dev.id, service: full(svc.uuid), characteristic: t.uuid }).then(function (r) { t.value = hexToView(r && r.value); return t.value; }); };
    return t;
  }
  function Servicio(dev, s) {
    var svc = { uuid: full(s.uuid), device: dev, isPrimary: true };
    var canales = (s.characteristics || []).map(function (c) { return Canal(dev, svc, c); });
    svc.getCharacteristics = function () { return Promise.resolve(canales.slice()); };
    svc.getCharacteristic = function (u) {
      u = full(u); var c = canales.filter(function (x) { return x.uuid === u; })[0];
      return c ? Promise.resolve(c) : Promise.reject(fallo('NotFoundError', 'El aparato no tiene ese canal'));
    };
    return svc;
  }
  function Aparato(id, name) {
    var dev = new EventTarget();
    dev.id = id; dev.name = name || ''; dev._oyentes = []; dev._corte = null;
    var limpiar = function () { dev._oyentes.forEach(function (h) { try { h.remove(); } catch (e) {} }); dev._oyentes = []; };
    var gatt = { device: dev, connected: false, _svcs: [] };
    gatt.connect = function () {
      limpiar();
      if (!dev._corte) dev._corte = cap.addListener(P, 'disconnected|' + id, function () {
        if (!gatt.connected) return;
        gatt.connected = false; limpiar();
        dev.dispatchEvent(new Event('gattserverdisconnected'));
      });
      return init().then(function () { return call('connect', { deviceId: id, timeout: 12000 }); })
        .then(function () { return call('getServices', { deviceId: id }); })
        .then(function (r) {
          gatt._svcs = ((r && r.services) || []).map(function (s) { return Servicio(dev, s); });
          gatt.connected = true; return gatt;
        });
    };
    gatt.disconnect = function () { call('disconnect', { deviceId: id }).catch(function () {}); };
    gatt.getPrimaryServices = function () { return Promise.resolve(gatt._svcs.slice()); };
    gatt.getPrimaryService = function (u) {
      u = full(u); var s = gatt._svcs.filter(function (x) { return x.uuid === u; })[0];
      return s ? Promise.resolve(s) : Promise.reject(fallo('NotFoundError', 'El aparato no ofrece ese servicio'));
    };
    dev.gatt = gatt;
    return dev;
  }

  // ---------- ventana para elegir aparato ----------
  function elegir(prefijos, todos) {
    return new Promise(function (resolve, reject) {
      var vistos = {}, fin = false, oyente = null;
      var caja = document.createElement('div');
      caja.setAttribute('style', 'position:fixed;inset:0;z-index:2147483647;background:rgba(4,8,16,.86);display:flex;align-items:center;justify-content:center;padding:18px;font-family:-apple-system,system-ui,sans-serif');
      caja.innerHTML = '<div style="background:#111a2c;color:#e9ebf0;border:1px solid #2b3a57;border-radius:16px;max-width:460px;width:100%;max-height:80vh;display:flex;flex-direction:column;overflow:hidden">'
        + '<div style="padding:16px 18px 6px;font-size:19px;font-weight:700">🛰 Elige tu GPS</div>'
        + '<div data-k="estado" style="padding:0 18px 10px;font-size:14px;opacity:.75">Buscando aparatos cerca…</div>'
        + '<div data-k="lista" style="overflow:auto;padding:0 12px 6px"></div>'
        + '<button data-k="no" style="margin:8px 12px 14px;padding:14px;font-size:17px;border-radius:12px;border:1px solid #2b3a57;background:transparent;color:#e9ebf0">Cancelar</button></div>';
      var q = function (k) { return caja.querySelector('[data-k=' + k + ']'); };
      var cerrar = function () {
        if (fin) return false; fin = true;
        call('stopLEScan').catch(function () {});
        try { oyente && oyente.remove(); } catch (e) {}
        caja.remove(); return true;
      };
      var vale = function (n) { return todos ? !!n : !!n && prefijos.some(function (p) { return n.indexOf(p) === 0; }); };
      var poner = function (id, name, nota) {
        if (fin || !id || vistos[id] || !vale(name)) return; vistos[id] = 1;
        var b = document.createElement('button');
        b.setAttribute('style', 'display:block;width:100%;text-align:left;margin:0 0 8px;padding:16px 14px;font-size:18px;font-weight:600;border-radius:12px;border:1px solid #3a4d73;background:#182540;color:#e9ebf0');
        b.textContent = name + (nota ? ' · ' + nota : '');
        b.onclick = function () { if (cerrar()) resolve(Aparato(id, name)); };
        q('lista').appendChild(b);
        q('estado').textContent = 'Toca el tuyo para conectar';
      };
      q('no').onclick = function () { if (cerrar()) reject(fallo('NotFoundError', 'Búsqueda cancelada')); };
      document.body.appendChild(caja);
      init().then(function () {
        if (fin) return;
        // los que ya están enlazados con otra app del iPhone (p. ej. RaceChrono) no se anuncian: se piden aparte
        call('getConnectedDevices', { services: [NUS] }).then(function (r) {
          ((r && r.devices) || []).forEach(function (d) { poner(d.deviceId, d.name, 'ya enlazado'); });
        }).catch(function () {});
        oyente = cap.addListener(P, 'onScanResult', function (ev) {
          var d = (ev && ev.device) || {}; poner(d.deviceId, d.name || ev.localName);
        });
        return call('requestLEScan', { allowDuplicates: false });
      }).then(function () {
        setTimeout(function () { if (!fin && !Object.keys(vistos).length) q('estado').textContent = 'Aún no aparece ninguno. Comprueba que está encendido y cerca.'; }, 8000);
      }).catch(function (e) {
        if (cerrar()) reject(fallo('NotFoundError', 'Bluetooth no disponible: actívalo y da permiso a la app en Ajustes' + (e && e.message ? ' (' + e.message + ')' : '')));
      });
    });
  }

  var bt = {
    requestDevice: function (req) {
      req = req || {};
      var pref = (req.filters || []).map(function (f) { return f.namePrefix || f.name; }).filter(Boolean);
      return elegir(pref, !!req.acceptAllDevices || !pref.length);
    },
    getAvailability: function () { return Promise.resolve(true); },
    _nativo: true
  };
  try { Object.defineProperty(navigator, 'bluetooth', { value: bt, configurable: true }); } catch (e) { try { navigator.bluetooth = bt; } catch (e2) {} }
})();
