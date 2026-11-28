# App de iPhone / Mac (en pruebas)

Esta carpeta es la "carcasa": mete la web de `docs/` dentro de una app y le da Bluetooth propio
(RaceBox / Dragy sin Bluefy). **No cambia nada de la web publicada**: `docs/` solo se lee.

- `bt-nativo.js` — puente de Bluetooth. Dentro de la app ofrece el mismo `navigator.bluetooth` que usa
  `racebox.js`; en un navegador normal no hace nada.
- `preparar.js` — copia `docs/` dentro de la app (`ios/App/App/public`) y añade el puente a cada página.
  Hay que volver a pasarlo (`node preparar.js`) cuando cambie la web y se quiera llevar a la app.
- `ios/` — proyecto de Xcode. El plugin de Bluetooth va copiado en `ios/plugins/` para no tener que
  instalar nada más en el Mac.

## Instalar en el iPhone (gratis, con cable)

1. Abrir `app/ios/App/App.xcodeproj` con Xcode.
2. Xcode → Settings → Accounts → añadir tu cuenta de Apple.
3. En el proyecto: App → Signing & Capabilities → Team: tu nombre (Personal Team).
4. Enchufar el iPhone, elegirlo arriba y pulsar ▶.
5. En el iPhone: Ajustes → Privacidad y seguridad → Modo de desarrollador (activar) y
   Ajustes → General → VPN y gestión de dispositivos → confiar en tu cuenta.

Con cuenta gratuita la app caduca a los 7 días: se vuelve a pulsar ▶.

## Sin probar todavía
- Compilación en Xcode y conexión con un RaceBox real (el puente está probado con un iPhone y un RaceBox simulados).
