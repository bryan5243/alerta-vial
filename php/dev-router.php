<?php
// Solo para probar en la PC con `php -S` (imita las reglas de .htaccess). No se sube al hosting.
// Con subcarpeta: AV_BASE=/alertavial php -S ... (y la carpeta se sirve en esa ruta).
$base = rtrim(getenv('AV_BASE') ?: '', '/');
$p = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if ($base !== '' && strpos($p, $base . '/') === 0) {
  $rest = substr($p, strlen($base));
  $file = __DIR__ . '/dist-cpanel' . $rest;
  if (is_file($file) && !preg_match('#^/(api|data)/#', $rest)) { $t = ['css' => 'text/css', 'js' => 'application/javascript', 'html' => 'text/html', 'png' => 'image/png', 'webmanifest' => 'application/manifest+json', 'svg' => 'image/svg+xml', 'json' => 'application/json'][pathinfo($file, PATHINFO_EXTENSION)] ?? 'application/octet-stream'; header("Content-Type: $t"); readfile($file); return true; }
  if ($rest === '/' || $rest === '') { readfile(__DIR__ . '/dist-cpanel/index.html'); return true; }
  $p = $rest;
}
$_SERVER['SCRIPT_NAME'] = $base . '/api/index.php';
if (preg_match('#^/photos/(rep_[a-z0-9]+\.jpg)$#', $p, $m)) { $_GET['photo'] = $m[1]; require __DIR__ . '/dist-cpanel/api/index.php'; return true; }
if (preg_match('#^/(data|api)/#', $p) && !preg_match('#^/api/#', $p)) { http_response_code(403); return true; }
if (preg_match('#^/api/#', $p)) { $_SERVER['REQUEST_URI'] = $p; require __DIR__ . '/dist-cpanel/api/index.php'; return true; }
if (preg_match('#^/data/#', $p)) { http_response_code(403); return true; }
if (preg_match('#^/admin/?$#', $p)) { readfile(__DIR__ . '/dist-cpanel/admin.html'); return true; }
return false;
