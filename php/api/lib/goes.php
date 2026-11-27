<?php
// Satélite GOES-19 (NOAA) leído directamente desde PHP, sin servicios intermedios. Datos públicos y gratuitos en AWS, sin clave.
//  · Altura de la cima de las nubes (ABI-L2-ACHAF, cada 10 min, ~10 km por píxel): reemplaza al radar en Ecuador.
//  · Rayos (GLM-L2-LCFA, un archivo cada 20 s): detector de rayos, como en la versión Node.
// Mismas reglas y textos que server/sat.js y server/glm.js.
require_once __DIR__ . '/h5.php';

const GOES_BUCKET = 'noaa-goes19';
const SAT = ['cityKm' => 12, 'nearKm' => 40, 'stormKm' => 12, 'clearKm' => 2.5, 'maxAgeMin' => 40, 'box' => 1.0, 'png' => 28];
// Proyección fija de GOES-East (guía PUG vol. 4) y rejilla de 10 km del disco completo
const GOES_PROJ = ['a' => 6378137.0, 'b' => 6356752.31414, 'H' => 42164160.0, 'lon0' => -75.0];
const ACHA_GRID = ['xs' => 0.0002800000074785203, 'xo' => -0.15189999341964722, 'ys' => -0.0002800000074785203, 'yo' => 0.15189999341964722, 'n' => 1086, 'scale' => 0.30520370602607727, 'fill' => 65535];

function goes_prefix(string $product, int $ms): string {
  $t = intdiv($ms, 1000); return "$product/" . gmdate('Y', $t) . '/' . str_pad((string)(gmdate('z', $t) + 1), 3, '0', STR_PAD_LEFT) . '/' . gmdate('H', $t) . '/';
}
function goes_time(string $key): int { // inicio del barrido, en ms
  if (!preg_match('/_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})(\d)/', $key, $m)) return 0;
  return (gmmktime(0, 0, 0, 1, 1, (int)$m[1]) + ((int)$m[2] - 1) * 86400 + (int)$m[3] * 3600 + (int)$m[4] * 60 + (int)$m[5]) * 1000 + (int)$m[6] * 100;
}
function goes_list(array $prefixes): array {
  $reqs = []; foreach ($prefixes as $i => $p) $reqs[$i] = ['url' => 'https://' . GOES_BUCKET . '.s3.amazonaws.com/?list-type=2&prefix=' . rawurlencode($p), 'timeout' => 10];
  $keys = [];
  foreach (http_multi($reqs) as $r) if (!$r['err'] && $r['code'] === 200 && preg_match_all('#<Key>([^<]+)</Key>#', $r['body'], $m)) array_push($keys, ...$m[1]);
  sort($keys); return $keys;
}
function goes_km(float $la1, float $lo1, float $la2, float $lo2): float {
  $r = M_PI / 180; $h = sin(($la2 - $la1) * $r / 2) ** 2 + cos($la1 * $r) * cos($la2 * $r) * sin(($lo2 - $lo1) * $r / 2) ** 2; return 12742 * asin(sqrt($h));
}

// ---------- Nubes (altura de la cima) ----------
function goes_rc(float $lat, float $lng): array {
  $p = GOES_PROJ; $g = ACHA_GRID; $r = M_PI / 180; $e2 = 1 - ($p['b'] ** 2) / ($p['a'] ** 2);
  $pc = atan(($p['b'] ** 2) / ($p['a'] ** 2) * tan($lat * $r)); $rc = $p['b'] / sqrt(1 - $e2 * cos($pc) ** 2); $dl = ($lng - $p['lon0']) * $r;
  $sx = $p['H'] - $rc * cos($pc) * cos($dl); $sy = -$rc * cos($pc) * sin($dl); $sz = $rc * sin($pc);
  $x = asin(-$sy / sqrt($sx * $sx + $sy * $sy + $sz * $sz)); $y = atan($sz / $sx);
  return [(int)round(($y - $g['yo']) / $g['ys']), (int)round(($x - $g['xo']) / $g['xs'])];
}
// Lee el recuadro alrededor de la ciudad: devuelve una función (lat, lng) → km (null = sin nube)
function goes_heights(string $file, float $lat, float $lng): callable {
  $a = h5_find($file, 'HT'); if (!$a) throw new Exception('archivo del satélite sin altura de nubes');
  $d = h5_dataset($file, $a); $b = SAT['box'];
  $cs = array_map(fn($c) => goes_rc($c[0], $c[1]), [[$lat - $b, $lng - $b], [$lat - $b, $lng + $b], [$lat + $b, $lng - $b], [$lat + $b, $lng + $b]]);
  $n = ACHA_GRID['n'];
  $r0 = max(0, min(array_column($cs, 0)) - 1); $r1 = min($n - 1, max(array_column($cs, 0)) + 1);
  $c0 = max(0, min(array_column($cs, 1)) - 1); $c1 = min($n - 1, max(array_column($cs, 1)) + 1);
  if ($r1 <= $r0 || $c1 <= $c0) throw new Exception('la ciudad queda fuera de la vista del satélite');
  $blk = h5_read($file, $d, [$r0, $r1, $c0, $c1]); $w = $c1 - $c0 + 1;
  return function (float $la, float $lo) use ($blk, $r0, $r1, $c0, $c1, $w) {
    [$r, $c] = goes_rc($la, $lo); if ($r < $r0 || $r > $r1 || $c < $c0 || $c > $c1) return null;
    $v = $blk[($r - $r0) * $w + ($c - $c0)];
    return $v === null || $v === ACHA_GRID['fill'] ? null : round($v * ACHA_GRID['scale'] / 100) / 10;
  };
}
function goes_summary(callable $hAt, float $lat, float $lng): array {
  $kmLng = 111 * cos($lat * M_PI / 180); $n = 0; $cloud = 0; $deep = 0; $max = 0; $nearMax = 0; $nearStorm = null;
  for ($dy = -SAT['nearKm']; $dy <= SAT['nearKm']; $dy += 3) for ($dx = -SAT['nearKm']; $dx <= SAT['nearKm']; $dx += 3) {
    $d = hypot($dx, $dy); if ($d > SAT['nearKm']) continue;
    $h = $hAt($lat + $dy / 111, $lng + $dx / $kmLng) ?? 0;
    if ($d <= SAT['cityKm']) { $n++; if ($h >= SAT['clearKm']) $cloud++; if ($h >= SAT['stormKm']) $deep++; $max = max($max, $h); }
    else $nearMax = max($nearMax, $h);
    if ($h >= SAT['stormKm'] && ($nearStorm === null || $d < $nearStorm)) $nearStorm = (int)round($d);
  }
  return ['topKm' => $max, 'nearTopKm' => max($nearMax, $max), 'clear' => $n > 0 && $cloud === 0, 'storm' => $n > 0 && $deep * 2 >= $n,
    'stormKm' => $nearStorm, 'cloudShare' => $n ? (int)round($cloud / $n * 100) : 0];
}
// Imagen para el mapa (Mercator, colores por altura de la cima; transparente = despejado o nubes bajas)
function goes_png(callable $hAt, float $lat, float $lng): ?string {
  if (!function_exists('imagecreatetruecolor')) return null;
  $S = SAT['png']; $b = SAT['box']; $r = M_PI / 180;
  $COL = [[14, [224, 24, 45, 210]], [12, [255, 138, 0, 190]], [9, [255, 213, 74, 150]], [6, [127, 179, 255, 115]], [3, [255, 255, 255, 70]]];
  $im = imagecreatetruecolor($S, $S); imagealphablending($im, false); imagesavealpha($im, true);
  imagefill($im, 0, 0, imagecolorallocatealpha($im, 0, 0, 0, 127));
  $my = fn($la) => log(tan(M_PI / 4 + $la * $r / 2)); $top = $my($lat + $b); $bot = $my($lat - $b);
  for ($y = 0; $y < $S; $y++) {
    $la = (2 * atan(exp($top - ($y + 0.5) / $S * ($top - $bot))) - M_PI / 2) / $r;
    for ($x = 0; $x < $S; $x++) {
      $h = $hAt($la, $lng - $b + ($x + 0.5) / $S * 2 * $b) ?? 0;
      foreach ($COL as [$min, $c]) if ($h >= $min) { imagesetpixel($im, $x, $y, imagecolorallocatealpha($im, $c[0], $c[1], $c[2], 127 - (int)round($c[3] / 255 * 127))); break; }
    }
  }
  ob_start(); imagepng($im); imagedestroy($im); return ob_get_clean();
}
function sat_detail(array $s, int $ageMin): string {
  $txt = !empty($s['clear']) ? 'Sin nubes de lluvia sobre la ciudad (despejado o solo nubes bajas)'
    : (!empty($s['storm']) ? "Nubes de tormenta sobre la ciudad (cima a ~{$s['topKm']} km)"
    : "Nubes sobre la ciudad con cima a ~{$s['topKm']} km" . ($s['topKm'] >= 7 ? ' (nubes altas: pueden ser solo cirros, que no llueven)' : ''));
  $near = empty($s['storm']) && ($s['stormKm'] ?? null) !== null ? " · nubes de tormenta a ~{$s['stormKm']} km" : '';
  return "$txt$near · el satélite ve las nubes desde arriba, no mide la lluvia · imagen de hace $ageMin min";
}
// Revisa si hay imagen nueva (como mucho cada 4 min) y devuelve la fuente para el clima
function goes_sat(float $lat, float $lng): array {
  $base = ['id' => 'satelite', 'kind' => 'observación', 'name' => 'Satélite GOES-19 (nubes de tormenta)', 'intensity' => 0, 'rainNow' => 0];
  $now = now_ms(); $c = cache_get('goessat') ?: []; $key = round($lat, 2) . ',' . round($lng, 2);
  if (($c['pt'] ?? '') !== $key || $now - ($c['checked'] ?? 0) > 240000) {
    $c['checked'] = $now;
    try {
      $keys = goes_list([goes_prefix('ABI-L2-ACHAF', $now - 3600000), goes_prefix('ABI-L2-ACHAF', $now)]);
      $k = end($keys);
      if (!$k || $now - goes_time($k) > 3600000) throw new Exception('el satélite no publica datos recientes');
      if ($k !== ($c['key'] ?? '') || ($c['pt'] ?? '') !== $key) {
        $r = http_one(['url' => 'https://' . GOES_BUCKET . '.s3.amazonaws.com/' . $k, 'timeout' => 25]);
        if ($r['err'] || $r['code'] !== 200) throw new Exception($r['err'] ?: "descarga {$r['code']}");
        $hAt = goes_heights($r['body'], round($lat, 2), round($lng, 2));
        $png = goes_png($hAt, round($lat, 2), round($lng, 2));
        if ($png) @file_put_contents(data_dir() . '/cache/sat.png', $png);
        $c = array_merge($c, ['key' => $k, 'at' => goes_time($k), 'pt' => $key, 'sum' => goes_summary($hAt, round($lat, 2), round($lng, 2)), 'png' => (bool)$png, 'error' => '']);
      }
    } catch (Throwable $e) { $c['error'] = $e->getMessage(); }
    cache_put('goessat', $c);
  }
  if (empty($c['sum']) || ($c['pt'] ?? '') !== $key) return $base + ['ok' => false, 'error' => ($c['error'] ?? '') ?: 'sin datos del satélite'];
  $img = !empty($c['png']) ? ['url' => '/api/public/sat.png?t=' . intdiv($c['at'], 1000), 'bounds' => [[round($lat, 2) - SAT['box'], round($lng, 2) - SAT['box']], [round($lat, 2) + SAT['box'], round($lng, 2) + SAT['box']]]] : null;
  return $base + ['ok' => true, 'at' => gmdate('c', intdiv($c['at'], 1000))] + $c['sum'] + ['image' => $img];
}
// Antigüedad y texto se calculan al usarlo (el dato queda guardado unos minutos)
function sat_fresh(?array $s): ?array {
  if (!$s) return null;
  if (empty($s['ok'])) return $s;
  $age = (int)round((time() - strtotime($s['at'])) / 60);
  if ($age > SAT['maxAgeMin']) return array_merge($s, ['ok' => false, 'error' => "la última imagen del satélite es de hace $age min"]);
  return array_merge($s, ['detail' => sat_detail($s, $age)]);
}
function sat_dry($sat): bool { return !empty($sat['ok']) && !empty($sat['clear']) && !(($sat['stormKm'] ?? null) !== null && $sat['stormKm'] <= 25); }
function sat_wet($sat): bool { return !empty($sat['ok']) && !empty($sat['storm']); }

// ---------- Rayos (GLM) ----------
// Se guardan solo los rayos a menos de 60 km de los últimos 30 min. Cada consulta lee los archivos nuevos (hasta 10 min atrás).
const GLM_RADIUS_KM = 60, GLM_KEEP_MS = 1800000, GLM_LOOKBACK_MS = 600000, GLM_MAX_FILES = 36;
function goes_glm(float $lat, float $lng): array {
  $now = now_ms(); $c = cache_get('glm') ?: ['strikes' => [], 'seen' => [], 'lastFile' => 0, 'lastOk' => 0, 'error' => ''];
  if ($now - ($c['checked'] ?? 0) > 50000) {
    $c['checked'] = $now;
    try {
      $from = max($now - GLM_LOOKBACK_MS, ($c['lastFile'] ?? 0) - 60000);
      $keys = goes_list(array_unique([goes_prefix('GLM-L2-LCFA', $from), goes_prefix('GLM-L2-LCFA', $now)]));
      $newest = $keys ? max(array_map('goes_time', $keys)) : 0;
      if (!$newest || $now - $newest > 1200000) throw new Exception('el satélite no publica datos recientes');
      $seen = array_flip($c['seen'] ?? []);
      $todo = array_slice(array_values(array_filter($keys, fn($k) => goes_time($k) >= $from && !isset($seen[$k]))), -GLM_MAX_FILES);
      $reqs = []; foreach ($todo as $i => $k) $reqs[$i] = ['url' => 'https://' . GOES_BUCKET . '.s3.amazonaws.com/' . $k, 'timeout' => 15];
      foreach ($reqs ? http_multi($reqs) : [] as $i => $r) {
        if ($r['err'] || $r['code'] !== 200) continue;
        $k = $todo[$i]; $t = goes_time($k);
        try {
          $la = h5_find($r['body'], 'flash_lat'); $lo = h5_find($r['body'], 'flash_lon');
          if ($la && $lo) {
            $dl = h5_dataset($r['body'], $la); $dn = h5_dataset($r['body'], $lo);
            if (($dl['dims'][0] ?? 0) > 0) {
              $lats = h5_read($r['body'], $dl); $lons = h5_read($r['body'], $dn);
              foreach ($lats as $j => $y) { $x = $lons[$j] ?? null; if ($y === null || $x === null || abs($y) > 90) continue;
                $km = goes_km($lat, $lng, $y, $x); if ($km <= GLM_RADIUS_KM) $c['strikes'][] = ['t' => $t, 'km' => round($km, 1)]; }
            }
          }
          $c['seen'][] = $k; $c['lastFile'] = max($c['lastFile'] ?? 0, $t);
        } catch (Throwable $e) { $c['seen'][] = $k; $fileErr = $e->getMessage(); }
      }
      $c['seen'] = array_slice($c['seen'] ?? [], -120);
      $c['strikes'] = array_values(array_filter($c['strikes'], fn($s) => $s['t'] >= $now - GLM_KEEP_MS));
      $c['lastOk'] = $now; $c['error'] = isset($fileErr) ? "no se pudo leer un archivo del satélite ($fileErr)" : '';
    } catch (Throwable $e) { $c['error'] = $e->getMessage(); }
    cache_put('glm', $c);
  }
  return glm_snapshot($c, $now);
}
function glm_snapshot(array $c, int $now): array {
  $base = ['id' => 'rayos', 'kind' => 'observación', 'name' => 'Detector de rayos (satélite GOES)', 'intensity' => 0, 'rainNow' => 0];
  $ok = ($c['lastOk'] ?? 0) && $now - $c['lastOk'] < 600000 && ($c['lastFile'] ?? 0) && $now - $c['lastFile'] < 900000;
  if (!$ok) return $base + ['ok' => false, 'error' => ($c['error'] ?? '') ?: 'conectando con el satélite…'];
  $all = array_values(array_filter($c['strikes'] ?? [], fn($s) => $now - $s['t'] <= GLM_KEEP_MS));
  $cnt = fn($km, $ms) => count(array_filter($all, fn($s) => $s['km'] <= $km && $now - $s['t'] <= $ms));
  $n15 = $cnt(15, 900000); $n10 = $cnt(15, 600000); $n30 = $cnt(30, 1800000); $n60 = $cnt(60, 1800000);
  $nearest = $all ? min(array_column($all, 'km')) : null; $delay = (int)round(($now - $c['lastFile']) / 60000);
  return $base + ['ok' => true, 'at' => gmdate('c', intdiv($now, 1000)), 'strikes15' => $n15, 'strikes10' => $n10, 'strikes30' => $n30, 'strikes60' => $n60,
    'nearestKm' => $nearest === null ? null : (int)round($nearest),
    'detail' => ($n60 ? "$n60 rayo" . ($n60 > 1 ? 's' : '') . ' en los últimos 30 min a menos de 60 km' . ($nearest !== null ? ' · el más cercano a ' . round($nearest) . ' km' : '') : 'Sin rayos detectados en 60 km (últimos 30 min)') . " · dato del satélite de hace $delay min"];
}
