# Alerta Vial · EMOVTT Santa Rosa EP

Sistema de alertas de calles inundadas, ríos y desbordes para la Empresa Pública Municipal de Movilidad, Tránsito y Transporte de Santa Rosa (El Oro).

Mapa público de calles inundadas, vías alternas y recomendaciones, con un panel administrativo
para activar alertas (manualmente o según la lluvia) y colocar puntos críticos sobre el mapa.

## Ejecutar en 1 minuto

```bash
npm install
npm start
```

- Mapa público: http://localhost:3000
- Panel admin:  http://localhost:3000/admin  (usuario `admin`, contraseña `admin123`)

Requiere Node.js 18 o superior. La primera vez se cargan datos de ejemplo de Santa Rosa (El Oro).
Para volver a cargarlos: `npm run seed`.

## Variables de entorno (opcionales)

| Variable | Para qué sirve | Valor por defecto |
|---|---|---|
| `PORT` | Puerto del servidor | `3000` |
| `ADMIN_USER` / `ADMIN_PASSWORD` | Credenciales del panel | `admin` / `admin123` |
| `DB_PATH` | Ruta del archivo JSON de datos | `data/db.json` |
| `GOOGLE_FLOOD_KEY` | API key de Google Flood Forecasting | vacío (se muestra enlace a Flood Hub) |

La API key de Google Maps y la de Flood Forecasting también se pueden escribir desde
**Admin → Configuración**, sin tocar archivos.

## Ver el sistema en tu teléfono (red local)

1. Conecta la PC y el teléfono a la **misma red WiFi**.
2. Ejecuta `npm start`. La consola muestra la dirección para el teléfono, por ejemplo
   `En tu teléfono: http://192.168.1.25:3000`. (También la ves con `ipconfig`, en "Dirección IPv4".)
3. Abre esa dirección en el navegador del teléfono.
4. Si no carga, la primera vez Windows pregunta si permite a Node.js en la red: marca **Redes privadas** y acepta.
   Si ya lo negaste: Panel de control → Firewall de Windows → Permitir una aplicación → Node.js → Privada.
5. El panel admin ya no aparece como botón en el mapa público; se abre escribiendo `/admin` al final de la dirección.

## Usar el GPS desde el celular

El navegador solo permite el GPS en `https://` o en `localhost`. En la misma computadora funciona tal cual.
Para probarlo en un celular:

- Publica la app en un servidor con HTTPS (Render, Railway, un VPS con Let's Encrypt), o
- abre un túnel temporal desde tu PC, por ejemplo `npx cloudflared tunnel --url http://localhost:3000`, y abre en el celular la dirección `https://…` que te da.

Sin salir a la calle puedes ver la animación con el botón **GPS → Simular** (el ícono ▶ en el celular).

## Qué incluye

- **Mapa público** (`/`): calles inundadas (rojo), parcialmente inundadas (naranja), despejadas (verde),
  vías alternas (azul punteado), puntos críticos, reportes ciudadanos verificados, radar de lluvia
  (RainViewer) y botón "Reportar inundación".
- **Navegación con GPS**: sigue tu ubicación y te avisa *antes* de llegar a una calle inundada o a un punto crítico,
  con animación de proximidad (sonar, agua que sube, cuenta regresiva de metros, flecha de dirección, borde de pantalla
  pulsante, calle resaltada con flujo animado), vibración, aviso por voz y botón "Ver vía alterna".
- **Ríos y desbordes**: el equipo dibuja el cauce de cada río (con estado normal, crecido o desbordado y agua animada que corre) y las zonas a donde se sale el agua (áreas animadas). El GPS avisa al acercarse o entrar a una zona de desborde.
- **Vías alternas animadas**: trazos que avanzan en el sentido de la ruta.
- **Índice de riesgo 0–100** (inspirado en Amaru): lluvia actual, pronóstico 24 h, ríos, reportes ciudadanos y marea.
- **Capas**: sube GeoJSON, KML, KMZ (Google Earth) o Shapefile (.zip) desde el panel y se muestran en el mapa público.
- **Panel admin** (`/admin`): alerta (manual o automática por clima), puntos críticos, calles, vías alternas,
  recomendaciones, revisión de reportes ciudadanos y configuración (ciudad, proveedor de mapa, umbrales de lluvia).
- **Fuentes de datos**: Open-Meteo (clima, sin key), RainViewer (radar, sin key), Google Flood Forecasting
  (ríos, con key opcional), reportes de la comunidad.

Consulta `docs/DISENO.md` para la arquitectura completa y la API.
