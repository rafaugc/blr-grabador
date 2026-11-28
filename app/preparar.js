/* Copia la web (../docs) dentro de la app (www) y le añade el puente de Bluetooth.
   La web publicada (docs/) no se toca: aquí solo se lee. */
const fs = require('fs'), path = require('path');
const SRC = path.join(__dirname, '..', 'docs'), DST = path.join(__dirname, 'www'), PUENTE = 'bt-nativo.js';
fs.rmSync(DST, { recursive: true, force: true });
fs.cpSync(SRC, DST, { recursive: true });
fs.copyFileSync(path.join(__dirname, PUENTE), path.join(DST, PUENTE));
const ver = Date.now().toString(36);
let n = 0;
for (const f of fs.readdirSync(DST)) {
  if (!f.endsWith('.html')) continue;
  const p = path.join(DST, f); let t = fs.readFileSync(p, 'utf8');
  const tag = '<script src="' + PUENTE + '?v=' + ver + '"></script>';
  // justo antes del primer <script>, para que el puente exista cuando cargue racebox.js
  const i = t.search(/<script[\s>]/i);
  t = i >= 0 ? t.slice(0, i) + tag + '\n' + t.slice(i) : t.replace(/<\/head>/i, tag + '</head>');
  fs.writeFileSync(p, t); n++;
}
console.log('Web copiada a www · puente Bluetooth añadido a ' + n + ' páginas');
// La app lleva la web dentro: se copia a la carpeta del proyecto de Xcode (así en el Mac no hay que instalar nada más).
const PUB = path.join(__dirname, 'ios', 'App', 'App', 'public');
if (fs.existsSync(path.join(__dirname, 'ios', 'App', 'App'))) {
  fs.rmSync(PUB, { recursive: true, force: true });
  fs.cpSync(DST, PUB, { recursive: true });
  console.log('Web copiada dentro de la app (ios/App/App/public)');
}
