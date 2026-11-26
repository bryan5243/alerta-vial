<?php
// AlertaVial · API en PHP (equivalente a server/index.js). Todas las rutas /api/... llegan aquí por .htaccess.
declare(strict_types=0);
error_reporting(E_ALL & ~E_DEPRECATED & ~E_NOTICE & ~E_WARNING);
require dirname(__DIR__) . '/config.php';
require __DIR__ . '/lib/http.php'; require __DIR__ . '/lib/db.php'; require __DIR__ . '/lib/weather.php'; require __DIR__ . '/lib/flood.php';
require __DIR__ . '/lib/near.php'; require __DIR__ . '/lib/daylog.php'; require __DIR__ . '/lib/push.php';
date_default_timezone_set('UTC');

const DEFAULT_LEVEL_MESSAGES = [
  'normal' => 'Vías operando con normalidad. Circule con precaución y respete la señalización.',
  'amarilla' => 'Lluvia prevista en la ciudad. Planifique su ruta, evite zonas bajas y manténgase informado.',
  'naranja' => 'Hay calles inundadas. Evite los sectores marcados en rojo y use las vías alternas en azul.',
  'roja' => 'Riesgo alto de inundación. No circule por las zonas señaladas, aléjese de ríos y canales y siga las indicaciones de EMOVTT y la SGR.'];
const DEFAULT_FEATURES = ['streets' => true, 'routes' => true, 'rivers' => true, 'points' => true, 'recommendations' => true, 'reports' => true, 'gps' => true, 'radar' => true, 'risk' => true, 'weather' => true, 'layers' => true];
const DEFAULT_NOCAR = ['Malecón', 'peatonal', 'ciclovía', 'escalinata'];
const LV = ['normal' => 0, 'amarilla' => 1, 'naranja' => 2, 'roja' => 3];
const COLLECTIONS = [
  'points' => ['pt', ['name', 'lat', 'lng', 'type', 'severity', 'description', 'active', 'auto', 'source']],
  'streets' => ['st', ['name', 'coords', 'status', 'depthCm', 'note', 'active']],
  'routes' => ['rt', ['name', 'coords', 'from', 'to', 'description', 'avoids', 'active', 'auto']],
  'recommendations' => ['rc', ['text', 'level', 'active']],
  'rivers' => ['rv', ['name', 'coords', 'status', 'note', 'active', 'source', 'kind']],
  'zones' => ['zn', ['name', 'coords', 'severity', 'riverId', 'note', 'depthCm', 'active']],
  'layers' => ['ly', ['name', 'color', 'geojson', 'kind', 'source', 'active']]];

function out($data, int $code = 200): void {
  if (!empty($GLOBALS['BUMP_REV']) && $code < 400) cache_put('rev', ['rev' => now_ms()]);
  $j = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
  http_response_code($code); header('Content-Type: application/json; charset=utf-8'); header('Cache-Control: no-store');
  // Largo exacto + cerrar conexión: el teléfono recibe la respuesta completa aunque PHP siga renovando el clima por detrás
  header('Content-Length: ' . strlen($j)); header('Connection: close');
  echo $j; while (ob_get_level()) ob_end_flush(); flush(); exit;
}
function fail(int $code, string $msg): void { out(['error' => $msg], $code); }
function body(): array { static $b = null; if ($b === null) { $j = json_decode((string)file_get_contents('php://input'), true); $b = is_array($j) ? $j : []; } return $b; }
function bearer(): string {
  $h = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
  if (!$h && function_exists('getallheaders')) foreach (getallheaders() as $k => $v) if (strtolower($k) === 'authorization') $h = $v;
  return trim(preg_replace('/^Bearer\s+/i', '', $h));
}
function auth(): void { $t = bearer(); $s = sessions_load(); if ($t && isset($s[$t])) return; fail(401, 'Necesitas iniciar sesión como administrador.'); }
function s_val($v, int $max) { return mb_substr((string)$v, 0, $max); }
function is_num($v): bool { return is_int($v) || is_float($v); }
function now_iso(): string { return gmdate('Y-m-d\TH:i:s') . '.' . sprintf('%03d', (int)(fmod(microtime(true), 1) * 1000)) . 'Z'; }
function features_cfg(array $db): array { return array_merge(DEFAULT_FEATURES, $db['config']['features'] ?? []); }
function level_msgs(array $db): array { return array_merge(DEFAULT_LEVEL_MESSAGES, $db['config']['levelMessages'] ?? []); }
function gps_cfg(array $db): array { return array_merge(['warnM' => 400, 'dangerM' => 150, 'voice' => true], $db['config']['gps'] ?? []); }
function nocar_cfg(array $db): array { return is_array($db['config']['noCar'] ?? null) ? $db['config']['noCar'] : DEFAULT_NOCAR; }
function max_level(string $a, string $b): string { return LV[$a] >= LV[$b] ? $a : $b; }
// Fotos de los reportes: se guardan como archivos junto a la base de datos (data/photos)
function photos_dir(): string { return data_dir() . '/photos'; }
// En la base se guarda "/photos/x.jpg" (igual que Node); al entregarlo se antepone la subcarpeta si la app no está en la raíz
function base_path(): string { $b = rtrim(str_replace('\\', '/', dirname(dirname($_SERVER['SCRIPT_NAME'] ?? '/api/index.php'))), '/'); return $b === '.' ? '' : $b; }
function rep_out(array $r): array { if (!empty($r['photo']) && $r['photo'][0] === '/') $r['photo'] = base_path() . $r['photo']; return $r; }
function parse_photo($d): ?string {
  if (!is_string($d) || !preg_match('#^data:image/jpeg;base64,([A-Za-z0-9+/=]+)$#', $d, $m)) return null;
  $buf = base64_decode($m[1], true);
  if ($buf === false || strlen($buf) < 1000 || strlen($buf) > 2 * 1024 * 1024 || $buf[0] !== "\xFF" || $buf[1] !== "\xD8") return null;
  return $buf;
}

// ---------- Simulador de lluvia (vive en un archivo temporal; se apaga solo al terminar el tiempo) ----------
function sim_on(): ?array { $s = cache_get('sim'); if ($s && ($s['until'] ?? 0) > now_ms()) return $s; return null; }
function simulated_weather(?array $real): array {
  $s = sim_on();
  $w = ['ok' => true, 'source' => 'Simulación de prueba', 'simulated' => true, 'simUntil' => gmdate('c', (int)($s['until'] / 1000)), 'observedAt' => gmdate('c'),
    'temperature' => $real['temperature'] ?? 26, 'rainNow' => $s['rainNow'], 'rainPast3h' => $s['rainPast3h'], 'rainNext3h' => $s['rainNext3h'], 'rainNext24h' => $s['rainNext3h'] * 2,
    'probNext3h' => $s['probNext3h'], 'maxProbability24h' => $s['probNext3h'], 'cloudCover' => ($s['rainNow'] > 0 || $s['weatherCode']) ? 95 : 40, 'weatherCode' => $s['weatherCode'], 'hourly' => []];
  if (!empty($real['sun'])) $w['sun'] = array_merge($real['sun'], ['sky' => ($s['rainNow'] > 0 || $s['weatherCode'] >= 50) ? 'lluvia' : $real['sun']['sky']]);
  $w['hourly'] = $real['hourly'] ?? [];
  if ($s['rainNow'] > 0 && $w['hourly']) $w['hourly'] = array_merge([raining_now($w['hourly'][0], $s['rainNow'])], array_slice($w['hourly'], 1));
  $w['periods'] = day_parts($w['hourly']);
  $w['outlook'] = $s['rainNow'] > 0 ? ['level' => 'lloviendo', 'title' => 'Está lloviendo', 'text' => 'Revisa las calles inundadas y las vías alternas antes de salir.', 'reasons' => []] : ($real['outlook'] ?? null);
  return array_merge($w, describe($w));
}
function compute_status(): array {
  $db = db_load(); $cfg = $db['config']['weather'];
  $weather = get_weather(array_merge($cfg, ['metarStation' => $cfg['metarStation'] ?? 'SERO', 'owmKey' => AV_OWM_KEY ?: ($cfg['owmKey'] ?? '')]), local_sources($db['alert']['observed'] ?? null));
  $tide = get_tide($cfg);
  $flood = ($db['config']['floodEnabled'] ?? false) === true ? get_flood(array_merge($db['config']['center'], ['apiKey' => getenv('GOOGLE_FLOOD_KEY') ?: ($db['config']['googleFloodKey'] ?? '')])) : ['ok' => false, 'disabled' => true, 'gauges' => []];
  if (!sim_on()) note_observation($weather); // diario del clima (para mostrar "Ayer")
  else $weather = simulated_weather($weather);
  $db = db_load();
  $rivers = array_values(array_filter($db['rivers'] ?? [], fn($r) => ($r['active'] ?? true) !== false));
  $risk = risk_index($weather, $cfg, $flood, $tide, $rivers);
  // Un río crecido o desbordado sube el nivel por sí solo
  $over = count(array_filter($rivers, fn($r) => ($r['status'] ?? '') === 'desbordado')); $high = count(array_filter($rivers, fn($r) => ($r['status'] ?? '') === 'crecido'));
  $sev = !empty($flood['ok']) ? array_map(fn($g) => $g['severity'] ?? '', $flood['gauges'] ?? []) : [];
  $riverLevel = in_array('EXTREME', $sev, true) || $over >= 2 || ($over >= 1 && ($weather['intensity'] ?? 0) >= 2) ? 'roja'
    : (in_array('SEVERE', $sev, true) || $over >= 1 ? 'naranja' : (in_array('ABOVE_NORMAL', $sev, true) || $high >= 1 ? 'amarilla' : 'normal'));
  // El índice combinado no deja la roja con lluvia leve o sin lluvia: como mucho naranja
  $riskLevel = $risk['level'] === 'roja' && ($weather['intensity'] ?? 0) < 2 ? 'naranja' : $risk['level'];
  $wl = level_why($weather, $cfg);
  $suggested = max_level(max_level($wl['level'], $riskLevel), $riverLevel);
  $why = $suggested === 'normal' ? '' : (LV[$riverLevel] >= LV[$suggested] && $riverLevel !== 'normal'
    ? ($over ? ($over === 1 ? 'un río desbordado' : "$over ríos desbordados") . ($sev ? ' (o aviso de Google Flood)' : '') : ($high ? 'río crecido' : 'aviso de crecida de Google Flood'))
    : (LV[$wl['level']] >= LV[$suggested] ? $wl['why'] : "índice de riesgo {$risk['value']}/100 (lluvia, pronóstico, ríos y marea)"));
  // Durante una simulación el nivel publicado sigue al clima simulado, aunque la alerta esté en manual.
  // La simulación es solo una prueba: muestra el nivel simulado pero no deja huella (ni bajada gradual ni drenaje)
  $sim = (bool)sim_on();
  $effective = $sim ? $suggested : ($db['alert']['mode'] === 'manual' ? $db['alert']['level'] : step_down($suggested));
  $drain = $sim ? ['draining' => false, 'until' => null, 'reportOn' => LV[$effective] >= 2] : sync_auto_points($effective, $weather);
  // Bajada gradual: desde qué hora paró la lluvia intensa y a qué hora pasa a cada color
  $now = now_ms(); $a = db_load()['alert'];
  if (!$sim && ($weather['intensity'] ?? 0) >= 2 && $now - ($a['lastHeavyAt'] ?? 0) > 60000) { db_lock(); $d = &db(); $d['alert']['lastHeavyAt'] = $now; db_save(); $a['lastHeavyAt'] = $now; }
  $stepdown = null;
  if (!$sim && ($a['mode'] ?? 'auto') !== 'manual' && LV[$effective] > LV[$suggested]) {
    $hold = ((float)($db['config']['weather']['stepDownMin'] ?? 0) ?: 45) * 60000; $names = array_keys(LV); $steps = [];
    $t = max($now, ($a['autoStepAt'] ?? $now) + $hold);
    for ($l = LV[$effective] - 1; $l >= LV[$suggested]; $l--) { $steps[] = ['level' => $names[$l], 'at' => gmdate('Y-m-d\TH:i:s\Z', (int)($t / 1000))]; $t += $hold; }
    $stepdown = ['heavyEndAt' => !empty($a['lastHeavyAt']) && ($weather['intensity'] ?? 0) < 2 ? gmdate('Y-m-d\TH:i:s\Z', (int)($a['lastHeavyAt'] / 1000)) : null, 'steps' => $steps, 'everyMin' => $hold / 60000];
  }
  return compact('weather', 'suggested', 'effective', 'risk', 'tide', 'flood', 'drain', 'why', 'stepdown');
}
// Al dejar de llover el semáforo no cae de golpe: baja un color cada cierto tiempo (por defecto 45 min),
// porque el agua tarda en irse. Si vuelve a llover, sube de inmediato.
function step_down(string $suggested): string {
  $db = db_load(); $a = $db['alert']; $now = now_ms();
  $cur = isset(LV[$a['autoLevel'] ?? '']) ? $a['autoLevel'] : $suggested;
  $hold = ((float)($db['config']['weather']['stepDownMin'] ?? 0) ?: 45) * 60000;
  $next = $cur; $stepAt = $a['autoStepAt'] ?? 0;
  if (LV[$suggested] >= LV[$cur]) { $next = $suggested; $stepAt = $now; }
  elseif ($now - $stepAt >= $hold) { $next = array_search(LV[$cur] - 1, LV, true); $stepAt = $now; }
  // autoStepAt solo se guarda cuando cambia el nivel o cuando sube/se mantiene alto (cada minuto como mucho)
  if ($next !== ($a['autoLevel'] ?? null) || ($stepAt !== ($a['autoStepAt'] ?? 0) && $now - ($a['autoStepAt'] ?? 0) > 60000)) {
    db_lock(); $d = &db(); $d['alert']['autoLevel'] = $next; $d['alert']['autoStepAt'] = $stepAt; db_save();
  }
  return $next;
}
// Puntos automáticos (y sus vías alternas): se encienden solos con naranja/roja y siguen encendidos el tiempo de
// drenaje (por defecto 3 h) desde la última vez que hubo naranja/roja. Los que vienen de reportes ciudadanos
// (nivel medio) siguen hasta 2 h después de la última lluvia confirmada.
const REPORT_DRAIN_MS = 7200000, REPORT_TTL_MS = 3600000;
function sync_auto_points(string $effective, ?array $weather = null): array {
  $db = db_load(); $a = $db['alert']; $now = now_ms(); $ch = [];
  if (($weather['intensity'] ?? 0) > 0 && (empty($a['lastRainAt']) || $now - $a['lastRainAt'] > 60000)) $ch['lastRainAt'] = $now;
  $drainMs = ((float)($db['config']['weather']['drainHours'] ?? 3) ?: 0) * 3600000;
  if (LV[$effective] >= 2 && (empty($a['lastHighAt']) || $now - $a['lastHighAt'] > 60000)) $ch['lastHighAt'] = $now;
  $lastHigh = $ch['lastHighAt'] ?? ($a['lastHighAt'] ?? 0); $lastRain = $ch['lastRainAt'] ?? ($a['lastRainAt'] ?? 0);
  $until = $lastHigh ? $lastHigh + $drainMs : 0; $draining = LV[$effective] < 2 && $until > $now;
  $turnOff = LV[$effective] < 2 && $lastHigh && $until <= $now && empty($a['drainDone']);
  if ($turnOff) $ch['drainDone'] = true;
  if (LV[$effective] >= 2 && !empty($a['drainDone'])) $ch['drainDone'] = false;
  if (($a['lastEffective'] ?? null) !== $effective) $ch['lastEffective'] = $effective;
  if ($ch) {
    db_lock(); $d = &db(); $d['alert'] = array_merge($d['alert'], $ch);
    if ($turnOff) foreach ($d['points'] as &$p) if (!empty($p['auto']) && !empty($p['active'])) $p['active'] = false;
    unset($p); db_save();
  }
  $repEnd = $lastHigh && $now - $lastHigh < 12 * 3600000 ? max($lastHigh, $lastRain) + REPORT_DRAIN_MS : 0;
  return ['draining' => $draining, 'until' => $draining ? gmdate('Y-m-d\TH:i:s.000\Z', (int)($until / 1000)) : null, 'reportOn' => LV[$effective] >= 2 || $repEnd > $now];
}
// Avisos push: en cPanel no hay un proceso siempre encendido. Se revisan como mucho cada 5 minutos, con la tarea
// cron (cron.php) o, si no se configuró, aprovechando las visitas al mapa (después de enviar la respuesta).
function push_tick(?array $st = null): array {
  cache_put('pushtick', ['at' => now_ms()]);
  $st = $st ?? compute_status();
  return push_check_and_notify($st, level_msgs(db_load())[$st['effective']] ?? null, (bool)sim_on());
}
// Tras un cambio en la alerta desde el panel (simulación, lluvia marcada, modo, nivel) se revisan los avisos al instante
function push_tick_now(): void {
  register_shutdown_function(function () { if (function_exists('fastcgi_finish_request')) fastcgi_finish_request(); try { push_tick(); } catch (Throwable $e) { error_log('AlertaVial avisos: ' . $e->getMessage()); } });
}
function push_tick_maybe(array $st): void {
  $c = cache_get('pushtick'); if ($c && now_ms() - ($c['at'] ?? 0) < 300000) return;
  if (function_exists('fastcgi_finish_request')) fastcgi_finish_request();
  try { push_tick($st); } catch (Throwable $e) { error_log('AlertaVial avisos: ' . $e->getMessage()); }
}
function weather_out(array $w): array { $w['hourly'] = array_slice($w['hourly'] ?? [], 0, 25); return $w; }

// ---------- Enrutador ----------
if (defined('AV_NO_ROUTER')) return;
$method = $_SERVER['REQUEST_METHOD'];
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$i = strpos($path, '/api/'); $route = trim($i === false ? $path : substr($path, $i + 5), '/');
$seg = $route === '' ? [] : explode('/', $route);
if ($method === 'OPTIONS') { http_response_code(204); exit; }

try {
  if ($route === 'login' && $method === 'POST') {
    $b = body();
    if (AV_ADMIN_PASSWORD === 'CAMBIAR-ESTA-CLAVE') fail(403, 'Falta elegir la contraseña del administrador: edita config.php en el hosting y cambia AV_ADMIN_PASSWORD.');
    if (hash_equals(AV_ADMIN_USER, (string)($b['user'] ?? '')) && hash_equals(AV_ADMIN_PASSWORD, (string)($b['password'] ?? ''))) {
      $t = bin2hex(random_bytes(24)); $s = sessions_load(); $s[$t] = ['user' => AV_ADMIN_USER, 'at' => now_ms()]; sessions_save($s);
      out(['token' => $t, 'user' => AV_ADMIN_USER]);
    }
    usleep(400000); fail(401, 'Usuario o contraseña incorrectos. Revisa e intenta de nuevo.');
  }
  if ($route === 'logout' && $method === 'POST') { auth(); $s = sessions_load(); unset($s[bearer()]); sessions_save($s); out(['ok' => true]); }

  // ----- Pública -----
  if ($route === 'public/state' && $method === 'GET') {
    $st = compute_status(); $db = db_load(); $f = features_cfg($db); $effective = $st['effective']; $drain = $st['drain'];
    register_shutdown_function('push_tick_maybe', $st); // avisos push sin cron: cada 5 min como mucho, después de responder
    $on = fn($k, $list) => !empty($f[$k]) ? array_values($list) : [];
    // Un punto con "auto" se enciende con naranja o roja y sigue encendido mientras el agua drena.
    $pointOn = fn($p) => !empty($p['active']) || (!empty($p['auto']) && (($p['source'] ?? '') === 'reporte' ? $drain['reportOn'] : (LV[$effective] >= 2 || $drain['draining'])));
    $routeOn = function ($r) use ($db, $pointOn, $f) {
      if (empty($r['active'])) return false;
      foreach ($db['points'] as $p) if ($p['id'] === ($r['avoids'] ?? null)) return $pointOn($p) && $f['points'];
      foreach ($db['streets'] as $s) if ($s['id'] === ($r['avoids'] ?? null)) return !empty($s['active']) && ($s['status'] ?? '') !== 'despejada' && $f['streets'];
      return true;
    };
    $act = fn($x) => ($x['active'] ?? true) !== false;
    out(['config' => ['city' => $db['config']['city'], 'center' => $db['config']['center'], 'zoom' => $db['config']['zoom'], 'mapProvider' => $db['config']['mapProvider'], 'baseStyle' => $db['config']['baseStyle'] ?? 'osm', 'googleMapsKey' => $db['config']['googleMapsKey'] ?? '', 'mapVersion' => $db['config']['mapVersion'] ?? 0,
        'rainThresholdMm' => $db['config']['weather']['rainThresholdMm'], 'gps' => gps_cfg($db), 'levelMessages' => level_msgs($db), 'features' => $f, 'noCar' => nocar_cfg($db)],
      'alert' => array_merge($db['alert'], ['effective' => $effective, 'suggested' => $st['suggested'], 'why' => $st['why'], 'stepdown' => $st['stepdown'], 'draining' => (bool)$drain['draining'], 'drainUntil' => $drain['until']]),
      'weather' => weather_out($st['weather']), 'risk' => $st['risk'], 'tide' => $st['tide'], 'flood' => $st['flood'], 'cronAt' => cache_get('cron')['at'] ?? null,
      'layers' => $on('layers', array_filter($db['layers'] ?? [], $act)), 'rivers' => $on('rivers', array_filter($db['rivers'] ?? [], $act)), 'zones' => $on('rivers', array_filter($db['zones'] ?? [], $act)),
      'points' => $on('points', array_map(fn($p) => array_merge($p, ['active' => true]), array_filter($db['points'], $pointOn))),
      'streets' => $on('streets', array_filter($db['streets'], fn($s) => !empty($s['active']))), 'routes' => $on('routes', array_filter($db['routes'], $routeOn)),
      'recommendations' => $on('recommendations', array_filter($db['recommendations'], fn($r) => !empty($r['active'])))]);
  }
  if ($route === 'public/reports' && $method === 'POST') {
    $ip = $_SERVER['REMOTE_ADDR'] ?? '0'; $lim = cache_get('rl_' . md5($ip)) ?: ['t' => []];
    $recent = array_values(array_filter($lim['t'], fn($t) => now_ms() - $t < 600000));
    if (count($recent) >= 5) fail(429, 'Has enviado muchos reportes seguidos. Espera unos minutos.');
    if (empty(features_cfg(db_load())['reports'])) fail(403, 'Los reportes ciudadanos están desactivados por ahora.');
    $b = body();
    if (!is_num($b['lat'] ?? null) || !is_num($b['lng'] ?? null)) fail(400, 'Toca el mapa para indicar el lugar del reporte.');
    $photo = parse_photo($b['photo'] ?? null);
    if ($photo === null) fail(400, 'Adjunta una fotografía del lugar: es obligatoria para comprobar el reporte.');
    if (mb_strlen(trim((string)($b['description'] ?? ''))) < 5) fail(400, 'Describe brevemente qué está pasando (mínimo 5 letras).');
    db_lock(); $db = &db(); $db['reports'] ??= [];
    // la ciudadanía ya no elige gravedad: todo reporte aceptado es un punto crítico de nivel medio
    $r = ['id' => next_id('rep'), 'lat' => $b['lat'], 'lng' => $b['lng'], 'street' => s_val($b['street'] ?? '', 120), 'description' => s_val($b['description'], 400),
      'level' => 'moderado', 'type' => ($b['type'] ?? '') === 'desborde' ? 'desborde' : 'inundacion', 'status' => 'pendiente', 'createdAt' => now_iso()];
    $r['photo'] = '/photos/' . $r['id'] . '.jpg';
    @mkdir(photos_dir(), 0775, true);
    if (file_put_contents(photos_dir() . '/' . $r['id'] . '.jpg', $photo) === false) fail(500, 'No se pudo guardar la fotografía. Intenta otra vez.');
    $db['reports'][] = $r; db_save(); cache_put('rl_' . md5($ip), ['t' => array_merge($recent, [now_ms()])]);
    out(rep_out($r), 201);
  }
  if ($route === 'public/reports' && $method === 'GET') {
    $db = db_load(); $f = features_cfg($db); $ids = array_column($db['points'] ?? [], 'id');
    // Un reporte ya convertido en punto crítico no se muestra como reporte: lo representa el punto (solo con naranja/roja)
    out(array_map('rep_out', array_values(array_filter($db['reports'] ?? [], fn($r) => $r['status'] === 'verificado' && now_ms() - strtotime($r['createdAt']) * 1000 < REPORT_TTL_MS
      && !(!empty($r['pointId']) && in_array($r['pointId'], $ids, true)) && (($r['type'] ?? '') === 'desborde' ? $f['rivers'] : $f['reports'])))));
  }
  if (isset($_GET['photo']) && $method === 'GET' && $method === 'GET') {
    $n = (string)$_GET['photo']; $file = photos_dir() . '/' . $n;
    if (!preg_match('/^rep_[a-z0-9]+\.jpg$/', $n) || !is_file($file)) { http_response_code(404); exit; }
    header('Content-Type: image/jpeg'); header('Cache-Control: public, max-age=86400'); header('Content-Length: ' . filesize($file)); readfile($file); exit;
  }
  if ($route === 'public/rev' && $method === 'GET') out(['rev' => (cache_get('rev')['rev'] ?? 0), 'mapVersion' => db_load()['config']['mapVersion'] ?? 0]);
  if ($route === 'public/near' && $method === 'GET') {
    $lat = (float)($_GET['lat'] ?? 'x'); $lng = (float)($_GET['lng'] ?? 'x');
    if (!is_numeric($_GET['lat'] ?? null) || !is_numeric($_GET['lng'] ?? null) || abs($lat) > 90 || abs($lng) > 180) fail(400, 'Coordenadas inválidas');
    try { out(near_streets($lat, $lng)); } catch (Throwable $e) { out(['streets' => [], 'sector' => '']); }
  }
  // Puente para la versión en Render: entrega la respuesta de Open-Meteo (los 9 modelos) para el punto configurado.
  // Solo ese punto, con 10 min de caché: no sirve como proxy abierto y no gasta consultas de más.
  if ($route === 'public/om-relay' && $method === 'GET') {
    $f = data_dir() . '/cache/omrelay.json';
    if (!is_file($f) || time() - filemtime($f) > 600) {
      $cfg = db_load()['config']['weather'];
      $r = http_one(['url' => om_url($cfg['lat'], $cfg['lng'], implode(',', array_keys(MODELS))), 'timeout' => 10, 'headers' => ['user-agent' => AV_UA]]);
      if (!$r['err'] && $r['code'] === 200) @file_put_contents($f, $r['body']);
      elseif (!is_file($f)) fail(502, 'Open-Meteo no respondió');
    }
    $j = (string)@file_get_contents($f);
    http_response_code(200); header('Content-Type: application/json; charset=utf-8'); header('Cache-Control: public, max-age=300'); header('Access-Control-Allow-Origin: *');
    header('Content-Length: ' . strlen($j)); echo $j; exit;
  }
  if ($route === 'public/forecast-days' && $method === 'GET') { $cfg = db_load()['config']['weather']; out(with_history(get_days($cfg), $cfg)); }
  // Notificaciones push
  if ($route === 'public/push-key' && $method === 'GET') out(['key' => push_public_key()]);
  if ($route === 'public/push-subscribe' && $method === 'POST') { if (push_add_sub(body()['subscription'] ?? null)) out(['ok' => true]); fail(400, 'Suscripción no válida.'); }
  if ($route === 'public/push-unsubscribe' && $method === 'POST') { push_remove_sub((string)(body()['endpoint'] ?? '')); out(['ok' => true]); }
  if ($route === 'public/radar' && $method === 'GET') {
    $c = cache_get('radar'); if ($c && now_ms() - $c['at'] < 300000) out($c['data']);
    try {
      $j = http_json(http_one(['url' => 'https://api.rainviewer.com/public/weather-maps.json', 'timeout' => 8]));
      $past = $j['radar']['past'] ?? [];
      $data = ['ok' => true, 'frames' => array_map(fn($f) => ['time' => $f['time'], 'url' => $j['host'] . $f['path'] . '/256/{z}/{x}/{y}/2/1_1.png'], array_slice($past, -6))];
    } catch (Throwable $e) { $data = ['ok' => false, 'error' => $e->getMessage(), 'frames' => []]; }
    cache_put('radar', ['at' => now_ms(), 'data' => $data]); out($data);
  }

  // ----- Administración -----
  if ($seg && $seg[0] === 'admin') { auth(); if ($method !== 'GET') $GLOBALS['BUMP_REV'] = true; admin_routes($method, array_slice($seg, 1)); }
  fail(404, 'Ruta no encontrada.');
} catch (Throwable $e) { error_log('AlertaVial: ' . $e->getMessage()); fail(500, 'Ocurrió un error inesperado en el servidor.'); }

function pick(array $obj, array $fields): array { $o = []; foreach ($fields as $f) if (array_key_exists($f, $obj)) $o[$f] = $obj[$f]; return $o; }
function validate_item(string $name, array $it): ?string {
  $empty = fn($k) => !isset($it[$k]) || $it[$k] === '' || $it[$k] === null;
  $cnt = fn($k) => is_array($it[$k] ?? null) ? count($it[$k]) : 0;
  if ($name === 'points') { if ($empty('name')) return 'Escribe un nombre para el punto crítico.'; if (!is_num($it['lat'] ?? null) || !is_num($it['lng'] ?? null)) return 'Haz clic en el mapa para ubicar el punto.'; }
  if ($name === 'streets' || $name === 'routes') { if ($empty('name')) return 'Escribe el nombre de la calle o ruta.'; if ($cnt('coords') < 2) return 'Dibuja al menos dos puntos sobre el mapa.'; }
  if ($name === 'rivers') { if ($empty('name')) return 'Escribe el nombre del río o canal.'; if ($cnt('coords') < 2) return 'Dibuja el cauce con al menos dos puntos sobre el mapa.'; }
  if ($name === 'zones') { if ($empty('name')) return 'Escribe un nombre para la zona de desborde.'; if ($cnt('coords') < 3) return 'Marca al menos tres puntos para cerrar el área de desborde.'; }
  if ($name === 'recommendations' && $empty('text')) return 'Escribe el texto de la recomendación.';
  if ($name === 'layers') {
    if ($empty('name')) return 'Escribe un nombre para la capa.';
    $g = $it['geojson'] ?? null;
    if (!is_array($g) || ($g['type'] ?? '') !== 'FeatureCollection' || !is_array($g['features'] ?? null)) return 'El archivo no tiene un formato de capa válido (GeoJSON FeatureCollection).';
    if (!count($g['features'])) return 'La capa no tiene elementos.';
  }
  return null;
}

function admin_routes(string $method, array $seg): void {
  $r = implode('/', $seg); $b = body();
  if ($r === 'state' && $method === 'GET') {
    $st = compute_status(); $db = db_load(); $drain = $st['drain']; $eff = $st['effective'];
    unset($db['push']);
    $dpts = LV[$eff] < 2 ? count(array_filter($db['points'], fn($p) => !empty($p['auto']) && (($p['source'] ?? '') === 'reporte' ? $drain['reportOn'] : $drain['draining']))) : 0;
    out(array_merge($db, ['pushCount' => push_count(), 'cronAt' => cache_get('cron')['at'] ?? null, 'config' => array_merge($db['config'], ['gps' => gps_cfg($db), 'levelMessages' => level_msgs($db), 'features' => features_cfg($db), 'noCar' => nocar_cfg($db)]),
      'alert' => array_merge($db['alert'], ['effective' => $eff, 'suggested' => $st['suggested'], 'why' => $st['why'], 'stepdown' => $st['stepdown'], 'draining' => $drain['draining'] || (LV[$eff] < 2 && $drain['reportOn']), 'drainUntil' => $drain['until'], 'drainPoints' => $dpts]), 'weather' => weather_out($st['weather']), 'risk' => $st['risk'], 'tide' => $st['tide'],
      'reports' => array_map('rep_out', $db['reports'] ?? []), 'layers' => $db['layers'] ?? [], 'rivers' => $db['rivers'] ?? [], 'zones' => $db['zones'] ?? []]));
  }
  if ($r === 'config' && $method === 'PUT') {
    db_lock(); $db = &db(); $c = $b;
    if (!empty($c['city'])) $db['config']['city'] = s_val($c['city'], 80);
    if (!empty($c['center'])) $db['config']['center'] = ['lat' => (float)$c['center']['lat'], 'lng' => (float)$c['center']['lng']];
    if (!empty($c['zoom'])) $db['config']['zoom'] = (int)$c['zoom'];
    if (!empty($c['mapProvider'])) $db['config']['mapProvider'] = $c['mapProvider'] === 'google' ? 'google' : 'leaflet';
    if (array_key_exists('baseStyle', $c)) $db['config']['baseStyle'] = in_array($c['baseStyle'], ['osm', 'hot', 'osmfr'], true) ? $c['baseStyle'] : 'osm';
    if (array_key_exists('googleMapsKey', $c)) $db['config']['googleMapsKey'] = trim((string)$c['googleMapsKey']);
    if (!empty($c['features']) && is_array($c['features'])) { $f = []; foreach (DEFAULT_FEATURES as $k => $_) $f[$k] = ($c['features'][$k] ?? true) !== false; $db['config']['features'] = $f; }
    if (array_key_exists('noCar', $c)) {
      $list = is_array($c['noCar']) ? $c['noCar'] : preg_split('/\n|,/', (string)$c['noCar']);
      $db['config']['noCar'] = array_slice(array_values(array_unique(array_filter(array_map(fn($x) => s_val(trim((string)$x), 60), $list), fn($x) => $x !== ''))), 0, 40);
    }
    if (array_key_exists('floodEnabled', $c)) $db['config']['floodEnabled'] = $c['floodEnabled'] === true;
    if (array_key_exists('googleFloodKey', $c)) $db['config']['googleFloodKey'] = trim((string)$c['googleFloodKey']);
    if (!empty($c['levelMessages'])) { $m = []; foreach (DEFAULT_LEVEL_MESSAGES as $k => $d) { $v = s_val(trim((string)($c['levelMessages'][$k] ?? '')), 300); $m[$k] = $v !== '' ? $v : $d; } $db['config']['levelMessages'] = $m; }
    if (!empty($c['gps'])) $db['config']['gps'] = ['warnM' => max(50, (int)($c['gps']['warnM'] ?? 0) ?: 400), 'dangerM' => max(20, (int)($c['gps']['dangerM'] ?? 0) ?: 150), 'voice' => ($c['gps']['voice'] ?? true) !== false];
    if (!empty($c['weather']) && is_array($c['weather'])) {
      $o = $db['config']['weather']; $w = $c['weather'];
      $db['config']['weather'] = array_merge($o, $w, ['lat' => (float)($w['lat'] ?? $o['lat']), 'lng' => (float)($w['lng'] ?? $o['lng']),
        'rainThresholdMm' => (float)($w['rainThresholdMm'] ?? $o['rainThresholdMm']), 'rainThresholdMm3h' => (float)($w['rainThresholdMm3h'] ?? $o['rainThresholdMm3h']),
        'stepDownMin' => max(5, min(360, (float)($w['stepDownMin'] ?? $o['stepDownMin'] ?? 45) ?: 45)), 'drainHours' => max(0, min(48, (float)($w['drainHours'] ?? $o['drainHours'] ?? 3) ?: 0)),
        'metarStation' => substr(preg_replace('/[^A-Z0-9]/', '', strtoupper(trim((string)($w['metarStation'] ?? $o['metarStation'] ?? 'SERO')))), 0, 4),
        'owmKey' => s_val(trim((string)($w['owmKey'] ?? $o['owmKey'] ?? '')), 64)]);
    }
    db_save(); out($db['config']);
  }
  // "El agua ya bajó": termina el drenaje antes de lo previsto y apaga los puntos críticos automáticos
  if ($r === 'drain-end' && $method === 'POST') {
    $st = compute_status(); if (LV[$st['effective']] >= 2) fail(400, 'La alerta sigue en naranja o roja: los puntos críticos deben seguir activos.');
    db_lock(); $db = &db(); $db['alert']['lastHighAt'] = null; $db['alert']['lastRainAt'] = null; $db['alert']['drainDone'] = true; $n = 0;
    foreach ($db['points'] as &$p) if (!empty($p['auto']) && !empty($p['active'])) { $p['active'] = false; $n++; }
    unset($p); db_save(); out(['ok' => true, 'turnedOff' => $n]);
  }
  // "Volver al clima real": apaga todas las pruebas de una vez y publica lo que dice el clima real
  if ($r === 'reset-real' && $method === 'POST') { push_tick_now();
    $done = []; if (sim_on()) $done[] = 'simulación de lluvia'; @unlink(data_dir() . '/cache/sim.json');
    db_lock(); $db = &db(); $a = &$db['alert'];
    if (!empty($a['observed'])) { $done[] = !empty($a['observed']['dry']) ? '"no llueve" marcado por el equipo' : 'lluvia marcada por el equipo'; unset($a['observed']); }
    if (($a['mode'] ?? '') === 'manual') { $done[] = 'modo manual'; $a['mode'] = 'auto'; }
    unset($a['autoLevel']); $a['autoStepAt'] = now_ms(); unset($a); db_save();
    $st = compute_status(); $off = 0;
    db_lock(); $db = &db();
    if (LV[$st['effective']] < 2) {
      $db['alert']['lastHighAt'] = null; $db['alert']['lastRainAt'] = null; $db['alert']['drainDone'] = true;
      foreach ($db['points'] as &$p) if (!empty($p['auto']) && !empty($p['active'])) { $p['active'] = false; $off++; }
      unset($p); if ($off) $done[] = "$off punto(s) crítico(s) encendidos";
    }
    $db['alert']['updatedAt'] = now_iso(); db_save();
    out(['ok' => true, 'done' => $done, 'effective' => $st['effective']]);
  }
  // "Actualizar mapa": sube un número de versión; los teléfonos lo notan y renuevan sus archivos y cuadros guardados.
  if ($r === 'map-refresh' && $method === 'POST') { db_lock(); $db = &db(); $db['config']['mapVersion'] = now_ms(); db_save(); out(['ok' => true, 'mapVersion' => $db['config']['mapVersion']]); }
  if ($r === 'push/test' && $method === 'POST') out(push_send_all(['title' => 'Prueba de avisos', 'body' => 'Si ves esto, las notificaciones funcionan en este teléfono.', 'tag' => 'prueba']));
  if ($r === 'backup' && $method === 'GET') {
    $db = db_load(); header('Content-Type: application/json'); header('Content-Disposition: attachment; filename="alertavial-respaldo-' . gmdate('Y-m-d-H-i') . '.json"');
    echo json_encode($db, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT); exit;
  }
  if ($r === 'restore' && $method === 'POST') {
    $ok = isset($b['config'], $b['alert']); foreach (['points', 'streets', 'routes', 'recommendations'] as $k) $ok = $ok && is_array($b[$k] ?? null);
    if (!$ok) fail(400, 'El archivo no es un respaldo del Sistema de Alerta Vial.');
    db_reset($b); @unlink(data_dir() . '/cache/sim.json');
    $counts = []; foreach (['points', 'streets', 'routes', 'rivers', 'zones', 'layers', 'reports'] as $k) $counts[$k] = count($b[$k] ?? []);
    out(['ok' => true, 'counts' => $counts]);
  }
  if ($r === 'observed' && $method === 'PUT') { push_tick_now();
    db_lock(); $db = &db(); $i = (int)round((float)($b['intensity'] ?? 0)); $dry = !empty($b['dry']);
    if (!$i && !$dry) unset($db['alert']['observed']);
    else $db['alert']['observed'] = ['intensity' => $dry ? 0 : max(1, min(4, $i))] + ($dry ? ['dry' => true] : []) + ['at' => now_iso(), 'until' => gmdate('Y-m-d\TH:i:s', time() + (int)max(15, min(720, (float)($b['minutes'] ?? 0) ?: 120)) * 60) . '.000Z'];
    db_save(); out($db['alert']['observed'] ?? ['intensity' => 0]);
  }
  if ($r === 'simulation' && $method === 'GET') out(sim_on() ?: ['active' => false]);
  if ($r === 'simulation' && $method === 'PUT') { push_tick_now();
    if (empty($b['active'])) { @unlink(data_dir() . '/cache/sim.json'); db_lock(); $db = &db(); unset($db['alert']['autoLevel']); $db['alert']['autoStepAt'] = now_ms(); db_save(); out(['active' => false]); }
    $n = fn($v, $max) => max(0, min($max, (float)$v));
    $s = ['active' => true, 'preset' => s_val($b['preset'] ?? 'manual', 30), 'rainNow' => $n($b['rainNow'] ?? 0, 200), 'rainPast3h' => $n($b['rainPast3h'] ?? 0, 500), 'rainNext3h' => $n($b['rainNext3h'] ?? 0, 500),
      'probNext3h' => $n($b['probNext3h'] ?? 0, 100), 'weatherCode' => (int)round($n($b['weatherCode'] ?? 0, 99)), 'until' => now_ms() + (int)max(1, min(240, (float)($b['minutes'] ?? 0) ?: 30)) * 60000];
    cache_put('sim', $s); out($s);
  }
  if ($r === 'alert' && $method === 'PUT') { push_tick_now();
    db_lock(); $db = &db();
    if (!empty($b['mode'])) $db['alert']['mode'] = $b['mode'] === 'manual' ? 'manual' : 'auto';
    // Al pasar a automático: el semáforo sigue de inmediato al pronóstico y se apaga la simulación de lluvia
    $simStopped = false;
    if (($b['mode'] ?? '') === 'auto') { $simStopped = (bool)sim_on(); @unlink(data_dir() . '/cache/sim.json'); unset($db['alert']['autoLevel']); $db['alert']['autoStepAt'] = now_ms(); }
    if (!empty($b['level']) && isset(LV[$b['level']])) $db['alert']['level'] = $b['level'];
    if (array_key_exists('message', $b)) $db['alert']['message'] = s_val($b['message'], 300);
    $db['alert']['updatedAt'] = now_iso(); db_save(); out($db['alert'] + ['simStopped' => $simStopped]);
  }
  // Reportes ciudadanos
  if ($seg && $seg[0] === 'reports' && count($seg) === 2) {
    db_lock(); $db = &db(); $id = $seg[1];
    if ($method === 'PUT') {
      foreach ($db['reports'] as &$rep) if ($rep['id'] === $id) {
        if (in_array($b['status'] ?? '', ['pendiente', 'verificado', 'descartado', 'retirado'], true)) $rep['status'] = $b['status'];
        if (is_string($b['pointId'] ?? null)) $rep['pointId'] = substr($b['pointId'], 0, 40); // punto crítico creado a partir de este reporte
        $rep['reviewedAt'] = now_iso(); if ($rep['status'] === 'retirado') $rep['clearedAt'] = $rep['reviewedAt'];
        db_save(); out(rep_out($rep));
      }
      fail(404, 'No se encontró el reporte.');
    }
    if ($method === 'DELETE') {
      $db['reports'] = array_values(array_filter($db['reports'] ?? [], fn($x) => $x['id'] !== $id)); db_save();
      if (preg_match('/^rep_[a-z0-9]+$/', $id)) @unlink(photos_dir() . "/$id.jpg");
      out(['ok' => true]);
    }
  }
  // CRUD genérico
  $name = $seg[0] ?? '';
  if (isset(COLLECTIONS[$name])) {
    [$prefix, $fields] = COLLECTIONS[$name];
    if (count($seg) === 2 && $seg[1] === 'bulk' && $method === 'PUT') {
      db_lock(); $db = &db(); $db[$name] ??= []; $n = 0;
      foreach ($db[$name] as &$it) {
        if (is_array($b['ids'] ?? null) && !in_array($it['id'], $b['ids'], true)) continue;
        if (is_bool($b['active'] ?? null)) $it['active'] = $b['active'];
        if ($name === 'points' && is_bool($b['auto'] ?? null)) $it['auto'] = $b['auto'];
        $it['updatedAt'] = now_iso(); $n++;
      }
      db_save(); out(['ok' => true, 'updated' => $n]);
    }
    if (count($seg) === 1 && $method === 'POST') {
      db_lock(); $db = &db(); $db[$name] ??= [];
      $it = pick($b, $fields); $err = validate_item($name, $it); if ($err) fail(400, $err);
      $it['id'] = next_id($prefix); $it['active'] = ($it['active'] ?? true) !== false; $it['createdAt'] = now_iso();
      $db[$name][] = $it; db_save(); out($it, 201);
    }
    if (count($seg) === 2 && $method === 'PUT') {
      db_lock(); $db = &db(); $db[$name] ??= [];
      foreach ($db[$name] as $i => $x) if ($x['id'] === $seg[1]) {
        $merged = array_merge($x, pick($b, $fields), ['updatedAt' => now_iso()]);
        $err = validate_item($name, $merged); if ($err) fail(400, $err);
        $db[$name][$i] = $merged; db_save(); out($merged);
      }
      fail(404, 'No se encontró el elemento.');
    }
    if (count($seg) === 2 && $method === 'DELETE') {
      db_lock(); $db = &db(); $db[$name] ??= []; $before = count($db[$name]);
      $db[$name] = array_values(array_filter($db[$name], fn($x) => $x['id'] !== $seg[1]));
      if (count($db[$name]) === $before) fail(404, 'No se encontró el elemento.');
      db_save(); out(['ok' => true]);
    }
  }
  fail(404, 'Ruta no encontrada.');
}
