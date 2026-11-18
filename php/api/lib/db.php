<?php
// Base de datos en un archivo JSON (igual que la versión Node) + caché y sesiones en archivos,
// porque PHP no conserva memoria entre visitas.
function data_dir(): string { static $d = null; if ($d === null) { $d = rtrim(AV_DATA_DIR, '/'); if (!is_dir($d)) @mkdir($d, 0775, true); if (!is_dir("$d/cache")) @mkdir("$d/cache", 0775, true); } return $d; }
function db_path(): string { return data_dir() . '/db.json'; }

function empty_db(): array {
  return ['config' => ['city' => 'Santa Rosa, El Oro', 'center' => ['lat' => -3.459603, 'lng' => -79.965844], 'zoom' => 15, 'mapProvider' => 'leaflet', 'googleMapsKey' => '',
      'gps' => ['warnM' => 400, 'dangerM' => 150, 'voice' => true],
      'weather' => ['lat' => -3.459603, 'lng' => -79.965844, 'rainThresholdMm' => 5, 'rainThresholdMm3h' => 15, 'autoMode' => true]],
    'alert' => ['level' => 'normal', 'mode' => 'auto', 'message' => '', 'updatedAt' => gmdate('c')],
    'points' => [], 'streets' => [], 'routes' => [], 'recommendations' => [], 'layers' => [], 'rivers' => [], 'zones' => [], 'reports' => []];
}
$GLOBALS['AV_DB'] = null; $GLOBALS['AV_LOCK'] = null;
function db_lock(): void {
  if ($GLOBALS['AV_LOCK']) return;
  $f = fopen(data_dir() . '/db.lock', 'c'); flock($f, LOCK_EX); $GLOBALS['AV_LOCK'] = $f; $GLOBALS['AV_DB'] = null; // se vuelve a leer ya con el candado
}
function db_load(): array {
  if ($GLOBALS['AV_DB'] !== null) return $GLOBALS['AV_DB'];
  $p = db_path();
  if (!file_exists($p)) {
    db_lock();
    $initial = __DIR__ . '/../../data/initial.json';
    $d = file_exists($initial) ? json_decode(file_get_contents($initial), true) : null;
    $GLOBALS['AV_DB'] = is_array($d) && isset($d['config']) ? $d : empty_db();
    db_save();
  } else {
    $GLOBALS['AV_DB'] = json_decode(file_get_contents($p), true) ?: empty_db();
  }
  return $GLOBALS['AV_DB'];
}
function &db(): array { db_load(); return $GLOBALS['AV_DB']; }
function db_save(): void {
  db_lock();
  $tmp = db_path() . '.tmp';
  file_put_contents($tmp, json_encode($GLOBALS['AV_DB'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT));
  rename($tmp, db_path());
}
function db_reset(array $d): void { db_lock(); $GLOBALS['AV_DB'] = $d; db_save(); }
function next_id(string $prefix): string { return $prefix . '_' . base_convert((string)(int)(microtime(true) * 1000), 10, 36) . substr(base_convert((string)mt_rand(0, 1679615), 10, 36) . 'xxxx', 0, 4); }

// Caché en archivos (clave -> valor con hora)
function cache_get(string $name) { $f = data_dir() . "/cache/$name.json"; if (!file_exists($f)) return null; $j = json_decode((string)@file_get_contents($f), true); return is_array($j) ? $j : null; }
function cache_put(string $name, array $v): void { $f = data_dir() . "/cache/$name.json"; @file_put_contents($f . '.tmp', json_encode($v, JSON_UNESCAPED_UNICODE)); @rename($f . '.tmp', $f); }
function now_ms(): int { return (int)(microtime(true) * 1000); }

// Sesiones del administrador (token -> usuario), vencen a las 12 h
function sessions_load(): array { $f = data_dir() . '/sessions.json'; $s = file_exists($f) ? json_decode((string)file_get_contents($f), true) : []; $s = is_array($s) ? $s : []; foreach ($s as $t => $v) if (now_ms() - ($v['at'] ?? 0) > 12 * 3600e3) unset($s[$t]); return $s; }
function sessions_save(array $s): void { file_put_contents(data_dir() . '/sessions.json', json_encode($s)); }
