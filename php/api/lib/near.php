<?php
// Calles y sector cercanos a un punto (para los reportes ciudadanos). Overpass (calles con nombre a < 250 m e intersección más cercana),
// Nominatim y Photon se consultan a la vez; el resultado se guarda 24 h.
const NEAR_UA = 'SistemaAlertaVial/1.0 (EMOVTT Santa Rosa EP)';
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];

function near_meters($aLat, $aLng, $bLat, $bLng): float {
  $r = M_PI / 180; $dLat = ($bLat - $aLat) * $r; $dLng = ($bLng - $aLng) * $r;
  $h = sin($dLat / 2) ** 2 + cos($aLat * $r) * cos($bLat * $r) * sin($dLng / 2) ** 2;
  return 12742000 * asin(sqrt($h));
}
// Calles con nombre cerca del punto (distancia a cada tramo) y la intersección más cercana (nodo que comparten dos calles
// de distinto nombre). Igual que nearAnalyze en server/near.js.
function near_analyze(array $elements, float $lat, float $lng): array {
  $k = cos($lat * M_PI / 180); $P = fn($g) => [($g['lon'] - $lng) * 111320 * $k, ($g['lat'] - $lat) * 111320];
  $seg = function ($a, $b) { [$ax, $ay] = $a; [$bx, $by] = $b; $dx = $bx - $ax; $dy = $by - $ay; $L = $dx * $dx + $dy * $dy;
    $t = $L ? max(0, min(1, -($ax * $dx + $ay * $dy) / $L)) : 0; return hypot($ax + $t * $dx, $ay + $t * $dy); };
  $best = []; $names = []; $pos = [];
  foreach ($elements as $w) {
    $name = (string)($w['tags']['name'] ?? ''); $g = $w['geometry'] ?? []; if ($name === '' || !$g) continue;
    $pts = array_map(fn($x) => is_array($x) && isset($x['lat'], $x['lon']) ? $P($x) : null, $g); $ok = array_values(array_filter($pts)); if (!$ok) continue;
    $d = hypot($ok[0][0], $ok[0][1]);
    for ($i = 1; $i < count($pts); $i++) if ($pts[$i - 1] && $pts[$i]) $d = min($d, $seg($pts[$i - 1], $pts[$i]));
    if (!isset($best[$name]) || $best[$name] > $d) $best[$name] = $d;
    foreach ($w['nodes'] ?? [] as $i => $id) { if (empty($pts[$i])) continue; $names[$id][$name] = true; $pos[$id] = $pts[$i]; }
  }
  $inter = null;
  foreach ($names as $id => $set) if (count($set) >= 2) {
    $d = hypot($pos[$id][0], $pos[$id][1]);
    if (!$inter || $d < $inter['dist']) { $st = array_keys($set); usort($st, fn($a, $b) => $best[$a] <=> $best[$b]); $inter = ['streets' => array_map('strval', array_slice($st, 0, 2)), 'dist' => (int)round($d)]; }
  }
  asort($best); $streets = [];
  foreach (array_slice($best, 0, 6, true) as $name => $d) $streets[] = ['name' => (string)$name, 'dist' => (int)round($d)];
  return ['streets' => $streets, 'inter' => $inter];
}
function near_streets(float $lat, float $lng): array {
  $k = sprintf('%.4f,%.4f', $lat, $lng); $all = cache_get('near2') ?: [];
  if (isset($all[$k]) && now_ms() - $all[$k]['t'] < 86400000) return $all[$k]['v'];
  $q = "[out:json][timeout:5];way(around:250,$lat,$lng)[highway][name];out body geom;";
  $reqs = [];
  foreach (OVERPASS as $i => $u) $reqs["op$i"] = ['url' => $u, 'method' => 'POST', 'body' => 'data=' . rawurlencode($q), 'timeout' => 6,
    'headers' => ['content-type' => 'application/x-www-form-urlencoded', 'user-agent' => NEAR_UA]];
  $reqs['nm'] = ['url' => "https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=$lat&lon=$lng&zoom=17&addressdetails=1&accept-language=es", 'timeout' => 4, 'headers' => ['user-agent' => NEAR_UA]];
  $reqs['ph'] = ['url' => "https://photon.komoot.io/reverse?lat=$lat&lon=$lng&limit=1", 'timeout' => 4, 'headers' => ['user-agent' => NEAR_UA]];
  $res = http_multi($reqs);
  $streets = []; $inter = null;
  foreach (array_keys(OVERPASS) as $i) {
    try { $j = http_json($res["op$i"]); } catch (Throwable $e) { continue; }
    $op = near_analyze($j['elements'] ?? [], $lat, $lng); $streets = $op['streets']; $inter = $op['inter'];
    break; // el primero que respondió bien
  }
  $nm = []; $ph = [];
  try { $a = http_json($res['nm'])['address'] ?? []; $nm = ['street' => $a['road'] ?? $a['pedestrian'] ?? $a['footway'] ?? '', 'sector' => $a['neighbourhood'] ?? $a['suburb'] ?? $a['quarter'] ?? $a['city_district'] ?? $a['hamlet'] ?? '']; } catch (Throwable $e) {}
  try { $p = http_json($res['ph'])['features'][0]['properties'] ?? []; $ph = ['street' => $p['street'] ?? '', 'sector' => $p['district'] ?? $p['locality'] ?? $p['suburb'] ?? '']; } catch (Throwable $e) {}
  foreach ([$nm['street'] ?? '', $ph['street'] ?? ''] as $s) {
    if ($s === '') continue;
    $has = false; foreach ($streets as $x) if ($x['name'] === $s) $has = true;
    if (!$has) $streets[] = ['name' => $s, 'dist' => null]; // solo si Overpass no la tiene
  }
  $v = ['streets' => array_slice($streets, 0, 6), 'inter' => $inter, 'sector' => ($nm['sector'] ?? '') ?: ($ph['sector'] ?? '')];
  if ($v['streets'] || $v['sector']) {
    $all[$k] = ['t' => now_ms(), 'v' => $v];
    if (count($all) > 500) $all = array_slice($all, -400, null, true);
    cache_put('near2', $all);
  }
  return $v;
}
