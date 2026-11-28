/* Copia la web (../docs) dentro de la app (www) y le añade el puente de Bluetooth.
   La web publicada (docs/) no se toca: aquí solo se lee. */
const fs = require('fs'), path = require('path');
const SRC = path.join(__dirname, '..', 'docs'), DST = path.join(__dirname, 'www'), EXTRAS = ['bt-nativo.js', 'ajustes-app.js'];
fs.rmSync(DST, { recursive: true, force: true });
fs.cpSync(SRC, DST, { recursive: true });
for (const e of EXTRAS) fs.copyFileSync(path.join(__dirname, e), path.join(DST, e));
const ver = Date.now().toString(36);
let n = 0;
for (const f of fs.readdirSync(DST)) {
  if (!f.endsWith('.html')) continue;
  const p = path.join(DST, f); let t = fs.readFileSync(p, 'utf8');
  const tag = EXTRAS.map(e => '<script src="' + e + '?v=' + ver + '"></script>').join('');
  // justo antes del primer <script>, para que el puente exista cuando cargue racebox.js
  const i = t.search(/<script[\s>]/i);
  t = i >= 0 ? t.slice(0, i) + tag + '\n' + t.slice(i) : t.replace(/<\/head>/i, tag + '</head>');
  fs.writeFileSync(p, t); n++;
}
console.log('Web copiada a www · puente Bluetooth y ajustes de la app añadidos a ' + n + ' páginas');
// La app lleva la web dentro: se copia a la carpeta del proyecto de Xcode (así en el Mac no hay que instalar nada más).
const PUB = path.join(__dirname, 'ios', 'App', 'App', 'public');
if (fs.existsSync(path.join(__dirname, 'ios', 'App', 'App'))) {
  fs.rmSync(PUB, { recursive: true, force: true });
  fs.cpSync(DST, PUB, { recursive: true });
  console.log('Web copiada dentro de la app (ios/App/App/public)');
}
