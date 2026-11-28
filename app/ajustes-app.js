/* Arreglos que solo hacen falta dentro de la app de iPhone / Mac. En un navegador normal no hace nada.
   1) Al salir de la vista piloto (pantalla fija, a veces girada) la página podía quedarse descolocada y sin
      responder a los toques: el visor de la app no recolocaba la página. Aquí se recoloca a mano. */
(function () {
  'use strict';
  var cap = window.Capacitor;
  if (!cap || !cap.isNativePlatform || !cap.isNativePlatform()) return;
  var orig = null, vuelve = 0, FIJO = 'width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, viewport-fit=cover';
  var recolocar = function () {
    try {
      var h = document.documentElement, b = document.body, m = document.querySelector('meta[name=viewport]');
      b.classList.remove('prot'); b.classList.remove('plock');
      window.scrollTo(0, 0); h.scrollTop = 0; h.scrollLeft = 0; b.scrollTop = 0; b.scrollLeft = 0;
      // obliga al visor a recalcular tamaño, zoom y zona táctil
      if (m) { if (orig == null) orig = m.getAttribute('content'); m.setAttribute('content', FIJO); clearTimeout(vuelve); vuelve = setTimeout(function () { m.setAttribute('content', orig); orig = null; }, 350); }
      var d = b.style.display; b.style.display = 'none'; void b.offsetHeight; b.style.display = d;
      window.dispatchEvent(new Event('resize'));
    } catch (e) {}
  };
  var vigilar = function () {
    var b = document.body, era = b.classList.contains('pilot');
    new MutationObserver(function () {
      var es = b.classList.contains('pilot');
      if (era && !es) [0, 120, 500].forEach(function (t) { setTimeout(recolocar, t); });
      era = es;
    }).observe(b, { attributes: true, attributeFilter: ['class'] });
  };
  if (document.body) vigilar(); else document.addEventListener('DOMContentLoaded', vigilar);
  window.__krRecolocar = recolocar;
})();
