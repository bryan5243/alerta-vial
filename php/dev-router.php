<?php
// Solo para probar en la PC con `php -S` (imita las reglas de .htaccess). No se sube al hosting.
$p = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if (preg_match('#^/api/#', $p)) { require __DIR__ . '/dist-cpanel/api/index.php'; return true; }
if (preg_match('#^/admin/?$#', $p)) { readfile(__DIR__ . '/dist-cpanel/admin.html'); return true; }
return false;
