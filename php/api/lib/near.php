<?php
// Calles y sector cercanos a un punto (para los reportes ciudadanos). Overpass (calles con nombre a < 180 m),
// Nominatim y Photon se consultan a la vez; el resultado se guarda 24 h.
const NEAR_UA = 'SistemaAlertaVial/1.0 (EMOVTT Santa Rosa EP)';
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];

function near_meters($aLat, $aLng, $bLat, $bLng): float {
  $r = M_PI / 180; $dLat = ($bLat - $aLat) * $r; $dLng = ($bLng - $aLng) * $r;
  $h = sin($dLat / 2) ** 2 + cos($aLat * $r) * cos($bLat * $r) * sin($dLng / 2) ** 2;
  return 12742000 * asin(sqrt($h));
}
function near_streets(float $lat, float $lng): array {
  $k = sprintf('%.4f,%.4f', $lat, $lng); $all = cache_get('near') ?: [];
  if (isset($all[$k]) && now_ms() - $all[$k]['t'] < 86400000) return $all[$k]['v'];
  $q = "[out:json][timeout:5];way(around:180,$lat,$lng)[highway][name];out tags geom;";
  $reqs = [];
  foreach (OVERPASS as $i => $u) $reqs["op$i"] = ['url' => $u, 'method' => 'POST', 'body' => 'data=' . rawurlencode($q), 'timeout' => 6,
    'headers' => ['content-type' => 'application/x-www-form-urlencoded', 'user-agent' => NEAR_UA]];
  $reqs['nm'] = ['url' => "https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=$lat&lon=$lng&zoom=17&addressdetails=1&accept-language=es", 'timeout' => 4, 'headers' => ['user-agent' => NEAR_UA]];
  $reqs['ph'] = ['url' => "https://photon.komoot.io/reverse?lat=$lat&lon=$lng&limit=1", 'timeout' => 4, 'headers' => ['user-agent' => NEAR_UA]];
  $res = http_multi($reqs);
  $streets = [];
  foreach (array_keys(OVERPASS) as $i) {
    try { $j = http_json($res["op$i"]); } catch (Throwable $e) { continue; }
    $best = [];
    foreach ($j['elements'] ?? [] as $w) {
      $name = $w['tags']['name'] ?? ''; if ($name === '' || empty($w['geometry'])) continue;
      $d = min(array_map(fn($g) => near_meters($lat, $lng, $g['lat'], $g['lon']), $w['geometry']));
      if (!isset($best[$name]) || $best[$name] > $d) $best[$name] = $d;
    }
    asort($best);
    foreach (array_slice($best, 0, 6, true) as $name => $d) $streets[] = ['name' => (string)$name, 'dist' => (int)round($d)];
    break; // el primero que respondió bien
  }
  $nm = []; $ph = [];
  try { $a = http_json($res['nm'])['address'] ?? []; $nm = ['street' => $a['road'] ?? $a['pedestrian'] ?? $a['footway'] ?? '', 'sector' => $a['neighbourhood'] ?? $a['suburb'] ?? $a['quarter'] ?? $a['city_district'] ?? $a['hamlet'] ?? '']; } catch (Throwable $e) {}
  try { $p = http_json($res['ph'])['features'][0]['properties'] ?? []; $ph = ['street' => $p['street'] ?? '', 'sector' => $p['district'] ?? $p['locality'] ?? $p['suburb'] ?? '']; } catch (Throwable $e) {}
  foreach ([$ph['street'] ?? '', $nm['street'] ?? ''] as $s) {
    if ($s === '') continue;
    $has = false; foreach ($streets as $x) if ($x['name'] === $s) $has = true;
    if (!$has) array_unshift($streets, ['name' => $s, 'dist' => 0]);
  }
  $v = ['streets' => array_slice($streets, 0, 6), 'sector' => ($nm['sector'] ?? '') ?: ($ph['sector'] ?? '')];
  if ($v['streets'] || $v['sector']) {
    $all[$k] = ['t' => now_ms(), 'v' => $v];
    if (count($all) > 500) $all = array_slice($all, -400, null, true);
    cache_put('near', $all);
  }
  return $v;
}
