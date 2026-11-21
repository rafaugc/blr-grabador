# blr · grabador

Graba automáticamente los tiempos en directo de los circuitos que usan **Apex Timing**.

## Qué hace, sin tecnicismos
- **Grabar circuitos**: siempre hay un ordenador gratuito de GitHub escuchando el live timing de los circuitos activados. Solo guarda cuando hay vueltas. Cada sesión terminada se sube en un par de minutos a `data/sesiones/`.
- Los turnos duran casi 6 horas y se relevan solapándose ~50 minutos, así que una sesión que cae en el cambio de turno no se corta: se une sola.
- **Descubrir circuitos**: cada sábado busca qué circuitos emiten en Apex y deja la lista en `data/circuitos_detectados.json`.
- Todo lo recibido se guarda además "en bruto" 30 días, por si hay que volver a procesarlo.

## Circuitos
La lista está en `circuitos.json`. Se actualiza sola desde la app (circuitos favoritos).

## Grabar a mano
Pestaña **Actions** → **Grabar circuitos** → **Run workflow**. Marca "Grabar aunque ya haya otro" si quieres forzarlo.
