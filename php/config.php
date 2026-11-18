<?php
// Configuración de AlertaVial (versión PHP para cPanel). Edita estas líneas con el Administrador de archivos de cPanel.
define('AV_ADMIN_USER', 'admin');
define('AV_ADMIN_PASSWORD', 'CAMBIAR-ESTA-CLAVE');   // <- cámbiala: mientras diga esto, el panel no deja entrar
define('AV_OWM_KEY', '');                             // opcional: API key gratuita de OpenWeatherMap
define('AV_DATA_DIR', __DIR__ . '/data');             // aquí se guardan los datos (la carpeta está protegida)
