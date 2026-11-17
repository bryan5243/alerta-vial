# AlertaVial — Documento de diseño

**Qué es:** un sistema web para que una ciudad informe en tiempo real qué calles están inundadas,
qué vías alternas usar y qué recomendaciones seguir, con un panel administrativo donde el equipo
municipal coloca los puntos críticos sobre el mapa y activa las alertas (a mano o según la lluvia).

Ciudad: **Santa Rosa, provincia de El Oro** (centro 3°27'34.57"S 79°57'57.04"W = -3.459603, -79.965844). Las calles y puntos incluidos son de ejemplo, ubicados alrededor de ese centro: reemplázalos desde el panel con las calles reales.

---

## 1. Idea / prompt original del sistema

> Sistema del clima que maneje las calles sobre un mapa: si hay calles inundadas, que muestre
> cuáles son y las vías alternas. Parte administrativa para activar alertas manualmente o según el
> clima, donde nosotros colocamos los puntos críticos, las vías alternas y las recomendaciones.
> Fuentes útiles: Google Flood Forecasting (ríos), Open-Meteo (clima), RainViewer (radar) y
> reportes de la comunidad.

## 2. Arquitectura

```
┌──────────────────────── Navegador ────────────────────────┐
│  /            Mapa público (index.html + app.js)          │
│  /admin       Panel administrativo (admin.html + admin.js)│
│  map-provider.js  ← capa que abstrae Leaflet / Google Maps│
└───────────────────────────┬───────────────────────────────┘
                            │ JSON (fetch)
┌───────────────────────────▼───────────────────────────────┐
│  Node.js + Express (server/index.js)                      │
│   ├─ /api/public/*   estado, reportes, radar              │
│   ├─ /api/admin/*    CRUD + alerta + config (con token)   │
│   ├─ weather.js      Open-Meteo → nivel sugerido          │
│   ├─ flood.js        Google Flood Forecasting (opcional)  │
│   └─ db.js           base de datos JSON (data/db.json)    │
└───────────────────────────┬───────────────────────────────┘
                            │ HTTPS
        Open-Meteo · RainViewer · Google Flood Forecasting · (Google Maps)
```

**Decisiones clave**

| Decisión | Por qué |
|---|---|
| Node + Express, sin framework de frontend | Un solo `npm start`, sin build, fácil de entender y modificar. |
| Base de datos en archivo JSON | Cero dependencias nativas. `db.js` expone `load/save`; cambiar a SQLite o Postgres es reemplazar ese archivo. |
| Leaflet + OpenStreetMap por defecto | Funciona sin API key. Google Maps se activa escribiendo la key en Configuración. |
| Capa `map-provider.js` | Ambos proveedores exponen la misma interfaz (`addMarker`, `addPolyline`, `onClick`, `setRadar`…). El resto de la app no sabe cuál se usa. |
| Nivel de alerta "efectivo" calculado en el servidor | Un único lugar decide: en modo **manual** vale lo que fijó el admin; en modo **auto** vale lo que sugiere la lluvia. |
| Reportes ciudadanos en cola de revisión | Nada enviado por el público se publica sin que un admin lo verifique. |

## 3. Modelo de datos (`data/db.json`)

| Colección | Campos | Notas |
|---|---|---|
| `config` | `city, center{lat,lng}, zoom, mapProvider, googleMapsKey, googleFloodKey, weather{lat,lng,rainThresholdMm,rainThresholdMm3h}` | Editable desde Admin → Configuración |
| `alert` | `level (normal/amarilla/naranja/roja), mode (manual/auto), message, updatedAt` | Banda superior del mapa público |
| `points` | `name, lat, lng, type (inundacion/riesgo/alcantarilla), severity (alta/media/baja), description, active` | Puntos críticos |
| `streets` | `name, coords[[lat,lng]…], status (inundada/parcial/despejada), depthCm, note, active` | Segmentos dibujados |
| `routes` | `name, coords, from, to, avoids (id de calle), description, active` | Vías alternas |
| `recommendations` | `text, level, active` | Se muestran con etiqueta de nivel |
| `layers` | `name, color, kind, source, geojson (FeatureCollection), active` | Capas subidas |
| `rivers` | `name, coords, status (normal/crecido/desbordado), note, active` | Ríos y canales |
| `zones` | `name, coords (polígono), severity, riverId, depthCm, note, active` | Zonas de desborde |
| `reports` | `lat, lng, street, level (leve/moderado/grave), description, status (pendiente/verificado/descartado), createdAt` | Reportes de la comunidad |

`active: false` oculta el elemento del público sin borrarlo (botón "Desactivar" en el panel).

## 4. Lógica de alerta automática por clima

Cada 10 minutos (con caché) el servidor consulta Open-Meteo para las coordenadas configuradas:
lluvia actual (mm/h), acumulado de las últimas 3 h y pronóstico de las próximas 3 h.

| Condición (umbral T = `rainThresholdMm`, T3 = `rainThresholdMm3h`) | Nivel sugerido |
|---|---|
| lluvia ahora ≥ 3·T **o** acumulado 3 h ≥ 2·T3 | **roja** |
| lluvia ahora ≥ T **o** acumulado 3 h ≥ T3 | **naranja** |
| pronóstico 3 h ≥ T **o** lluvia ahora ≥ T/2 | **amarilla** |
| en otro caso | normal |

Valores por defecto: T = 5 mm/h, T3 = 15 mm. Se ajustan desde el panel.
En **modo manual** el admin fija el nivel y el clima solo se muestra como referencia.
Si Open-Meteo no responde, el modo auto queda en "normal" y el panel lo avisa.

## 5. API

Pública (sin autenticación):

| Método | Ruta | Devuelve |
|---|---|---|
| GET | `/api/public/state` | config, alerta efectiva, clima, ríos, puntos/calles/rutas/recomendaciones activos |
| GET | `/api/public/reports` | reportes verificados |
| POST | `/api/public/reports` | crea un reporte (`lat, lng, street, level, description`), máx. 5 cada 10 min por IP |
| GET | `/api/public/radar` | últimos 6 frames del radar RainViewer (plantillas de tiles) |

Administrativa (cabecera `Authorization: Bearer <token>`; token de `POST /api/login`):

| Método | Ruta |
|---|---|
| GET | `/api/admin/state` — todo, incluidos inactivos y reportes |
| PUT | `/api/admin/alert` — `{level, mode, message}` |
| PUT | `/api/admin/config` |
| POST / PUT / DELETE | `/api/admin/{points|streets|routes|recommendations}[/:id]` |
| PUT / DELETE | `/api/admin/reports/:id` — `{status}` |

## 6. Fuentes externas

| Fuente | Uso | Key |
|---|---|---|
| **Open-Meteo** | Lluvia actual, acumulada y pronóstico → nivel sugerido | No |
| **RainViewer** | Capa de radar animada sobre el mapa (botón de radar) | No |
| **Google Flood Forecasting** | Medidores de ríos cercanos con severidad; sin key se muestra enlace a Flood Hub | Sí (Google Cloud, API "Flood Forecasting") |
| **Google Maps JS API** | Proveedor de mapa alternativo a OpenStreetMap | Sí |
| **Comunidad** | Botón "Reportar inundación" → cola de revisión en el panel | — |

## 7. Diseño de interfaz

- **Elemento firma:** la banda de nivel bajo la cabecera. Cambia de color (verde, amarillo, naranja, rojo)
  y lleva una onda animada que se mueve más rápido cuanto más grave es la alerta. Se entiende en 2 segundos.
- Tipografía: Sora (títulos) + IBM Plex Sans (texto). Paleta: azul profundo + acento agua, con los
  cuatro colores de semáforo reservados solo para estados.
- Móvil: el mapa ocupa la mitad superior y queda fijo; la lista se desliza debajo. Formularios en
  hoja inferior (bottom sheet). En el panel, navegación inferior con iconos.
- Microcopy en español y errores que dicen qué hacer ("Dibuja al menos dos puntos sobre el mapa").

Capturas en `docs/capturas/` (tomadas sin acceso a internet, por eso el fondo del mapa aparece en gris;
con conexión se ve el mapa base de OpenStreetMap).

## 8. Flujo de trabajo típico del administrador

1. Entra a `/admin` → pestaña **Alerta**: elige modo automático o manual y escribe el mensaje.
2. **Calles**: pulsa *Dibujar*, hace clic sobre la calle siguiendo su trazado, pone estado y profundidad, *Publicar*.
3. **Vías alternas**: igual, indicando qué calle evita y las instrucciones.
4. **Puntos críticos**: clic en el mapa + nombre, tipo y severidad.
5. **Reportes**: revisa lo que envió la gente; *Verificar y publicar*, *Descartar* o *Crear punto crítico*.
6. Cuando el agua baja: *Desactivar* (oculta sin borrar) o cambiar estado a "despejada".

## 9. Funciones añadidas (versión 2)

### 9.1 Capas
Admin → **Capas**. Se sube un archivo y se convierte a GeoJSON en el navegador (`public/js/layers.js`):

| Formato | Cómo se lee |
|---|---|
| GeoJSON / JSON | directo |
| KML | se convierten Placemark (Point, LineString, Polygon, MultiGeometry), nombre, descripción, ExtendedData y colores de estilo |
| KMZ (Google Earth) | se descomprime con JSZip y se lee el .kml interno |
| Shapefile (.zip con .shp, .dbf, .prj) | se lee con shpjs y se reproyecta a WGS84 usando el .prj |

Se valida que las coordenadas estén en grados, se limita a 8000 elementos y se redondea a 6 decimales.
Opción "crear puntos críticos y calles": los puntos de la capa pasan a puntos críticos y las líneas a calles,
**inactivos**, para que el equipo los revise antes de publicarlos. En el mapa público cada persona puede
mostrar u ocultar capas con el botón de capas.

### 9.2 Navegación con GPS y aviso de proximidad
`public/js/gps.js`. Con `watchPosition` (alta precisión) se calcula, para cada calle inundada o parcial y cada
punto crítico activo, la distancia a la línea más cercana (proyección local en metros).

| Condición | Resultado |
|---|---|
| distancia ≤ primer aviso (400 m por defecto) **y** te estás acercando (la distancia baja o tu rumbo apunta al peligro) | **Precaución** |
| distancia ≤ aviso de peligro (150 m por defecto) | **Peligro** (aunque estés detenido) |
| distancia > 1,25 × primer aviso | se retira el aviso |
| botón "Entendido" | silencia ese peligro 2 minutos, salvo que pase de precaución a peligro |

Animación de proximidad: borde de pantalla que late (más rápido en peligro), tarjeta que entra con rebote y
tiembla al escalar, tanque circular cuya agua sube a medida que te acercas, cuenta regresiva de metros
animada, flecha que apunta al peligro, sonar de tres anillos en el punto exacto, línea animada entre tú y el
peligro, y la calle inundada resaltada con "agua que fluye" y halo pulsante. Además vibración y voz en español.
"Ver vía alterna" resalta la ruta que evita esa calle. Las distancias se ajustan en Admin → Configuración.

### 9.3 Índice de riesgo 0–100 (referencia: Amaru)
Amaru es una app que muestra riesgo de inundación con un índice 0–100 y semáforo, usando Google Flood
Forecasting, Open-Meteo, RainViewer y reportes de la comunidad. Tomamos esa idea:

| Señal | Peso | Fuente |
|---|---|---|
| Lluvia actual y acumulada 3 h | 30 | Open-Meteo |
| Pronóstico de lluvia 24 h × probabilidad | 25 | Open-Meteo |
| Ríos con alerta cercana | 20 | Google Flood Forecasting (si hay key) |
| Reportes ciudadanos de las últimas 3 h | 15 | Reportes de AlertaVial |
| Marea alta | 10 | Open-Meteo Marine (útil en la costa de El Oro) |

≥ 20 amarilla, ≥ 45 naranja, ≥ 70 roja. En modo automático el nivel publicado es el mayor entre la regla de
lluvia y este índice. Si una fuente no responde, su barra aparece apagada y suma 0.

### 9.4 Responsive
Celular: el mapa ocupa la parte superior y la información se desliza debajo; al activar el GPS el mapa pasa a
pantalla completa y la barra GPS se compacta. Tablet: misma disposición con más espacio. Escritorio: panel
lateral + mapa. El panel admin usa barra inferior en celular.

## 10. Versión 3: ríos, desbordes, vías animadas e imagen institucional

- **Ríos** (Admin → Ríos): se dibuja el cauce en el sentido en que corre el agua. Estados: normal, crecido (borde
  amarillo, flujo más rápido) y desbordado (borde rojo que parpadea, flujo muy rápido). Colección `rivers`.
- **Desbordes** (Admin → Desbordes): polígonos de las áreas a donde se sale el agua, con gravedad, profundidad y río
  de origen. Se muestran con borde en movimiento y relleno que late. Colección `zones`. El GPS avisa al acercarse y
  muestra "AQUÍ · estás dentro" si la persona entra en la zona. Un río en estado desbordado también genera aviso.
- **Vías alternas animadas**: línea azul institucional con trazos blancos que avanzan en el sentido del recorrido
  (dibújalas desde el origen hacia el destino).
- **Imagen institucional**: logo EMOVTT Santa Rosa EP, azul `#1B2B8B`, amarillo `#F5A623`, tipografías Barlow y
  Barlow Condensed (tomados del sitio institucional). Pie con aviso de que las fuentes oficiales son INAMHI y SNGR.
- Mapa público: pestaña **Ríos** con estado de cada río y lista de zonas de desborde; leyenda actualizada.

## 11. Versión 4: ríos automáticos, desbordes reportados y mensajes por color

- **Ríos automáticos.** En Admin → Ríos, "Buscar ríos de la zona" consulta OpenStreetMap (API Overpass, sin cuenta)
  en un radio de 3 a 12 km alrededor del centro. Une los tramos de cada cauce, los simplifica y los muestra para elegir.
  En OSM los cauces van en el sentido del agua, así que la animación fluye bien sin hacer nada. El estado
  (normal, crecido, desbordado) se cambia desde la misma lista. Trazar a mano queda como opción secundaria.
- **Desborde reportado.** El formulario público permite elegir "Calle inundada" o "Desborde de río". Cuando el equipo
  verifica un desborde, el mapa muestra agua que se expande en ese punto y un aviso fijo "Desborde de río activo",
  que se mantiene hasta que el equipo pulsa **Retirar (el agua bajó)** en Reportes. Un río marcado como desbordado
  también activa el aviso. Quien navega con GPS recibe advertencia al acercarse.
- **Mensaje por color.** Admin → Alerta tiene un mensaje editable para cada nivel (sin alerta, amarilla, naranja, roja).
  El mapa muestra el del nivel activo, sea automático o manual, y debajo el aviso adicional si hay uno.
- El botón "Administración" ya no aparece en el mapa público; el panel sigue en `/admin`.
- Al iniciar, el servidor muestra la dirección para abrirlo desde el teléfono en la misma red.

### Ajustes posteriores
- **Google Flood se puede apagar** (Admin → Configuración → "Usar Google Flood Forecasting"). Viene apagado.
  Sin Flood, la parte "Ríos" del índice de riesgo usa el estado que el equipo marca en cada río (crecido 60 %, desbordado 100 %).
- **Móvil:** el mapa ocupa casi toda la pantalla; la banda de alerta se reduce a una línea y se despliega al tocarla;
  botón "Ampliar mapa" para pantalla completa con leyenda; sin botones de zoom (se usa el gesto de pellizcar);
  botón de reporte y aviso de desborde más compactos.
- **Qué ve la ciudadanía** (Admin → Configuración): interruptores para mostrar u ocultar calles, vías alternas,
  ríos y desbordes, puntos críticos, consejos, reportes ciudadanos, GPS, radar, índice de riesgo, clima y capas.
  Lo apagado no se envía al mapa público (ni a los avisos GPS); los datos se conservan y reaparecen al encenderlo.
- **Intersecciones inundables desde KMZ.** En Capas, una capa con puntos tiene el botón "Convertir en puntos críticos":
  crea un punto tipo *Intersección inundable* por cada punto (inactivo) y oculta la capa original para no duplicar.
  En Puntos críticos cada uno tiene un interruptor Activo/Inactivo y la opción de activarse solo con alerta naranja o roja.
- **Vía alterna por intersección.** "Crear vía alterna" abre el trazado ya vinculado al punto. Con "Seguir las calles"
  la línea va por las calles reales entre cada toque (servicio OSRM de OpenStreetMap, sin cuenta; si no responde,
  se agrega una recta). La vía solo se muestra al público y en el GPS mientras su punto esté activo.
  El GPS ofrece "Ver vía alterna" solo si la intersección tiene una vía propia.
- **Buscador "¿A dónde vas?"** en el mapa público: busca direcciones y lugares (Nominatim, OpenStreetMap) y traza una
  ruta (OSRM) que no cruce puntos, calles o zonas inundadas activas. Si todas las rutas normales cruzan una zona,
  prueba desvíos por puntos a los lados de la zona. Si no hay ruta libre, avisa por qué zona pasa. Si se activa una
  zona nueva en el camino, la ruta se recalcula sola. Sin GPS, la ruta sale del centro de la ciudad.
- **Desvío automático del GPS:** al acercarse a una zona inundada sin vía alterna dibujada, el GPS calcula un desvío
  por calles y ofrece "Ver desvío". Las vías dibujadas a mano siguen teniendo prioridad.
- **Zonas del KMZ con alerta naranja:** al convertir la capa, cada zona queda con "activar con alerta naranja o roja".
- **Activar o desactivar todo:** botones masivos en Puntos críticos, Calles, Vías alternas y Desbordes, además del
  interruptor de cada uno.
- **Vías alternas automáticas por punto.** En Puntos críticos, "Generar para N puntos" (o "Generar automática" en cada
  punto) busca qué calles cruzan el punto (ejes N–S, E–O y diagonales) y, para cada una, un desvío por calles reales de
  300 m antes a 300 m después que no pase por ningún punto de riesgo. Cada vía queda ligada a su punto y solo aparece
  cuando el punto se activa (a mano o por alerta naranja/roja).

### Clima más sensible a la lluvia leve
- Open-Meteo es un modelo de malla gruesa y a veces marca 0 mm aunque esté lloviznando. Ahora "Lluvia ahora" toma el mayor valor entre la lectura actual, la suma de lluvia + chubascos y la hora en curso.
- Se usa además el código del tiempo (WMO) para describir la condición: Llovizna, Lluvia leve, moderada, fuerte, chubascos o tormenta, y se muestra en el mapa público y en el panel.
- Cualquier lluvia o llovizna detectada sube el nivel sugerido a **amarilla**; lluvia fuerte a **naranja**; tormenta con lluvia sobre el umbral a **roja**. Una probabilidad de lluvia de 70 % o más en las próximas 3 h también da amarilla.
- El modo manual sigue disponible si el modelo no refleja lo que se ve en la calle.

### Ruta por partes, "Mi ruta" y uso sin conexión
- **Vías alternas por cercanía:** con una ruta marcada solo se dibujan las vías alternas que quedan a menos de 400 m de tu camino; con el GPS encendido aparecen poco a poco cuando estás a 600 m o menos (con una animación y un aviso). Un botón bajo el buscador ("Ver todas" / "Solo mi camino") cambia a la vista general. Sin ruta ni GPS el mapa muestra todo, como antes.
- **Mi ruta** (botón azul junto al buscador): eliges de dónde sales (tu ubicación o un punto del mapa) y a dónde vas (dirección, punto del mapa o un lugar guardado). Cada ruta se puede **guardar**: el destino queda como lugar favorito y la ruta completa queda en el teléfono.
- **Sin conexión:** la página guarda en el teléfono el último estado (calles, zonas, puntos, vías alternas) y la ruta en curso. Si se cae la señal aparece "Sin conexión · datos de las …", el mapa sigue mostrando las zonas, el GPS sigue avisando (el GPS no usa datos) y las rutas guardadas se abren sin internet. Calcular una ruta nueva o buscar direcciones sí necesita red.
- Un service worker (`public/sw.js`) guarda la página y los cuadros del mapa que ya se vieron (hasta 1500), para poder abrir la app sin señal. Solo funciona con **https** o en `localhost`; por la IP de la red local (http) el teléfono guarda los datos y rutas, pero no la página.

### Simulador de lluvia y radar
- **Admin → Alerta → Simulador de lluvia (pruebas):** botones Sin lluvia, Llovizna, Lluvia leve, moderada, fuerte y Tormenta, o valores a mano (mm ahora, últimas 3 h, próximas 3 h, probabilidad y tipo de cielo), con duración de 15 a 120 min. Mientras dura, el nivel publicado sigue al clima simulado aunque la alerta esté en manual, los puntos "auto" se encienden con naranja/roja y el mapa público muestra la etiqueta "Simulación de prueba". Vive solo en memoria: no se guarda en `data/db.json` y se apaga al terminar el tiempo, con "Detener" o al reiniciar el servidor.
- **Radar RainViewer:** desde el 1 de enero de 2026 la API gratuita solo entrega cuadros hasta zoom 7 (y solo el esquema de color Universal Blue, sin pronóstico a futuro). El mapa ahora pide zoom 7 y lo amplía, por eso se ve más borroso que antes. Se activa con el botón de radar del mapa público.

### Simulador de navegación, búsqueda en Santa Rosa y ventanas propias
- **Admin → Simular navegación:** el mapa público dentro del panel (vista teléfono o computadora, o en otra pestaña con `/?sim=1`). Se busca el destino, se toca la salida en el mapa y "Simular" hace que un vehículo virtual recorra la ruta a 1×, 2× o 4×, con pausa. Se ven los avisos del GPS, las vías alternas apareciendo al acercarse y, con "Ruta directa, sin esquivar", el aviso de la intersección inundada y el botón **Tomar desvío**, que recalcula el camino al destino y el vehículo lo sigue. En modo simulación no se usa el GPS real ni se guarda la ruta en el teléfono.
- El botón "Simular" de la barra GPS del mapa público también recorre la ruta marcada, si la hay.
- **Búsqueda solo en Santa Rosa:** Nominatim se consulta con una caja de unos 7 km alrededor del centro configurado (`bounded=1`) y se descartan resultados más lejanos; elegir un punto fuera de la ciudad en el mapa también se rechaza.
- **Ventanas propias:** las confirmaciones (eliminar, desactivar todos) usan una ventana animada de la app en lugar del `confirm()` del navegador; los avisos (toasts) tienen icono, barra de tiempo, animación y no se repiten.

### Clima animado y navegación sin distracciones
- **Indicador del clima** sobre el mapa (bajo el buscador): condición actual, mm/h o probabilidad, y "prueba" si viene del simulador.
- **Animación:** con lluvia, el mapa se oscurece un poco y caen gotas (más densas según la intensidad); con tormenta eléctrica, además, relámpagos y destellos cada pocos segundos. Las gotas quedan bajo los marcadores y no bloquean los toques. Tocar el indicador oculta o muestra la animación (se recuerda en el teléfono). Con "reducir movimiento" del sistema la lluvia cae más lenta, con menos gotas y sin relámpagos. Cada nivel de intensidad oscurece más el mapa y agrega salpicaduras en el suelo.
- **Avisos solo adelante:** con ruta marcada, el GPS solo avisa de peligros que están más adelante sobre la ruta y a menos de 120 m de ella; lo que queda atrás o a un costado no avisa. Sin ruta, avisa de lo que está en la dirección de avance (±70°).
- **Vías alternas del camino:** al navegar se muestra solo la vía alterna del próximo peligro de la ruta (una por peligro, máximo dos), aparece a 700 m y desaparece cuando lo pasas. "Ver todas" sigue mostrando la vista general.

### Navegación giro a giro, recálculo y app instalable
- **Giro a giro:** las rutas se piden a OSRM con `steps=true`; cada maniobra se traduce al español ("Gira a la derecha en Av. X", "En la rotonda, toma la segunda salida", "Llegas a tu destino"). Si una ruta no trae pasos (guardada antes o desvío), los giros se calculan por la forma de la línea. Mientras se navega, una tarjeta verde reemplaza al buscador con flecha, distancia e indicación, y "Luego…" si el siguiente giro está cerca. Voz: a ~200 m ("En 200 metros, gira…") y al llegar al giro, en cola para no cortar los avisos de peligro (`public/js/guide.js`).
- **Recálculo automático:** si el vehículo se aleja más de 45 m de la ruta (o 1,5 veces la precisión del GPS) en 3 lecturas seguidas, se recalcula desde donde está, evitando las zonas inundadas ("Recalculando"). Como máximo cada 12 s. Sin señal, avisa que vuelva a la línea azul.
- **Simulador:** botón "Tomar otra calle" para salirse de la ruta y ver el recálculo.
- **App instalable (PWA):** `manifest.webmanifest`, íconos en `public/img/icons/`. En Android/Chrome aparece una tarjeta "Instala AlertaVial" con botón Instalar; en iPhone explica Compartir → Agregar a inicio. Se puede posponer 7 días. Requiere https (Render o cPanel con AutoSSL).
- **Compartir:** Admin → Configuración → "Compartir con la ciudadanía": enlace directo, copiar, WhatsApp y código QR descargable para afiches (librería `qrcode-generator`, MIT, en `public/vendor/qrcode/`).

## 12. Siguientes pasos sugeridos

- Pasar la base de datos a SQLite/Postgres y los usuarios a una tabla con contraseñas cifradas.
- Notificaciones (WhatsApp/Telegram/push) cuando cambia el nivel de alerta.
- Snap de las líneas dibujadas a las calles reales (OSRM o Google Roads API).
- Histórico de eventos para saber qué calles se inundan con más frecuencia.
- Desplegar en Render, Railway o un VPS con `npm start` (un solo proceso, puerto `PORT`).

### Clima de varias fuentes (lluvia real, no solo pronóstico)
- El 14-nov-2026 llovía fuerte en Santa Rosa y el semáforo seguía verde: Open-Meteo es un **pronóstico de modelo** y no ve los aguaceros locales de la costa. Las coordenadas (-3.4596, -79.9658) y la hora (America/Guayaquil) estaban bien.
- Ahora el servidor (`server/weather.js`) combina varias fuentes y **gana la que vea la lluvia más fuerte**:
  - Open-Meteo con 8 modelos (mejor modelo, ECMWF, GFS, ICON, JMA, Météo-France, UK Met Office, GEM), pedidos por separado; se exige que al menos 2 coincidan para no alarmar por un solo modelo.
  - METAR del aeropuerto de Santa Rosa (SERO) vía aviationweather.gov (NOAA): observación real cuando el aeropuerto reporta (se usa si tiene menos de 90 min). `VC` (lluvia en los alrededores) cuenta como leve.
  - OpenWeatherMap opcional (`OWM_KEY` o Admin → Configuración).
  - **Equipo EMOVTT**: Admin → Alerta → "¿Está lloviendo ahora?" (leve, moderada, fuerte, tormenta; vence sola). Se guarda en `alert.observed`.
  - Reportes ciudadanos de la última hora (2 reportes o 1 verificado cuentan como lluvia).
- Admin → Alerta → "Fuentes del clima" muestra qué dice cada fuente, la hora del dato y cuál decide el nivel. El mapa público muestra la fuente y la hora en la línea de clima.
- RainViewer no tiene radares en Ecuador (su página de cobertura no lo incluye), por eso el radar del mapa puede verse vacío.

### Menos falsas alarmas: las señales tienen que coincidir (como Amaru)
- 16-nov-2026: con sol el sistema mostraba "Llovizna" y alerta amarilla. Causas: el código de cielo "llovizna" de un modelo bastaba aunque no lloviera, 0,1–0,4 mm/h de garúa de los modelos contaba como lluvia, la lluvia "en los alrededores" del aeropuerto (VCSH) contaba como leve, y el pronóstico solo encendía la amarilla.
- Amaru (amaruapp.com) usa Open-Meteo, RainViewer, MET Norway, Google Flood Forecasting y reportes de usuarios, y no deja que una sola señal encienda una alerta alta: "hace falta que coincidan".
- Reglas nuevas:
  - Lluvia medible: al menos 0,5 mm/h. Un código de lluvia sin milímetros no cuenta.
  - Modelos: hacen falta al menos 3 de 8 con lluvia medible, y no cuentan si el mejor modelo da menos de 50 % de nubes.
  - Aeropuerto: solo cuenta la lluvia sobre la estación (RA, DZ, TS), no VC.
  - Pronóstico: amarilla solo con probabilidad ≥ 80 % y varios modelos con ≥ la mitad del umbral en 3 h.
  - Índice de riesgo: amarilla desde 30 (antes 20), naranja desde 50 (antes 45), para que una sola señal no baste.
- Puntos automáticos y sus vías alternas: se encienden con naranja/roja; al bajar a amarilla o verde se apagan también los puntos automáticos que se encendieron a mano durante la alerta (`alert.lastEffective`). Generar vías alternas automáticas deja el punto en modo automático.

### Límite de consultas de Open-Meteo (16-nov-2026)
En servidores compartidos (Render y similares) Open-Meteo puede responder "demasiadas consultas" (429), porque la IP la usan muchos.
- Los 8 modelos se piden en **una sola consulta** (antes eran 8) y se guardan 10 minutos.
- Si Open-Meteo responde 429, no se le vuelve a preguntar en 15 minutos y se sigue usando el último dato bueno (hasta 1 hora), avisando "Dato de Open-Meteo de hace X min".
- **MET Norway (yr.no)**, otra fuente que usa Amaru, entra como un modelo más (9 en total; un tercio tiene que coincidir) y queda de respaldo con lluvia, nubosidad, temperatura y UV (cielo despejado corregido por nubosidad).
- El aeropuerto (METAR SERO) sigue funcionando aunque fallen los pronósticos.

### Aviso de lluvia posible (16-nov-2026)
Además del semáforo, el mapa avisa cuando **podría llover pronto** (no cambia el nivel de alerta). Suma señales: probabilidad de lluvia en 3 h, cuántos modelos prevén lluvia, energía del aire para tormentas (CAPE de Open-Meteo), tormenta prevista por MET Norway y lo que ve el aeropuerto (lluvia en los alrededores, tormenta o cumulonimbos). Con 2 puntos: "Atención: podría llover pronto"; con 4: "Lluvia probable en las próximas horas", con la hora aproximada y un aviso emergente. La tarjeta del clima muestra la probabilidad de lluvia de las próximas 6 horas.

### Probabilidad de lluvia por horas (16-nov-2026)
La probabilidad salía en 0 % cuando la fuente no la publicaba (MET Norway no la da para Ecuador) aunque varios modelos sí previeran lluvia.
- Ahora se arma un **pronóstico hora por hora de 24 h** juntando todos los modelos que respondieron (`mergeHourly` en `server/weather.js`).
- Probabilidad de cada hora = la mayor entre (a) el promedio de la probabilidad que publican los modelos y (b) la parte de los modelos que prevén lluvia (0,1 mm o más) en esa hora. Con 1 o 2 modelos se estima por los milímetros. Se redondea de 5 en 5.
- Milímetros de la hora: si al menos un tercio de los modelos ve lluvia, el promedio de esos; si no, el promedio de todos.
- Si una fuente confirma que está lloviendo, la hora en curso pasa a 100 %.
- El panel muestra "Lluvia por horas" (12 horas que se deslizan) y el resumen por partes del día (tarde, noche, madrugada, mañana). El semáforo no cambia de reglas.

### Panel pensado para el teléfono (16-nov-2026)
- Arriba, tres fichas de un vistazo: **Riesgo /100**, **Lluvia 3 h %** (o mm/h si llueve) y **Calles inundadas**; cada una abre su pestaña.
- Pestañas: Resumen (aviso de lluvia, clima, lluvia por horas, sol y UV, índice de riesgo, de dónde salen los datos) · Calles · Vías alternas · Ríos · Consejos. Si hay calles inundadas, la página abre en Calles.
- Texto del panel nunca menor a 12 px; los avisos (toasts) no tapan el botón Reportar ni la tira de la hoja.

### Panel de administración: resumen al entrar (16-nov-2026)
- En **Alerta**, debajo del nivel publicado, seis fichas: Riesgo /100, Lluvia 3 h, Calles inundadas, Puntos activos, Vías alternas y Reportes por revisar. Las de calles, puntos, vías y reportes llevan a su sección.
- En pantallas de 1280 px o más, el **índice de riesgo** (con cuánto aporta cada señal) y las **fuentes del clima** con la lluvia por horas quedan a la derecha de los controles; en tablet y teléfono van debajo.

### Aviso de lluvia solo con 80 % o más (17-nov-2026)
Pedido de EMOVTT: el aviso "Lluvia probable" salía cada hora y la lluvia no llegaba, lo que confundía a la gente.
- `outlookOf` (server/weather.js) publica el aviso solo si en alguna de las próximas 6 horas la probabilidad llega a `NOTICE_PROB = 80`. Con menos queda en "calma" aunque haya otras señales (energía de tormenta, aeropuerto, modelos); esas señales solo explican el aviso cuando se publica. Se quitó el nivel intermedio "Podría llover".
- La etiqueta del mapa, el aviso, la ficha "Lluvia 3 h" resaltada, el texto "Lluvia probable" y el toast usan el mismo mínimo. Las barras por hora siguen mostrando el porcentaje, pero solo desde 80 % se pintan fuerte; "Sin probabilidad alta" cuando ninguna parte del día llega a 80 %.
- No cambia el semáforo (amarilla/naranja/roja siguen igual).

### Buscador de viajes y vías alternas bajo demanda (17-nov-2026)
Pedido de EMOVTT: que se use en el teléfono como Google Maps, dentro de la ciudad y hacia otras ciudades, con búsqueda rápida y sin confusión de rutas en el mapa.
- **Buscador rápido** (`public/js/places.js`): al tocar el cuadro salen al instante ciudades cercanas (Machala, Pasaje, Huaquillas, Arenillas, El Guabo, Zaruma, Piñas, Portovelo) y lugares guardados. Al escribir, los resultados locales (ciudades, puntos y calles del mapa) aparecen sin esperar red, sin tildes ni mayúsculas ("pinas" → Piñas, "huaquillar" → Huaquillas). En paralelo se consulta Photon (OpenStreetMap), que entiende palabras a medias ("cem" → Cementerio), y si no responde, Nominatim. Cada letra nueva cancela la consulta anterior y se recuerdan las ya hechas. Lo más cercano a Santa Rosa sale primero.
- **Viajes fuera de la ciudad**: se puede elegir destino hasta ~260 km (TRAVEL_RADIUS_M). La tarjeta muestra tiempo, distancia, hora de llegada, hasta 3 rutas para escoger y un aviso de que el mapa solo marca las inundaciones de Santa Rosa.
- **Vías alternas ocultas por defecto**: el mapa se abre limpio. Solo se dibujan al navegar con GPS, al elegir un destino o ruta (las cercanas a ese trayecto), al tocar una en la lista, o con el botón de rutas del mapa (`#btn-alt`: mostrar todas / ocultar).
