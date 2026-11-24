# AlertaVial en cPanel (versión PHP)

Esta versión hace lo mismo que la de Node.js (mapa público, panel de administración, clima, alertas, reportes, respaldo), pero corre en cualquier cPanel con **PHP 8.0 o superior**. No necesita Node.js y **no se apaga**: los datos quedan guardados en el hosting.

## Qué necesitas
- Un cPanel con PHP 8.0+ y las extensiones `curl`, `mbstring`, `openssl` y `gd` (vienen activas casi siempre; se ven en *Seleccionar versión de PHP → Extensiones*). `gd` lee la imagen del radar y `openssl` firma las notificaciones push.
- Un dominio o subdominio **para esta app sola** (por ejemplo `alerta.tudominio.com`). La app usa direcciones que empiezan en `/`, así que no funciona dentro de una subcarpeta como `tudominio.com/alerta`.
- HTTPS activo (AutoSSL de cPanel). Sin HTTPS el GPS del teléfono y la instalación de la app no funcionan.

## Instalación (10 minutos)
1. En cPanel crea el subdominio (*Dominios → Crear un dominio*). Su carpeta será, por ejemplo, `public_html/alerta`.
2. Entra al **Administrador de archivos**, abre esa carpeta y pulsa **Cargar**: sube `alertavial-cpanel.zip`.
3. Clic derecho sobre el zip → **Extract** (Extraer). Debe quedar `index.html`, `admin.html`, la carpeta `api`, `data`, el archivo `config.php` y el archivo oculto `.htaccess` directamente en esa carpeta. (Activa *Mostrar archivos ocultos* en Configuración del Administrador de archivos.) Luego borra el zip.
4. Abre `config.php` (clic derecho → Edit) y **cambia `AV_ADMIN_PASSWORD`** por la contraseña que quieras. Mientras diga `CAMBIAR-ESTA-CLAVE`, el panel no deja entrar. Guarda.
5. Abre `https://alerta.tudominio.com`: debe verse el mapa. El panel está en `https://alerta.tudominio.com/admin` (usuario `admin`).
6. En el panel, **Configuración → Respaldo de datos → Restaurar** si quieres cargar los datos que ya tenías (puntos, calles, ríos, vías alternas). El respaldo se descarga desde la versión Node (o desde Render) con el botón *Descargar respaldo*.

## Tarea programada (recomendada, 2 minutos)
Para que el semáforo baje solo, los puntos críticos se apaguen al terminar el drenaje y lleguen las notificaciones push aunque nadie tenga el mapa abierto:
1. cPanel → **Cron Jobs** (Trabajos de cron) → *Agregar nuevo trabajo de cron*.
2. Frecuencia: **cada 5 minutos** (`*/5 * * * *`).
3. Comando (cambia la ruta por la de tu carpeta):
   `php /home/TU_USUARIO/public_html/alertavial/api/cron.php >/dev/null 2>&1`

Sin la tarea programada la app igual funciona: revisa todo cada vez que alguien abre el mapa.

## Diferencias con la versión Node (Render)
- **Detector de rayos**: no está en PHP. Necesita un programa encendido todo el tiempo (satélite GOES y red Blitzortung) y un hosting compartido no lo permite. La tormenta se sigue detectando con el aeropuerto (METAR), el radar y los modelos.
- Todo lo demás es igual: reportes con foto obligatoria (se guardan en `data/photos`), reportes aceptados como puntos críticos de nivel medio, bajada gradual del semáforo, tiempo de drenaje, ríos que suben el nivel, calles cercanas automáticas, "Ayer" con el diario del clima, notificaciones push y botón *Actualizar mapa*.

## Opcional
- **OpenWeatherMap**: pon tu API key gratuita en `AV_OWM_KEY` (`config.php`) para sumar otra fuente de clima.
- **Permisos**: la carpeta `data` debe poder escribirse (permiso 755 o 775; cPanel ya lo trae así). Ahí se guardan `db.json`, la caché del clima y las sesiones. La carpeta está protegida: nadie puede abrirla desde internet.

## Actualizar a una versión nueva
Sube los archivos nuevos **sin tocar** la carpeta `data` ni `config.php`. Antes de actualizar, descarga un respaldo desde el panel.

## Si algo falla
| Síntoma | Qué revisar |
|---|---|
| Error 500 o página en blanco | *Seleccionar versión de PHP*: elige 8.1 o superior y activa `curl` y `mbstring`. |
| El panel dice "Falta elegir la contraseña" | Cambia `AV_ADMIN_PASSWORD` en `config.php`. |
| "Necesitas iniciar sesión" aunque la contraseña es correcta | Verifica que el archivo `.htaccess` esté en la carpeta (es oculto). Es el que pasa la sesión a PHP. |
| El clima dice "sin conexión" | Algunos hostings compartidos bloquean conexiones salientes: pídele a soporte que permitan a PHP conectarse a `api.open-meteo.com`, `api.met.no`, `aviationweather.gov`, `tgftp.nws.noaa.gov`, `wttr.in`, `api.rainviewer.com` y `tilecache.rainviewer.com`. |
| No llegan las notificaciones | Activa la extensión `openssl` y configura la tarea programada. Las notificaciones necesitan HTTPS. |
| El reporte dice que no se pudo guardar la foto | Permisos de la carpeta `data` (755/775). |
| No guarda cambios | Permisos de la carpeta `data` (755/775). |

## Para quien mantiene el código
- Todo sale de la rama `php-cpanel`. `php/build.sh` arma la carpeta `php/dist-cpanel` (y el zip) con `public/` + `php/api` + `php/.htaccess` + `php/config.php`.
- La lógica del clima (`php/api/lib/weather.php`) es un port línea a línea de `server/weather.js`; con los mismos datos de entrada produce los mismos resultados (se comparó contra la versión Node).
- Prueba local: `php/build.sh`, poner una contraseña en `php/dist-cpanel/config.php` y `php -S 127.0.0.1:3000 -t php/dist-cpanel php/dev-router.php`.


## Instalar en una subcarpeta (ej. https://emovttsr.gob.ec/alertavial/)

El zip se genera ya preparado para la subcarpeta `/alertavial`. Sube su contenido a `public_html/alertavial/`
(incluido el archivo oculto `.htaccess`), edita `config.php` y cambia `AV_ADMIN_PASSWORD`. El panel queda en
`/alertavial/admin`. Si usas otro nombre de carpeta, regenera con `./build.sh /nombre`; para un dominio o
subdominio propio, `./build.sh` sin argumento.
