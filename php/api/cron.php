<?php
// Tarea programada de cPanel (Cron Jobs), cada 5 minutos:
//   php /home/USUARIO/public_html/api/cron.php
// Revisa el clima, mueve el semáforo (bajada gradual, drenaje) y envía los avisos push aunque nadie tenga el mapa abierto.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
define('AV_NO_ROUTER', true);
require __DIR__ . '/index.php';
try { cache_put('cron', ['at' => now_ms()]); $sent = push_tick(); echo gmdate('c') . ' ok, avisos: ' . count($sent) . "\n"; }
catch (Throwable $e) { fwrite(STDERR, 'AlertaVial cron: ' . $e->getMessage() . "\n"); exit(1); }
