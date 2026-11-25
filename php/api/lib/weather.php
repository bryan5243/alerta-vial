<?php
// Clima de varias fuentes (port fiel de server/weather.js):
//  · Open-Meteo con 8 modelos en una consulta + MET Norway (yr.no): pronósticos
//  · Aeropuerto de Santa Rosa (METAR SERO): aviationweather.gov y NOAA a la vez
//  · Radar de lluvia de RainViewer (píxel sobre la ciudad)
//  · World Weather Online (wttr.in): respaldo y probabilidad de tormenta eléctrica
//  · OpenWeatherMap (opcional) y lo que marca el equipo en el panel
// Los pronósticos solos no confirman lluvia: hace falta radar o aeropuerto (o varios modelos de acuerdo).
const AV_TTL = 300000, OM_TTL = 600000, OM_BLOCK = 900000, OM_STALE = 3600000, MIN_MM = 0.5, WET_MM = 0.1, NOTICE_PROB = 80;
const AV_UA = 'AlertaVial/1.0 (alertas de inundacion)', METNO_UA = 'AlertaVial/1.0 github.com/bryan5243/alerta-vial';
const MODELS = ['best_match' => 'Mejor modelo', 'ecmwf_ifs025' => 'ECMWF (Europa)', 'gfs_seamless' => 'GFS (EE. UU.)', 'icon_seamless' => 'ICON (Alemania)',
  'jma_seamless' => 'JMA (Japón)', 'meteofrance_seamless' => 'Météo-France', 'ukmo_seamless' => 'UK Met Office', 'gem_seamless' => 'GEM (Canadá)'];
const INT_MM = [0, 1, 4, 10, 20], INT_CODE = [0, 61, 63, 65, 95], INT_TXT = ['Sin lluvia', 'Lluvia leve', 'Lluvia moderada', 'Lluvia fuerte', 'Tormenta eléctrica'];
const P_MM = [[5, 90], [2.5, 80], [1, 70], [0.5, 55], [0.2, 40], [0.1, 25]];
const WMO_TXT = [0 => 'Despejado', 1 => 'Mayormente despejado', 2 => 'Parcialmente nublado', 3 => 'Nublado', 45 => 'Neblina', 48 => 'Neblina', 51 => 'Llovizna', 53 => 'Llovizna', 55 => 'Llovizna intensa',
  56 => 'Llovizna', 57 => 'Llovizna', 61 => 'Lluvia leve', 63 => 'Lluvia moderada', 65 => 'Lluvia fuerte', 66 => 'Lluvia leve', 67 => 'Lluvia fuerte', 80 => 'Chubascos leves', 81 => 'Chubascos', 82 => 'Chubascos fuertes',
  95 => 'Tormenta', 96 => 'Tormenta con granizo', 99 => 'Tormenta con granizo'];

function r1($x): float { return round((float)($x ?: 0), 1); }
function mm_int($mm): int { return $mm >= 8 ? 3 : ($mm >= 2.5 ? 2 : ($mm >= MIN_MM ? 1 : 0)); }
function fl_max(array $a, $default = 0) { return $a ? max($a) : $default; }
function hhmm_local(int $ts): string { return gmdate('H:i', $ts - 18000); }
function bad_model(string $m, string $err): array { return ['model' => $m, 'name' => MODELS[$m] ?? $m, 'ok' => false, 'error' => $err, 'intensity' => 0]; }
function first_of(array $arr, callable $f) { foreach ($arr as $x) if ($f($x)) return $x; return null; }

// ---------- Open-Meteo ----------
function om_url($lat, $lng, ?string $models): string {
  $q = ['latitude' => $lat, 'longitude' => $lng,
    'current' => 'precipitation,rain,showers,temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,wind_gusts_10m,weather_code,cloud_cover,is_day,uv_index,shortwave_radiation',
    'daily' => 'uv_index_max,sunrise,sunset', 'hourly' => 'precipitation,precipitation_probability,cape,weather_code', 'past_hours' => 12, 'forecast_hours' => 24, 'timezone' => 'America/Guayaquil'];
  if ($models) $q['models'] = $models;
  return 'https://api.open-meteo.com/v1/forecast?' . http_build_query($q);
}
function om_parse(string $model, array $j, bool $sfx): array {
  $g = fn($o, $k) => $sfx ? ($o["{$k}_{$model}"] ?? null) : ($o[$k] ?? null);
  $H = $j['hourly'] ?? []; $times = $H['time'] ?? [];
  $P = $g($H, 'precipitation') ?: []; $PP = $g($H, 'precipitation_probability') ?: []; $CP = $g($H, 'cape') ?: []; $WC = $g($H, 'weather_code') ?: [];
  $hours = [];
  foreach ($times as $i => $t) $hours[] = ['time' => $t, 'precipitation' => $P[$i] ?? null, 'probability' => $PP[$i] ?? null, 'cape' => $CP[$i] ?? null, 'code' => $WC[$i] ?? null];
  $allNull = true; foreach ($hours as $h) if ($h['precipitation'] !== null) { $allNull = false; break; }
  if (!$hours || $allNull) return bad_model($model, 'sin datos para este punto');
  $cur = $j['current'] ?? []; $useCur = $model === 'best_match' || !$sfx;
  $curH = substr((string)($cur['time'] ?? ''), 0, 13); $nowIdx = 0;
  foreach ($hours as $i => $h) if (substr($h['time'], 0, 13) === $curH) { $nowIdx = $i; break; }
  $sl = fn($a, $b) => array_slice($hours, $a, max(0, $b - $a));
  $sum = fn($arr) => r1(array_sum(array_map(fn($h) => $h['precipitation'] ?? 0, $arr)));
  $k = 3600 / (($cur['interval'] ?? 0) ?: 900);
  $curMm = $useCur ? max($cur['precipitation'] ?? 0, ($cur['rain'] ?? 0) + ($cur['showers'] ?? 0)) * $k : 0;
  $rainNow = r1(max($curMm, $hours[$nowIdx]['precipitation'] ?? 0));
  $code = $useCur ? ($cur['weather_code'] ?? null) : null; $storm = $code !== null && $code >= 95; // tormenta aparte: la lluvia sale solo de los mm
  $D = $j['daily'] ?? [];
  $sun = $useCur ? ['isDay' => $cur['is_day'] ?? null, 'uvIndex' => $cur['uv_index'] ?? null, 'radiation' => $cur['shortwave_radiation'] ?? null,
    'uvMax' => ($g($D, 'uv_index_max') ?? [])[0] ?? null, 'sunrise' => ($g($D, 'sunrise') ?? [])[0] ?? null, 'sunset' => ($g($D, 'sunset') ?? [])[0] ?? null] : null;
  $hasProb = false; foreach ($hours as $h) if ($h['probability'] !== null) { $hasProb = true; break; }
  $probOf = fn($arr) => max(array_merge([0], array_map(fn($h) => $h['probability'] ?: 0, $arr)));
  $cape = null; $thCode = false;
  foreach ($sl($nowIdx, $nowIdx + 7) as $h) { if ($h['cape'] !== null && $h['cape'] > ($cape ?? -1)) $cape = $h['cape']; if (($h['code'] ?? 0) >= 95) $thCode = true; }
  $wet = 0; for ($i = $nowIdx; $i >= 0 && ($hours[$i]['precipitation'] ?? 0) >= 0.5; $i--) $wet++;
  return ['model' => $model, 'name' => MODELS[$model], 'ok' => true, 'observedAt' => $cur['time'] ?? null,
    'temperature' => $useCur ? ($cur['temperature_2m'] ?? null) : null, 'apparent' => $useCur ? ($cur['apparent_temperature'] ?? null) : null,
    'humidity' => $useCur ? ($cur['relative_humidity_2m'] ?? null) : null, 'wind' => $useCur ? ($cur['wind_speed_10m'] ?? null) : null, 'gust' => $useCur ? ($cur['wind_gusts_10m'] ?? null) : null,
    'cloudCover' => $useCur ? ($cur['cloud_cover'] ?? null) : null, 'sun' => $sun, 'weatherCode' => $code, 'rainNow' => $rainNow, 'intensity' => mm_int($rainNow), 'storm' => $storm ?: null,
    'rainPast3h' => $sum($sl(max(0, $nowIdx - 3), $nowIdx + 1)), 'rainPast6h' => $sum($sl(max(0, $nowIdx - 6), $nowIdx + 1)), 'rainPast12h' => $sum($sl(max(0, $nowIdx - 12), $nowIdx + 1)),
    'wetHours' => $wet, 'rainNext3h' => $sum($sl($nowIdx + 1, $nowIdx + 4)), 'rainNext24h' => $sum($sl($nowIdx + 1, $nowIdx + 25)),
    'probNext3h' => $hasProb ? $probOf($sl($nowIdx, $nowIdx + 4)) : null,
    'maxProbability24h' => $hasProb ? $probOf($sl($nowIdx + 1, $nowIdx + 25)) : null,
    'capeMax6h' => $cape, 'thunderCode6h' => $thCode,
    'hourly' => array_map(fn($h) => ['time' => $h['time'], 'precipitation' => $h['precipitation'], 'probability' => $h['probability']], $sl($nowIdx, $nowIdx + 25))];
}
// Procesa la respuesta ya descargada de Open-Meteo (con varios modelos) y mantiene el estado (último dato bueno, bloqueo por 429)
function om_process(array $res, $lat, $lng): array {
  $ids = array_keys(MODELS); $key = "$lat,$lng"; $now = now_ms(); $om = cache_get('om') ?: [];
  $fail = function ($error) use ($om, $key, $now, $ids) {
    if (!empty($om['good']) && ($om['key'] ?? '') === $key && $now - ($om['goodAt'] ?? 0) < OM_STALE) {
      $min = (int)round(($now - $om['goodAt']) / 60000);
      return array_map(fn($m) => $m + ['stale' => true, 'staleMin' => $min, 'staleWhy' => $error], $om['good']);
    }
    return array_map(fn($m) => bad_model($m, $error), $ids);
  };
  try { $j = http_json($res); $models = array_map(fn($m) => om_parse($m, $j, true), $ids); }
  catch (Throwable $e) {
    if (strpos($e->getMessage(), 'demasiadas consultas') !== false) { cache_put('om', ['key' => $key, 'blockedUntil' => $now + OM_BLOCK, 'error' => $e->getMessage(), 'good' => $om['good'] ?? null, 'goodAt' => $om['goodAt'] ?? 0]); return $fail($e->getMessage()); }
    try { $models = array_merge([om_parse('best_match', http_json(http_one(['url' => om_url($lat, $lng, null), 'timeout' => 10, 'headers' => ['user-agent' => AV_UA]])), false)], array_map(fn($m) => bad_model($m, $e->getMessage()), array_slice($ids, 1))); }
    catch (Throwable $e2) { cache_put('om', ['key' => $key, 'error' => $e2->getMessage(), 'good' => $om['good'] ?? null, 'goodAt' => $om['goodAt'] ?? 0]); return $fail($e2->getMessage()); }
  }
  $new = ['key' => $key, 'at' => $now, 'models' => $models, 'error' => '', 'good' => $om['good'] ?? null, 'goodAt' => $om['goodAt'] ?? 0];
  foreach ($models as $m) if ($m['ok']) { $new['good'] = $models; $new['goodAt'] = $now; break; }
  cache_put('om', $new);
  return $models;
}
// Open-Meteo bloqueado (429): se usa el último dato bueno, si no es muy viejo
function om_blocked_models(array $om): array {
  $now = now_ms(); $err = $om['error'] ?? 'demasiadas consultas, reintenta luego';
  if (!empty($om['good']) && $now - ($om['goodAt'] ?? 0) < OM_STALE) { $min = (int)round(($now - $om['goodAt']) / 60000); return array_map(fn($m) => $m + ['stale' => true, 'staleMin' => $min, 'staleWhy' => $err], $om['good']); }
  return array_map(fn($m) => bad_model($m, $err), array_keys(MODELS));
}

// ---------- MET Norway ----------
function metno_code(string $s): int { return preg_match('/thunder/', $s) ? 95 : (preg_match('/heavyrain|heavysleet/', $s) ? 65 : (preg_match('/lightrain|lightsleet/', $s) ? 61 : (preg_match('/rain|sleet/', $s) ? 63
  : (preg_match('/fog/', $s) ? 45 : (preg_match('/^cloudy/', $s) ? 3 : (preg_match('/partlycloudy/', $s) ? 2 : (preg_match('/fair/', $s) ? 1 : 0))))))); }
function metno_url($lat, $lng): string { return sprintf('https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=%.4f&lon=%.4f', $lat, $lng); }
function metno_ts(array $res): array {
  if ($res['err']) throw new RuntimeException($res['err']);
  if ($res['code'] < 200 || $res['code'] >= 300) throw new RuntimeException(in_array($res['code'], [429, 403]) ? 'demasiadas consultas, reintenta luego' : "respondió con error {$res['code']}");
  return json_decode($res['body'], true)['properties']['timeseries'] ?? [];
}
function metno_parse(array $res): array {
  try {
    $ts = metno_ts($res);
    $t0 = $ts[0] ?? null; if (!$t0) throw new RuntimeException('sin datos para este punto');
    $det = $t0['data']['instant']['details'] ?? []; $n1 = $t0['data']['next_1_hours'] ?? [];
    $sym = $n1['summary']['symbol_code'] ?? ($t0['data']['next_6_hours']['summary']['symbol_code'] ?? '');
    $mm = fn($i) => $ts[$i]['data']['next_1_hours']['details']['precipitation_amount'] ?? 0;
    $rainNow = r1($mm(0)); $code = metno_code($sym); $storm = $code >= 95;
    $t0s = strtotime($t0['time']); $hr = (int)gmdate('G', $t0s - 18000);
    $isDay = preg_match('/_night/', $sym) ? 0 : (preg_match('/_day/', $sym) ? 1 : ($hr >= 6 && $hr < 18 ? 1 : 0));
    $cloud = $det['cloud_area_fraction'] ?? null;
    $uv = !isset($det['ultraviolet_index_clear_sky']) ? null : r1($det['ultraviolet_index_clear_sky'] * (1 - 0.75 * pow(($cloud ?? 0) / 100, 3.4)));
    $prob = []; foreach (array_slice($ts, 0, 4) as $x) { $p = $x['data']['next_1_hours']['details']['probability_of_precipitation'] ?? null; if ($p !== null) $prob[] = $p; }
    $symAt = fn($i) => $ts[$i]['data']['next_1_hours']['summary']['symbol_code'] ?? '';
    $hourly = [];
    foreach (array_slice($ts, 0, 25) as $x) {
      if (empty($x['data']['next_1_hours'])) continue;
      $n = $x['data']['next_1_hours'];
      $h = ['time' => substr(gmdate('c', strtotime($x['time']) - 18000), 0, 13) . ':00', 'precipitation' => $n['details']['precipitation_amount'] ?? 0, 'probability' => $n['details']['probability_of_precipitation'] ?? null];
      if (preg_match('/thunder/', $n['summary']['symbol_code'] ?? '')) $h['thunder'] = true;
      $hourly[] = $h;
    }
    $next24 = 0; for ($i = 1; $i <= 24; $i++) $next24 += $mm($i);
    $thunder = false; for ($i = 0; $i < 6; $i++) if (preg_match('/thunder/', $symAt($i))) $thunder = true;
    $t = $det['air_temperature'] ?? null; $rh = $det['relative_humidity'] ?? null; $ws = $det['wind_speed'] ?? null;
    return ['model' => 'met_no', 'name' => 'MET Norway (yr.no)', 'ok' => true, 'observedAt' => gmdate('Y-m-d\TH:i', $t0s - 18000),
      'temperature' => $t, 'humidity' => $rh, 'wind' => $ws === null ? null : r1($ws * 3.6), 'apparent' => apparent_temp($t, $rh, $ws),
      'cloudCover' => $cloud === null ? null : (int)round($cloud), 'weatherCode' => $code, 'rainNow' => $rainNow, 'intensity' => mm_int($rainNow), 'storm' => $storm ?: null,
      'sun' => ['isDay' => $isDay, 'uvIndex' => $isDay ? $uv : 0, 'radiation' => null, 'uvMax' => null, 'sunrise' => null, 'sunset' => null],
      'rainPast3h' => 0, 'rainNext3h' => r1($mm(1) + $mm(2) + $mm(3)), 'rainNext24h' => r1($next24),
      'probNext3h' => $prob ? max($prob) : null, 'maxProbability24h' => null, 'hourly' => $hourly, 'thunder6h' => $thunder];
  } catch (Throwable $e) { return ['model' => 'met_no', 'name' => 'MET Norway (yr.no)', 'ok' => false, 'error' => $e->getMessage(), 'intensity' => 0]; }
}

// ---------- METAR (aeropuerto) ----------
function parse_metar($raw): array {
  $body = preg_split('/\sRMK\s/', (string)$raw)[0]; $intensity = 0; $near = false; $txt = '';
  foreach (preg_split('/\s+/', $body) as $t) {
    if (!preg_match('/^(\+|-|VC)?(TS|SH)?((?:DZ|RA|GR|GS|UP)*)$/', $t, $m)) continue;
    $m1 = $m[1] ?? ''; $m2 = $m[2] ?? ''; $m3 = $m[3] ?? '';
    if (!$m2 && !$m3) continue;
    if ($m1 === 'VC') { $near = true; continue; }
    $ts = $m2 === 'TS'; $rain = (bool)preg_match('/RA|DZ|GR|GS|UP/', $m3);
    // TS = tormenta eléctrica; la lluvia se mide aparte ("TS" solo = tormenta sin lluvia, "-TSRA" = con lluvia leve)
    $i = preg_match('/RA|GR|GS|UP/', $m3) ? 2 : (preg_match('/DZ/', $m3) ? 1 : 0);
    if ($i && $m1 === '-') $i = max(1, $i - 1);
    if ($i && $m1 === '+') $i = 3;
    if ($i > $intensity || ($ts && strpos($txt, 'Tormenta') !== 0)) { $intensity = max($intensity, $i); $txt = $ts ? ($rain ? 'Tormenta con ' . mb_strtolower(INT_TXT[$i]) : 'Tormenta eléctrica sin lluvia') : (($m1 === '+' ? 'Lluvia fuerte' : ($m1 === '-' ? 'Lluvia leve' : (preg_match('/DZ/', $m3) && !preg_match('/RA/', $m3) ? 'Llovizna' : 'Lluvia'))) . ($m2 === 'SH' ? ' (chubasco)' : '')); }
  }
  $air = metar_air($body);
  if (!$intensity && $near) return ['intensity' => 0, 'near' => $near, 'text' => 'Lluvia en los alrededores (no sobre el aeropuerto)'] + $air;
  return ['intensity' => $intensity, 'near' => $near, 'text' => $txt ?: 'Sin lluvia'] + $air;
}
// Temperatura, humedad (del punto de rocío) y viento medidos en el aeropuerto: "29/22" (M = bajo cero), "23008KT"
function metar_air(string $body): array {
  $out = [];
  if (preg_match('#\s(M?\d{2})/(M?\d{2})(?=\s|$)#', ' ' . $body, $t)) {
    $n = fn($x) => ($x[0] === 'M' ? -1 : 1) * (int)str_replace('M', '', $x); $T = $n($t[1]); $D = $n($t[2]);
    $out['temperature'] = $T; $out['humidity'] = (int)round(100 * exp(17.625 * $D / (243.04 + $D)) / exp(17.625 * $T / (243.04 + $T)));
  }
  if (preg_match('/\b(?:\d{3}|VRB)(\d{2,3})(?:G\d{2,3})?(KT|MPS)\b/', $body, $w)) $out['wind'] = (int)round((int)$w[1] * ($w[2] === 'KT' ? 1.852 : 3.6));
  return $out;
}
// Dos servidores a la vez (aviationweather.gov y NOAA): gana el reporte más reciente que llegue
function metar_parse(?array $awc, ?array $noaa, string $station): array {
  $base = ['id' => 'metar', 'kind' => 'observación', 'name' => "Aeropuerto Santa Rosa ($station)"];
  try {
    $obs = []; $answered = false;
    if ($awc) try { $j = http_json($awc); $answered = true; foreach ((is_array($j) ? $j : []) as $x) { $raw = $x['rawOb'] ?? ''; if ($raw) $obs[] = ['raw' => $raw, 'at' => isset($x['obsTime']) ? (int)$x['obsTime'] : (isset($x['reportTime']) ? strtotime($x['reportTime']) : 0)]; } } catch (Throwable $e) {}
    if ($noaa && !$noaa['err'] && $noaa['code'] >= 200 && $noaa['code'] < 300) {
      $answered = true; $lines = explode("\n", trim($noaa['body']));
      $at = strtotime(str_replace('/', '-', trim($lines[0] ?? '')) . ':00 UTC'); $raw = trim($lines[1] ?? '');
      if ($raw && $at) $obs[] = ['raw' => $raw, 'at' => $at];
    }
    if (!$answered) throw new RuntimeException('no respondió a tiempo (se probaron 2 servidores)');
    usort($obs, fn($a, $b) => $b['at'] <=> $a['at']); $last = $obs[0] ?? null;
    if (!$last) throw new RuntimeException('el aeropuerto no envió reportes en las últimas 3 h');
    $ageMin = (int)round((time() - $last['at']) / 60); $p = parse_metar($last['raw']); $fresh = $ageMin <= 90;
    return $base + ['ok' => $fresh, 'stale' => !$fresh, 'at' => gmdate('c', $last['at']), 'ageMin' => $ageMin, 'raw' => $last['raw'], 'intensity' => $fresh ? $p['intensity'] : 0, 'rainNow' => $fresh ? INT_MM[$p['intensity']] : 0,
      'near' => $fresh && !empty($p['near']), 'cb' => $fresh && (bool)preg_match('/\b(FEW|SCT|BKN|OVC)\d{3}(CB|TCU)\b/', $last['raw']),
      'ts' => $fresh && (bool)preg_match('/\b(VC)?TS/', preg_replace('/^\S+\s+\S+\s+/', '', $last['raw'])),
      'detail' => "{$p['text']} · reporte de hace $ageMin min", 'error' => $fresh ? null : "último reporte hace $ageMin min",
      'temperature' => $fresh ? ($p['temperature'] ?? null) : null, 'humidity' => $fresh ? ($p['humidity'] ?? null) : null, 'wind' => $fresh ? ($p['wind'] ?? null) : null];
  } catch (Throwable $e) { return $base + ['ok' => false, 'intensity' => 0, 'error' => $e->getMessage()]; }
}

// ---------- OpenWeatherMap (opcional) ----------
function owm_parse(array $res): array {
  $base = ['id' => 'owm', 'kind' => 'pronóstico', 'name' => 'OpenWeatherMap'];
  try {
    $j = http_json($res); $id = $j['weather'][0]['id'] ?? 800;
    $mm = r1($j['rain']['1h'] ?? (isset($j['rain']['3h']) ? $j['rain']['3h'] / 3 : 0));
    // Códigos OWM: 500 leve, 501 moderada, 502–504 fuerte, 511 moderada, 520 chubasco leve, 521 chubasco, 522 chubasco fuerte, 531 irregular.
    // Antes 520/522/531 se tomaban todos como "fuerte". 500/520 (leve) sin milímetros no cuentan.
    $codeInt = $id >= 200 && $id < 300 ? ([200 => 1, 230 => 1, 201 => 2, 231 => 2, 202 => 3, 232 => 3][$id] ?? 0)
      : ([501 => 2, 502 => 3, 503 => 3, 504 => 3, 511 => 2, 521 => 2, 522 => 3, 531 => 2][$id] ?? 0);
    // Si OWM informa los milímetros, mandan los milímetros; el código solo se usa si no hay medida, y como mucho moderada.
    $hasMm = isset($j['rain']['1h']) || isset($j['rain']['3h']);
    $intensity = $hasMm ? mm_int($mm) : min(2, $codeInt);
    return $base + ['ok' => true, 'at' => gmdate('c', $j['dt'] ?? time()), 'intensity' => $intensity, 'storm' => ($id >= 200 && $id < 300) ?: null, 'rainNow' => $hasMm ? $mm : ($intensity ? INT_MM[$intensity] / 2 : 0),
      'temperature' => $j['main']['temp'] ?? null, 'cloudCover' => $j['clouds']['all'] ?? null, 'detail' => ($j['weather'][0]['description'] ?? '') . ($mm ? " · $mm mm/h" : '')];
  } catch (Throwable $e) { return $base + ['ok' => false, 'intensity' => 0, 'error' => $e->getMessage()]; }
}

// ---------- wttr.in (World Weather Online) ----------
function parse_wttr(array $j, int $hourNow): array {
  $cur = $j['current_condition'][0] ?? []; $day = $j['weather'][0]['hourly'] ?? [];
  $slot = max(0, min(count($day) - 1, intdiv($hourNow, 3)));
  $near = array_slice($day, $slot, 2);
  $mm = (float)($cur['precipMM'] ?? 0); $code = (int)($cur['weatherCode'] ?? 0);
  $chance = max(array_merge([0], array_map(fn($h) => (int)($h['chanceofthunder'] ?? 0), $near)));
  $thunderNow = in_array($code, [200, 386, 389, 392, 395], true) && $mm >= 0.2;
  return ['mm' => $mm, 'code' => $code, 'chance' => $chance, 'thunderNow' => $thunderNow, 'intensity' => 0];
}
function wttr_parse(array $res): array {
  $base = ['id' => 'wttr', 'kind' => 'pronóstico', 'name' => 'World Weather Online (wttr.in)'];
  try {
    $p = parse_wttr(http_json($res), (int)gmdate('G', time() - 18000));
    // wttr.in es pronóstico: sus mm solo respaldan; por sí solo no enciende "lloviendo" (salvo tormenta, que además debe confirmarse)
    return $base + ['ok' => true, 'at' => gmdate('c'), 'mm' => $p['mm'], 'intensity' => 0, 'rainNow' => 0,
      'thunderChance' => $p['chance'], 'thunderNow' => $p['thunderNow'], 'detail' => "{$p['mm']} mm ahora · probabilidad de tormenta eléctrica {$p['chance']} %" . ($p['thunderNow'] ? ' · tormenta ahora' : '')];
  } catch (Throwable $e) { return $base + ['ok' => false, 'intensity' => 0, 'error' => $e->getMessage()]; }
}

// ---------- Radar (RainViewer) ----------
// Escala "Universal Blue" (color 2) de RainViewer, de 15 a 64 dBZ
function radar_scale(): array {
  static $ub = null; if ($ub) return $ub;
  $hex = explode(' ', '88ddee 6cd1eb 51c5e8 36bae5 1baee2 00a3e0 009ad5 0091ca 0088bf 007fb4 0077aa 0070a3 00699c 006295 005b8e 005588 005180 004e78 004a70 004768 ffee00 ffe000 ffd200 ffc500 ffb700 ffaa00 ff9f00 ff9500 ff8b00 ff8100 ff4400 f23600 e62800 d91b00 cd0d00 c10000 a80000 8f0000 760000 5d0000 ffaaff ff9fff ff95ff ff8bff ff81ff ff77ff ff6cff ff62ff ff58ff ff4eff');
  $ub = []; foreach ($hex as $i => $h) $ub[] = [15 + $i, hexdec(substr($h, 0, 2)), hexdec(substr($h, 2, 2)), hexdec(substr($h, 4, 2))];
  return $ub;
}
// Píxel RGBA de una imagen GD (alfa de GD: 0 opaco … 127 transparente)
function px_rgba($img, int $x, int $y): array {
  $x = max(0, min(imagesx($img) - 1, $x)); $y = max(0, min(imagesy($img) - 1, $y));
  $c = imagecolorsforindex($img, imagecolorat($img, $x, $y));
  return [$c['red'], $c['green'], $c['blue'], (int)round((127 - $c['alpha']) * 255 / 127)];
}
function radar_dbz(array $p): int {
  [$r, $g, $b, $a] = $p; if ($a < 250) return -1;
  $best = null; $bd = 1e9; foreach (radar_scale() as $e) { $d = ($e[1] - $r) ** 2 + ($e[2] - $g) ** 2 + ($e[3] - $b) ** 2; if ($d < $bd) { $bd = $d; $best = $e; } }
  return $bd < 40 * 40 * 3 ? $best[0] : -1;
}
function dbz_to_mm(int $dbz): float { return $dbz < 0 ? 0.0 : r1(pow(pow(10, $dbz / 10) / 200, 1 / 1.6)); }
function radar_pixel($lat, $lng, int $z = 7): array {
  $n = 2 ** $z; $fx = ($lng + 180) / 360 * $n; $s = sin($lat * M_PI / 180); $fy = (0.5 - log((1 + $s) / (1 - $s)) / (4 * M_PI)) * $n;
  $tx = (int)floor($fx); $ty = (int)floor($fy);
  return ['z' => $z, 'tx' => $tx, 'ty' => $ty, 'px' => min(255, (int)floor(($fx - $tx) * 256)), 'py' => min(255, (int)floor(($fy - $ty) * 256))];
}
function radar_source($lat, $lng, ?array $mapsRes): array {
  $base = ['id' => 'radar', 'kind' => 'observación', 'name' => 'Radar de lluvia (RainViewer)'];
  try {
    if (!function_exists('imagecreatefromstring')) throw new RuntimeException('el hosting no tiene la extensión GD de PHP (necesaria para leer el radar)');
    $j = http_json($mapsRes); $past = $j['radar']['past'] ?? []; $fr = end($past); if (!$fr) throw new RuntimeException('sin cuadros de radar');
    $ageMin = (int)round((time() - $fr['time']) / 60);
    $p = radar_pixel($lat, $lng); ['z' => $z, 'tx' => $tx, 'ty' => $ty, 'px' => $px, 'py' => $py] = $p;
    $res = http_multi(['cov' => ['url' => "{$j['host']}/v2/coverage/0/256/$z/$tx/$ty/0/0_0.png", 'timeout' => 8, 'headers' => ['user-agent' => AV_UA]],
      'img' => ['url' => "{$j['host']}{$fr['path']}/256/$z/$tx/$ty/2/1_1.png", 'timeout' => 8, 'headers' => ['user-agent' => AV_UA]]]);
    if (!$res['cov']['err'] && $res['cov']['code'] === 200 && ($ci = @imagecreatefromstring($res['cov']['body']))) {
      $covered = 0; for ($dy = -2; $dy <= 2; $dy++) for ($dx = -2; $dx <= 2; $dx++) $covered = max($covered, px_rgba($ci, $px + $dx, $py + $dy)[3]);
      if ($covered < 40) throw new RuntimeException('sin cobertura de radar en esta zona (RainViewer no tiene radar sobre Santa Rosa)');
    }
    if ($res['img']['err']) throw new RuntimeException($res['img']['err']);
    if ($res['img']['code'] !== 200) throw new RuntimeException("respondió con error {$res['img']['code']}");
    $img = @imagecreatefromstring($res['img']['body']); if (!$img) throw new RuntimeException('imagen de radar no válida');
    $mmHere = 0; $dbzHere = -1; $dbzNear = -1; $nearest = 0;
    for ($dy = -3; $dy <= 3; $dy++) for ($dx = -3; $dx <= 3; $dx++) {
      $v = radar_dbz(px_rgba($img, $px + $dx, $py + $dy)); $dbzNear = max($dbzNear, $v);
      if (abs($dx) <= 1 && abs($dy) <= 1) { $dbzHere = max($dbzHere, $v); $mmHere = max($mmHere, dbz_to_mm($v)); }
      if (abs($dx) <= 2 && abs($dy) <= 2) $nearest = max($nearest, mm_int(dbz_to_mm($v)));
    }
    $here = mm_int($mmHere); $fresh = $ageMin <= 25;
    return $base + ['ok' => $fresh, 'at' => gmdate('c', $fr['time']), 'intensity' => $fresh ? $here : 0, 'rainNow' => $fresh ? $mmHere : 0, 'near' => $fresh && $nearest > 0,
      'dbz' => $fresh ? $dbzHere : -1, 'dbzNear' => $fresh ? $dbzNear : -1,
      'detail' => ($here ? 'El radar ve lluvia sobre la ciudad (' . mb_strtolower(INT_TXT[$here]) . ", ~$mmHere mm/h)" : ($nearest ? 'El radar ve lluvia cerca (a pocos km), no sobre la ciudad' : 'El radar no ve lluvia sobre la ciudad')) . " · imagen de hace $ageMin min",
      'error' => $fresh ? null : "imagen de radar de hace $ageMin min"];
  } catch (Throwable $e) { return $base + ['ok' => false, 'intensity' => 0, 'error' => $e->getMessage()]; }
}

// ---------- Lluvia que el propio servidor vio pasar (para acumulados cuando las fuentes no traen el pasado) ----------
function rain_log(): array { return cache_get('rainlog')['log'] ?? []; }
function log_rain($mm, ?int $now = null): void {
  $now = $now ?? now_ms(); $log = rain_log(); $last = end($log);
  if ($last && $now - $last['t'] < 45000) return;
  $log[] = ['t' => $now, 'mm' => max(0, (float)$mm)];
  $cut = $now - 13 * 3600000; $log = array_values(array_filter($log, fn($x) => $x['t'] >= $cut));
  cache_put('rainlog', ['log' => $log]);
}
function rain_from_log(float $hours, ?int $now = null, ?array $log = null): float {
  $now = $now ?? now_ms(); $log = $log ?? rain_log(); $sum = 0;
  for ($i = 1; $i < count($log); $i++) { $a = $log[$i - 1]; $b = $log[$i]; if ($b['t'] < $now - $hours * 3600000) continue; $dt = min($b['t'] - $a['t'], 1800000) / 3600000; $sum += ($a['mm'] + $b['mm']) / 2 * $dt; }
  return r1($sum);
}
function wet_hours_from_log(?int $now = null, ?array $log = null): float {
  $now = $now ?? now_ms(); $log = $log ?? rain_log(); $end = null; $start = null;
  for ($i = count($log) - 1; $i >= 0; $i--) {
    $x = $log[$i];
    if ($x['mm'] >= 0.5) { if ($end === null) $end = $x['t']; $start = $x['t']; }
    elseif ($end !== null && (($log[$i + 1]['t'] ?? $now) - $x['t']) > 1200000) break;
  }
  return $end !== null && $now - $end < 1800000 ? r1(($end - $start) / 3600000) : 0;
}
function apply_rain_log(array $w): array {
  log_rain(($w['intensity'] ?? 0) > 0 ? $w['rainNow'] : 0); $log = rain_log(); $now = now_ms();
  $w['rainPast3h'] = max($w['rainPast3h'] ?? 0, rain_from_log(3, $now, $log)); $w['rainPast6h'] = max($w['rainPast6h'] ?? 0, rain_from_log(6, $now, $log)); $w['rainPast12h'] = max($w['rainPast12h'] ?? 0, rain_from_log(12, $now, $log));
  $w['wetHours'] = max($w['wetHours'] ?? 0, floor(wet_hours_from_log($now, $log)));
  return $w;
}

// ---------- Consulta con caché ----------
function get_weather(array $cfg, array $extra = []): array {
  $lat = $cfg['lat']; $lng = $cfg['lng']; $station = $cfg['metarStation'] ?? 'SERO'; $owmKey = $cfg['owmKey'] ?? '';
  $key = "$lat,$lng,$station," . ($owmKey ? 1 : 0); $now = now_ms();
  $c = cache_get('weather'); $have = $c && ($c['key'] ?? '') === $key;
  if ($have && $now - $c['at'] < AV_TTL) $remote = $c['remote'];
  elseif ($have && PHP_SAPI !== 'cli') { // aunque el dato sea viejo: la página vuelve a pedir a los 12 s y recibe el nuevo (la tarea programada sí espera el dato nuevo)
    // Nadie espera a las fuentes: se responde con el último dato y se renueva después de enviar la respuesta
    $remote = $c['remote'];
    $lk = cache_get('wx_refresh');
    if (!$lk || $now - ($lk['at'] ?? 0) > 60000) { cache_put('wx_refresh', ['at' => $now]); register_shutdown_function(function () use ($cfg) { if (function_exists('fastcgi_finish_request')) fastcgi_finish_request(); weather_fetch($cfg); }); }
  }
  else $remote = weather_fetch($cfg);
  $w = combine($remote, $extra);
  return !empty($w['ok']) ? apply_rain_log($w) : $w;
}
// Pide a la vez todas las fuentes vencidas y guarda el resultado
function weather_fetch(array $cfg): array {
  $lat = $cfg['lat']; $lng = $cfg['lng']; $station = $cfg['metarStation'] ?? 'SERO'; $owmKey = $cfg['owmKey'] ?? '';
  $key = "$lat,$lng,$station," . ($owmKey ? 1 : 0); $now = now_ms();
  {
    $ua = ['user-agent' => AV_UA]; $reqs = [];
    $om = cache_get('om') ?: [];
    $omFresh = !empty($om['models']) && ($om['key'] ?? '') === "$lat,$lng" && $now - ($om['at'] ?? 0) < OM_TTL;
    $omBlocked = $now < ($om['blockedUntil'] ?? 0) && ($om['key'] ?? '') === "$lat,$lng";
    if (!$omFresh && !$omBlocked) $reqs['om'] = ['url' => om_url($lat, $lng, implode(',', array_keys(MODELS))), 'timeout' => 10, 'headers' => $ua];
    $mn = cache_get('metno'); $mnFresh = $mn && ($mn['key'] ?? '') === "$lat,$lng" && $now - $mn['at'] < OM_TTL;
    if (!$mnFresh) $reqs['metno'] = ['url' => metno_url($lat, $lng), 'timeout' => 8, 'headers' => ['user-agent' => METNO_UA]];
    $mt = cache_get('metar'); $mtFresh = $mt && ($mt['station'] ?? '') === $station && $now < ($mt['until'] ?? 0);
    if ($station && !$mtFresh) {
      $reqs['awc'] = ['url' => "https://aviationweather.gov/api/data/metar?ids=$station&format=json&hours=3", 'timeout' => 12, 'headers' => $ua];
      $reqs['noaa'] = ['url' => "https://tgftp.nws.noaa.gov/data/observations/metar/stations/$station.TXT", 'timeout' => 12, 'headers' => $ua];
    }
    $ow = cache_get('owm'); $owFresh = $ow && ($ow['key'] ?? '') === "$lat,$lng,$owmKey" && $now - $ow['at'] < AV_TTL;
    if ($owmKey && !$owFresh) $reqs['owm'] = ['url' => "https://api.openweathermap.org/data/2.5/weather?lat=$lat&lon=$lng&appid=" . urlencode($owmKey) . '&units=metric&lang=es', 'timeout' => 8, 'headers' => $ua];
    $wt = cache_get('wttr'); $wtFresh = $wt && ($wt['key'] ?? '') === "$lat,$lng" && $now - $wt['at'] < 600000;
    if (!$wtFresh) $reqs['wttr'] = ['url' => "https://wttr.in/$lat,$lng?format=j1", 'timeout' => 10, 'headers' => $ua];
    $rv = cache_get('radarsrc'); $rvFresh = $rv && ($rv['key'] ?? '') === "$lat,$lng" && $now - $rv['at'] < 240000;
    if (!$rvFresh) $reqs['rvmaps'] = ['url' => 'https://api.rainviewer.com/public/weather-maps.json', 'timeout' => 8, 'headers' => $ua];
    $res = $reqs ? http_multi($reqs) : [];
    // Copia de la respuesta cruda para el puente de Render (/api/public/om-relay)
    if (isset($res['om']) && !$res['om']['err'] && $res['om']['code'] === 200) @file_put_contents(data_dir() . '/cache/omrelay.json', $res['om']['body']);
    if (isset($res['om'])) $omModels = om_process($res['om'], $lat, $lng);
    elseif ($omBlocked) $omModels = om_blocked_models($om);
    else $omModels = $om['models'];
    if (isset($res['metno'])) { $metno = metno_parse($res['metno']); cache_put('metno', ['key' => "$lat,$lng", 'at' => $now, 'data' => $metno]); } else $metno = $mn['data'];
    if (!$station) $metar = null;
    elseif (isset($res['awc'])) { $metar = metar_parse($res['awc'], $res['noaa'] ?? null, $station); cache_put('metar', ['station' => $station, 'until' => $now + ($metar['ok'] ? AV_TTL : 180000), 'data' => $metar]); }
    else $metar = $mt['data'];
    if (!$owmKey) $owm = ['id' => 'owm', 'kind' => 'pronóstico', 'name' => 'OpenWeatherMap', 'ok' => false, 'disabled' => true, 'intensity' => 0, 'error' => 'sin API key'];
    elseif (isset($res['owm'])) { $owm = owm_parse($res['owm']); cache_put('owm', ['key' => "$lat,$lng,$owmKey", 'at' => $now, 'data' => $owm]); } else $owm = $ow['data'];
    if (isset($res['wttr'])) { $wttr = wttr_parse($res['wttr']); cache_put('wttr', ['key' => "$lat,$lng", 'at' => $now, 'data' => $wttr]); } else $wttr = $wt['data'];
    if (isset($res['rvmaps'])) { $radar = radar_source($lat, $lng, $res['rvmaps']); cache_put('radarsrc', ['key' => "$lat,$lng", 'at' => $now, 'data' => $radar]); } else $radar = $rv['data'];
    $remote = ['models' => array_merge($omModels, [$metno]), 'metar' => $metar, 'owm' => $owm, 'radar' => $radar, 'wttr' => $wttr, 'at' => gmdate('c')];
    cache_put('weather', ['at' => $now, 'key' => $key, 'remote' => $remote]);
  }
  return $remote;
}

// ---------- Combinar fuentes ----------
function combine(array $remote, array $extra = []): array {
  $models = $remote['models']; $metar = $remote['metar'] ?? null; $owm = $remote['owm'] ?? null; $radar = $remote['radar'] ?? null; $wttr = $remote['wttr'] ?? null; $at = $remote['at'];
  $lightning = $remote['lightning'] ?? null; // en PHP no hay detector de rayos en vivo (necesita un proceso siempre encendido)
  // wttr.in es pronóstico: su "tormenta ahora" solo cuenta si el aeropuerto la confirma
  if (!empty($wttr['ok']) && !empty($wttr['thunderNow']) && !(($lightning['strikes15'] ?? 0) > 0 || !empty($metar['ts'])))
    $wttr = array_merge($wttr, ['thunderNow' => false, 'detail' => ($wttr['detail'] ?? '') . ' · sin rayos detectados: no cuenta como tormenta']);
  // El aeropuerto reporta cada hora; el radar, cada 10 min. Si un radar al menos 30 min más reciente ya no ve lluvia ni sobre la ciudad
  // ni cerca, la lluvia de ese reporte viejo ya pasó: no cuenta ni como lluvia ni para respaldar a los pronósticos (modelos, OWM).
  if (!empty($metar['ok']) && (!empty($metar['intensity']) || !empty($metar['near'])) && !empty($radar['ok']) && empty($radar['intensity']) && empty($radar['near'])
      && strtotime($radar['at']) - strtotime($metar['at']) >= 1800)
    $metar = array_merge($metar, ['intensity' => 0, 'rainNow' => 0, 'near' => false, 'detail' => ($metar['detail'] ?? '') . ' · el radar, más reciente, ya no ve lluvia: no cuenta']);
  $okM = array_values(array_filter($models, fn($m) => !empty($m['ok'])));
  $base = first_of($okM, fn($m) => $m['model'] === 'best_match') ?? first_of($okM, fn($m) => $m['model'] === 'met_no') ?? ($okM[0] ?? null);
  // Los modelos y wttr.in son pronósticos: el respaldo tiene que ser una observación real (radar o aeropuerto)
  $rOk = !empty($radar['ok']); $mOk = !empty($metar['ok']);
  // "Lluvia en los alrededores" del aeropuerto (VCSH) no respalda a los pronósticos si el radar no ve nada sobre la ciudad ni cerca
  $radarDry = $rOk && empty($radar['intensity']) && empty($radar['near']);
  $corro = ($rOk && (($radar['intensity'] ?? 0) > 0 || !empty($radar['near']))) || ($mOk && (($metar['intensity'] ?? 0) > 0 || (!empty($metar['near']) && !$radarDry)));
  if ($mOk && empty($metar['intensity']) && !empty($metar['near']) && $radarDry) $metar = array_merge($metar, ['detail' => ($metar['detail'] ?? '') . ' · el radar no la ve cerca de la ciudad: no respalda a los pronósticos']);
  // OpenWeatherMap: su "clima actual" es un modelo. Su lluvia solo cuenta si el radar o el aeropuerto la confirman.
  if (!empty($owm['ok']) && !empty($owm['intensity']) && !$corro) $owm = array_merge($owm, ['intensity' => 0, 'rainNow' => 0, 'detail' => ($owm['detail'] ?? '') . ' · el radar y el aeropuerto no ven lluvia: no cuenta']);
  // Y aun confirmada, OWM no puede decir que llueve más fuerte que lo que ven el radar o el aeropuerto (si solo la ven cerca: leve).
  elseif (!empty($owm['ok']) && !empty($owm['intensity'])) {
    $obsMax = max($rOk ? ($radar['intensity'] ?? 0) : 0, $mOk ? ($metar['intensity'] ?? 0) : 0, 1);
    if ($owm['intensity'] > $obsMax) $owm = array_merge($owm, ['intensity' => $obsMax, 'rainNow' => min($owm['rainNow'] ?? 0, INT_MM[$obsMax]), 'detail' => ($owm['detail'] ?? '') . ' · el radar/aeropuerto ven ' . mb_strtolower(INT_TXT[$obsMax]) . ': se cuenta así']);
  }
  $dryPre = ($rOk && empty($radar['intensity']) && empty($radar['near'])) || ($mOk && empty($metar['intensity']) && empty($metar['near']));
  $obsDry = !$corro && $dryPre;
  $fcStrong = !$dryPre && !empty($wttr['ok']) && ($wttr['mm'] ?? 0) >= 2.5 && first_of($okM, fn($m) => ($m['rainNow'] ?? 0) >= 2.5);
  $n = count($okM);
  $need = $n >= 6 ? 3 : ($n >= 3 ? 2 : ($corro || $fcStrong ? 1 : 99));
  if ($obsDry) $need = max($need, (int)ceil($n / 2), 3);
  $kth = function (array $arr) use ($need) { rsort($arr); return count($arr) >= $need ? $arr[$need - 1] : 0; };
  $clear = ($base['cloudCover'] ?? 100) < 50;
  $raining = array_values(array_filter($okM, fn($m) => $m['intensity'] > 0));
  $mInt = $clear ? 0 : $kth(array_map(fn($m) => $m['intensity'], $okM));
  $mRain = $mInt ? r1($kth(array_map(fn($m) => $m['rainNow'], $okM))) : 0;
  $omOk = count(array_filter($okM, fn($m) => $m['model'] !== 'met_no'));
  $stale = first_of($okM, fn($m) => !empty($m['stale']));
  $provs = implode(' + ', array_filter([$omOk ? 'Open-Meteo' : null, first_of($okM, fn($m) => $m['model'] === 'met_no') ? 'MET Norway' : null])) ?: 'Open-Meteo + MET Norway';
  $errs = array_values(array_unique(array_filter(array_map(fn($m) => $m['error'] ?? null, $models))));
  $needTxt = $need > $n ? ($n < 3 ? 'con tan pocos modelos hace falta que el radar o el aeropuerto confirmen' : 'el radar/aeropuerto no ven lluvia: hace falta la mitad de los modelos') : "hacen falta $need";
  $detail = !$okM ? 'Sin conexión con los pronósticos (' . implode(' · ', $errs) . ')'
    : ($stale ? "Dato de Open-Meteo de hace {$stale['staleMin']} min ({$stale['staleWhy']}) · " : '') . count($raining) . " de $n modelos ven lluvia medible"
      . ($raining ? ' (' . implode(', ', array_map(fn($m) => $m['name'], $raining)) . ')' : '') . "; $needTxt" . ($obsDry && $need <= $n ? ' (radar/aeropuerto secos)' : '')
      . ($clear && $raining ? ' · no cuenta: el cielo está casi despejado' : '') . ' · nubosidad ' . ($base['cloudCover'] ?? '—') . ' %';
  $modelSrc = ['id' => 'modelos', 'kind' => 'pronóstico', 'name' => "$provs · $n de " . count($models) . ' modelos', 'ok' => $n > 0, 'at' => $base['observedAt'] ?? null,
    'intensity' => $mInt, 'rainNow' => $mRain, 'detail' => $detail, 'error' => $okM ? null : ($models[0]['error'] ?? null),
    'models' => array_map(fn($m) => ['name' => $m['name'], 'ok' => $m['ok'], 'rainNow' => $m['rainNow'] ?? 0, 'intensity' => $m['intensity'] ?? 0, 'error' => $m['error'] ?? null, 'stale' => !empty($m['stale']) ? $m['staleMin'] : null], $models)];
  // El radar no ve lluvia sobre la ciudad ni cerca y ninguna otra observación la ve: los modelos (pronóstico) solos no dicen "está lloviendo ahora"
  if ($radarDry && !$corro && $modelSrc['intensity'] > 0)
    $modelSrc = array_merge($modelSrc, ['intensity' => 0, 'rainNow' => 0, 'detail' => $modelSrc['detail'] . ' · el radar no ve lluvia sobre la ciudad ni cerca: no cuenta como lluvia ahora']);
  $sources = array_values(array_filter(array_merge([$modelSrc, $metar, $owm, $radar, $wttr, $lightning], $extra)));
  // El equipo marcó "no llueve" en el centro: ni los pronósticos ni el aeropuerto (a unos 4 km) ni el radar encienden "lloviendo" mientras dure la marca.
  if (first_of($extra, fn($x) => ($x['id'] ?? '') === 'equipo' && !empty($x['ok']) && !empty($x['dry'])))
    $sources = array_map(fn($s) => !in_array($s['id'] ?? '', ['reportes', 'equipo'], true) && ($s['intensity'] ?? 0) > 0
      ? array_merge($s, ['intensity' => 0, 'rainNow' => 0, 'detail' => ($s['detail'] ?? INT_TXT[$s['intensity']]) . ' · el equipo marcó que no llueve en el centro: no cuenta']) : $s, $sources);
  $live = array_values(array_filter($sources, fn($s) => !empty($s['ok'])));
  if (!$live) return ['ok' => false, 'source' => 'Open-Meteo', 'error' => $modelSrc['error'] ?: 'sin conexión', 'rainNow' => 0, 'rainPast3h' => 0, 'rainNext3h' => 0, 'rainNext24h' => 0, 'hourly' => [], 'sources' => $sources, 'checkedAt' => $at];
  $top = $live[0];
  foreach ($live as $s) if (($s['intensity'] ?? 0) > ($top['intensity'] ?? 0) || (($s['intensity'] ?? 0) === ($top['intensity'] ?? 0) && ($s['rainNow'] ?? 0) > ($top['rainNow'] ?? 0))) $top = $s;
  $intensity = min(3, $top['intensity'] ?? 0); // 0–3: la tormenta eléctrica no es una intensidad de lluvia
  $pick = function ($k) use ($okM, $need, $kth) { $v = array_map(fn($m) => $m[$k] ?? 0, $okM); return r1(count($v) >= $need ? $kth($v) : fl_max($v)); };
  $baseCode = $base['weatherCode'] ?? 0; $baseRainy = $baseCode >= 50;
  $pk = function ($k) use ($base, $okM) { if (($base[$k] ?? null) !== null) return $base[$k]; $m = first_of($okM, fn($m) => ($m[$k] ?? null) !== null); return $m[$k] ?? null; };
  $w = ['ok' => true, 'sources' => $sources, 'checkedAt' => $at, 'modelsNeeded' => $need, 'decidedBy' => $intensity > 0 ? $top['name'] : null,
    'source' => implode(' + ', array_map(fn($s) => $s['id'] === 'modelos' ? "$provs ($n modelos)" : $s['name'], $live)),
    'observedAt' => ($intensity > 0 ? ($top['at'] ?? null) : ($base['observedAt'] ?? null)) ?: $at,
    'temperature' => (!empty($metar['ok']) ? ($metar['temperature'] ?? null) : null) ?? $pk('temperature') ?? ($owm['temperature'] ?? null), 'cloudCover' => max($base['cloudCover'] ?? 0, $owm['cloudCover'] ?? 0, $intensity ? 95 : 0),
    'rainNow' => $intensity ? r1(max(array_map(fn($s) => !empty($s['intensity']) ? ($s['rainNow'] ?? 0) : 0, $live))) : 0,
    'rainPast3h' => max($pick('rainPast3h'), $intensity >= 2 ? INT_MM[$intensity] : 0), 'rainPast6h' => $pick('rainPast6h'), 'rainPast12h' => $pick('rainPast12h'), 'wetHours' => $pick('wetHours'),
    'rainNext3h' => $pick('rainNext3h'), 'rainNext24h' => $pick('rainNext24h'), 'probNext3h' => null, 'maxProbability24h' => null,
    'weatherCode' => $intensity ? INT_CODE[$intensity] : ($baseRainy ? 3 : $baseCode), 'hourly' => merge_hourly($okM)];
  if ($intensity > 0 && $w['hourly']) $w['hourly'][0] = raining_now($w['hourly'][0], $w['rainNow']);
  if ($w['hourly']) {
    $w['probNext3h'] = max(array_map(fn($h) => $h['probability'], array_slice($w['hourly'], 0, 4)));
    $w['maxProbability24h'] = max(array_map(fn($h) => $h['probability'], array_slice($w['hourly'], 1, 24)) ?: [0]);
    $w['probEstimated'] = !array_filter(array_slice($w['hourly'], 0, 4), fn($h) => empty($h['estimated']));
  }
  $w['periods'] = day_parts($w['hourly']);
  // humedad y viento: del aeropuerto si hay reporte reciente; si no, del mejor modelo
  $obs = !empty($metar['ok']) && ($metar['temperature'] ?? null) !== null ? $metar : null;
  $hum = $obs['humidity'] ?? $pk('humidity'); $wind = $obs['wind'] ?? $pk('wind'); $gust = $pk('gust'); $w['tempFrom'] = $obs ? 'aeropuerto' : 'modelo';
  $w['humidity'] = $hum === null ? null : (int)round($hum); $w['wind'] = $wind === null ? null : (int)round($wind); $w['gust'] = $gust === null ? null : (int)round($gust);
  // Sensación térmica a la sombra (Steadman), como la publica el INAMHI. La de Open-Meteo suma el sol directo y daba 6–8 °C de más.
  $w['apparent'] = apparent_temp($w['temperature'], $w['humidity'], ($w['wind'] ?? 0) / 3.6);
  $w['heat'] = heat_info($w['apparent']);
  $sunSrc = $base['sun'] ?? null; if (!$sunSrc) { $m = first_of($okM, fn($m) => ($m['sun']['uvIndex'] ?? null) !== null); $sunSrc = $m['sun'] ?? null; }
  $w['sun'] = sun_info($sunSrc, $w['cloudCover'], $intensity);
  $w = array_merge($w, describe($w));
  if ($intensity !== $w['intensity']) $w = array_merge($w, ['intensity' => $intensity, 'raining' => $intensity > 0, 'condition' => $intensity ? INT_TXT[$intensity] : $w['condition']]);
  if (!$w['intensity'] && $w['sun'] && in_array($w['condition'], ['Despejado', 'Parcialmente nublado'], true) && ($w['condition'] === 'Despejado' || $w['sun']['sky'] === 'soleado'))
    $w['condition'] = $w['sun']['sky'] === 'noche' ? 'Noche despejada' : 'Soleado';
  $w['outlook'] = outlook_of($w, $okM, $metar, $need);
  $w['thunder'] = thunder_of($w, $okM, $metar, $radar, $wttr, $lightning, $extra);
  // Tormenta eléctrica en curso: se muestra y se avisa, pero el semáforo de inundación sigue la lluvia que cae
  $w['storm'] = !empty($w['thunder']['now']);
  if ($w['storm']) $w['condition'] = $w['intensity'] ? 'Tormenta con ' . mb_strtolower(INT_TXT[min(3, $w['intensity'])]) : 'Tormenta eléctrica sin lluvia';
  return $w;
}

function merge_hourly(array $okM): array {
  $withH = array_values(array_filter($okM, fn($m) => !empty($m['hourly'])));
  if (!$withH) return [];
  $firsts = array_map(fn($m) => $m['hourly'][0]['time'], $withH); sort($firsts); $start = end($firsts);
  $times = []; foreach ($withH as $m) foreach ($m['hourly'] as $h) $times[$h['time']] = true;
  $times = array_keys($times); sort($times); $times = array_slice(array_values(array_filter($times, fn($t) => $t >= $start)), 0, 25);
  $by = array_map(function ($m) { $a = []; foreach ($m['hourly'] as $h) $a[$h['time']] = $h; return $a; }, $withH);
  $out = [];
  foreach ($times as $time) {
    $at = []; foreach ($by as $b) { $h = $b[$time] ?? null; if ($h && $h['precipitation'] !== null) $at[] = $h; }
    $mm = array_map(fn($h) => $h['precipitation'], $at); $n = count($mm); $wet = count(array_filter($mm, fn($v) => $v >= WET_MM)); $max = $n ? max($mm) : 0;
    $api = []; foreach ($at as $h) if ($h['probability'] !== null) $api[] = $h['probability'];
    $pApi = $api ? array_sum($api) / count($api) : null;
    if ($n >= 3) $pModels = ($wet / $n) * 100; else { $pModels = 0; foreach (P_MM as [$min, $p]) if ($max >= $min) { $pModels = $p; break; } }
    $p = max($pApi ?? 0, $pModels);
    $avg = fn($arr) => $arr ? array_sum($arr) / count($arr) : 0; $wetMm = array_values(array_filter($mm, fn($v) => $v >= WET_MM));
    $row = ['time' => $time, 'probability' => (int)min(100, round($p / 5) * 5), 'precipitation' => r1($wet * 3 >= $n ? $avg($wetMm) : $avg($mm)), 'precipMax' => r1($max), 'wet' => $wet, 'of' => $n];
    if ($pApi === null || $pModels > $pApi) $row['estimated'] = true;
    if (array_filter($at, fn($h) => !empty($h['thunder']))) $row['thunder'] = true;
    $out[] = $row;
  }
  return $out;
}
function raining_now(array $h, $mm): array { unset($h['estimated']); return array_merge($h, ['probability' => 100, 'precipitation' => max($h['precipitation'] ?? 0, r1($mm))]); }
function day_parts(array $hourly): array {
  $part = fn($h) => $h < 6 ? 'Madrugada' : ($h < 12 ? 'Mañana' : ($h < 18 ? 'Tarde' : 'Noche'));
  $out = [];
  foreach (array_slice($hourly ?: [], 0, 24) as $h) {
    $hr = (int)substr($h['time'], 11, 2); $day = substr($h['time'], 0, 10); $key = "$day-" . $part($hr);
    $i = count($out) - 1;
    if ($i < 0 || $out[$i]['key'] !== $key) { $out[] = ['key' => $key, 'label' => $part($hr), 'day' => $day, 'from' => $h['time'], 'to' => $h['time'], 'probability' => 0, 'precipitation' => 0, 'hours' => 0]; $i = count($out) - 1; }
    $out[$i]['to'] = $h['time']; $out[$i]['hours']++; $out[$i]['probability'] = max($out[$i]['probability'], $h['probability']); $out[$i]['precipitation'] = r1($out[$i]['precipitation'] + $h['precipitation']);
  }
  if (count($out) > 1 && $out[count($out) - 1]['hours'] < 2) array_pop($out);
  return array_map(function ($p) { unset($p['key']); return $p; }, $out);
}
function outlook_of(array $w, array $okM, $metar, int $need): array {
  $reasons = []; $score = 0;
  $peak = max(array_merge([0], array_map(fn($h) => $h['probability'] ?? 0, array_slice($w['hourly'] ?? [], 0, 7))));
  if ($peak >= NOTICE_PROB) { $score += 3; $reasons[] = "probabilidad de lluvia de $peak % en las próximas 6 h"; }
  $wet = array_values(array_filter($okM, fn($m) => ($m['rainNext3h'] ?? 0) >= MIN_MM));
  if ($wet) { $score += count($wet) >= $need ? 2 : 1; $reasons[] = count($wet) . ' de ' . count($okM) . ' modelos prevén lluvia en las próximas 3 h (hasta ~' . str_replace('.', ',', (string)r1(max(array_map(fn($m) => $m['rainNext3h'], $wet)))) . ' mm)'; }
  $cape = max(array_merge([-1], array_map(fn($m) => $m['capeMax6h'] ?? -1, $okM)));
  if ($cape >= 1000) { $score += $cape >= 2000 ? 2 : 1; $reasons[] = 'el aire tiene energía para formar aguaceros (ambiente de tormenta' . ($cape >= 2000 ? ' fuerte' : '') . ')'; }
  if (array_filter($okM, fn($m) => !empty($m['thunder6h']))) { $score += 1; $reasons[] = 'MET Norway prevé tormenta en las próximas 6 h'; }
  if (!empty($metar['ok']) && !empty($metar['ts'])) { $score += 2; $reasons[] = 'el aeropuerto reporta tormenta en la zona'; }
  elseif (!empty($metar['ok']) && !empty($metar['near'])) { $score += 2; $reasons[] = 'el aeropuerto ve lluvia en los alrededores'; }
  elseif (!empty($metar['ok']) && !empty($metar['cb'])) { $score += 1; $reasons[] = 'el aeropuerto ve nubes de tormenta (cumulonimbos) cerca'; }
  $from = null; foreach (array_slice($w['hourly'] ?? [], 0, 7) as $h) if (($h['probability'] ?? 0) >= NOTICE_PROB) { $from = $h['time']; break; }
  // Si esa hora es la que está corriendo (p. ej. son las 09:16 y la hora es 09:00), no se dice "desde las 09:00": ya empezó
  $fromNow = $from !== null && $from === ($w['hourly'][0]['time'] ?? null);
  $level = $w['intensity'] > 0 ? 'lloviendo' : ($peak >= NOTICE_PROB ? 'probable' : 'calma');
  $title = ['lloviendo' => 'Está lloviendo', 'probable' => 'Lluvia probable en las próximas horas', 'calma' => 'Sin lluvia a la vista'][$level];
  $text = $level === 'lloviendo' ? 'Revisa las calles inundadas y las vías alternas antes de salir.'
    : ($level === 'calma' ? 'No hay una probabilidad alta de lluvia (' . NOTICE_PROB . ' % o más) en las próximas 6 horas.'
    : 'Ahora no llueve, pero es probable un aguacero' . ($fromNow ? ' en cualquier momento de esta hora' : ($from ? ' desde las ' . substr($from, 11, 5) . ', aproximadamente' : '')) . '. Lleva paraguas y evita las calles que suelen inundarse.');
  return ['level' => $level, 'score' => $score, 'title' => $title, 'text' => $text, 'reasons' => $level === 'calma' ? [] : $reasons, 'from' => $from, 'fromNow' => $fromNow, 'peak' => $peak, 'min' => NOTICE_PROB];
}

// Probabilidad de tormenta eléctrica en las próximas 6 h (modelos, CAPE, aeropuerto, radar, wttr.in y el equipo)
function thunder_of(array $w, array $okM, $metar, $radar, $wttr, $lightning, array $extra): array {
  $reasons = []; $n = count($okM) ?: 1;
  $votes = count(array_filter($okM, fn($m) => !empty($m['thunderCode6h']) || !empty($m['thunder6h'])));
  $cape = max(array_merge([-1], array_map(fn($m) => $m['capeMax6h'] ?? -1, $okM)));
  $capeP = $cape < 300 ? 0 : ($cape < 1000 ? 10 + ($cape - 300) / 700 * 20 : ($cape < 2000 ? 30 + ($cape - 1000) / 1000 * 25 : min(75, 55 + ($cape - 2000) / 1500 * 20)));
  $peak = max(array_merge([0], array_map(fn($h) => $h['probability'] ?? 0, array_slice($w['hourly'] ?? [], 0, 7))));
  $p = max($votes / $n * 85, $capeP);
  if ($votes) $reasons[] = "$votes de $n modelos prevén tormenta eléctrica en las próximas 6 h";
  if ($cape >= 1000) $reasons[] = 'el aire tiene energía para tormentas' . ($cape >= 2000 ? ' fuertes' : '') . ' (CAPE ' . round($cape) . ' J/kg)';
  if ($peak >= 60 && $cape >= 800) { $p += 12; $reasons[] = "probabilidad de lluvia de $peak %"; }
  $mOk = !empty($metar['ok']); $rOk = !empty($radar['ok']); $wOk = !empty($wttr['ok']);
  if ($mOk && !empty($metar['cb'])) { $p = max($p, 60); $reasons[] = 'el aeropuerto ve nubes de tormenta (cumulonimbos) cerca'; }
  if ($rOk && ($radar['dbz'] ?? -1) >= 45) { $p = max($p, $radar['dbz'] >= 50 ? 85 : 70); $reasons[] = "el radar ve un núcleo de tormenta sobre la ciudad ({$radar['dbz']} dBZ)"; }
  elseif ($rOk && ($radar['dbzNear'] ?? -1) >= 45) { $p = max($p, 55); $reasons[] = "el radar ve un núcleo de tormenta cerca ({$radar['dbzNear']} dBZ)"; }
  if ($wOk && ($wttr['thunderChance'] ?? 0) >= 20) { $p = max($p, min(85, round($wttr['thunderChance'] * 0.9))); $reasons[] = "World Weather Online da {$wttr['thunderChance']} % de probabilidad de tormenta eléctrica"; }
  $lg = !empty($lightning['ok']) ? $lightning : null;
  if (($lg['strikes15'] ?? 0) > 0) { $p = 90; $k = ($lg['strikes10'] ?? 0) ?: $lg['strikes15']; $reasons[] = "se detectaron $k rayo" . ($k > 1 ? 's' : '') . ' a menos de 15 km en los últimos minutos'; }
  elseif (($lg['strikes30'] ?? 0) > 0) { $p = max($p, 75); $reasons[] = "hay rayos a menos de 30 km (el más cercano a {$lg['nearestKm']} km)"; }
  elseif (($lg['strikes60'] ?? 0) > 0) { $p = max($p, 55); $reasons[] = "hay rayos a menos de 60 km (el más cercano a {$lg['nearestKm']} km)"; }
  $team = (bool)first_of($extra, fn($x) => ($x['id'] ?? '') === 'equipo' && !empty($x['ok']) && !empty($x['storm']));
  if ($team) $reasons[] = 'el equipo EMOVTT confirma tormenta eléctrica';
  $mStorm = count(array_filter($okM, fn($m) => !empty($m['storm']))) >= ($w['modelsNeeded'] ?? 99);
  if ($mStorm) $reasons[] = 'varios modelos ven tormenta eléctrica en este momento';
  $now = $mStorm || ($w['weatherCode'] ?? 0) >= 95 || ($mOk && !empty($metar['ts'])) || $team || ($wOk && !empty($wttr['thunderNow'])) || (($lg['strikes15'] ?? 0) > 0);
  if ($mOk && !empty($metar['ts'])) { $p = max($p, 90); $reasons[] = 'el aeropuerto reporta tormenta en la zona'; }
  if (($w['weatherCode'] ?? 0) >= 95) { $p = max($p, 90); $reasons[] = 'hay tormenta eléctrica ahora mismo'; }
  $activity = null;
  if ($now) {
    $vals = [$rOk ? ($radar['rainNow'] ?? 0) : 0, $wOk ? ($wttr['mm'] ?? 0) : 0];
    foreach ($okM as $m) $vals[] = $m['rainNow'] ?? 0;
    foreach ($extra as $x) if (!empty($x['ok']) && !empty($x['storm'])) $vals[] = $x['rainNow'] ?? 0;
    $rm = max($vals); $dbz = $rOk ? ($radar['dbz'] ?? -1) : -1; $rate = $lg['strikes10'] ?? 0;
    $lv = $dbz >= 50 || $rm >= 8 || $rate >= 20 ? 3 : ($dbz >= 45 || $rm >= 2.5 || $rate >= 6 ? 2 : 1);
    $activity = ['level' => $lv, 'label' => ['', 'Tormenta leve', 'Tormenta moderada', 'Tormenta intensa'][$lv], 'mm' => r1($rm)];
  }
  $p = $now ? max(90, (int)round($p)) : max(0, min(90, (int)(round($p / 5) * 5)));
  $level = $now ? 'activa' : ($p >= 70 ? 'alta' : ($p >= 40 ? 'moderada' : ($p >= 15 ? 'baja' : 'nula')));
  $label = ['activa' => 'Tormenta ahora', 'alta' => 'Alta', 'moderada' => 'Moderada', 'baja' => 'Baja', 'nula' => 'Muy baja'][$level];
  $text = ['activa' => 'Hay tormenta eléctrica. Busca refugio bajo techo, evita árboles y zonas abiertas, y no cruces calles inundadas.',
    'alta' => 'Es muy probable una tormenta eléctrica en las próximas horas. Evita salir y mantente lejos de ríos y calles que se inundan.',
    'moderada' => 'Puede haber tormenta eléctrica en las próximas horas. Revisa el cielo y ten un plan por si cae un aguacero fuerte.',
    'baja' => 'Hay poca probabilidad de tormenta eléctrica, pero conviene revisar el clima si vas a salir.',
    'nula' => 'No se espera tormenta eléctrica en las próximas 6 horas.'][$level];
  return ['prob' => $p, 'level' => $level, 'label' => $label, 'text' => $text, 'reasons' => $level === 'nula' ? [] : $reasons, 'now' => $now, 'activity' => $activity,
    'models' => ['votes' => $votes, 'of' => $n], 'cape' => $cape >= 0 ? (int)round($cape) : null];
}

// ---------- Sensación térmica, calor, sol y UV ----------
function apparent_temp($t, $rh, $ws) {
  if ($t === null || $rh === null) return null;
  $e = $rh / 100 * 6.105 * exp(17.27 * $t / (237.7 + $t));
  return r1($t + 0.33 * $e - 0.70 * ($ws ?: 0) - 4);
}
function heat_info($app): ?array {
  if ($app === null) return null;
  foreach ([[41, 'peligro', 'Calor peligroso', 'Evita el sol y el esfuerzo; hidrátate y busca lugares frescos. Riesgo de golpe de calor.'],
    [32, 'extremo', 'Muy caluroso', 'Toma agua seguido, descansa a la sombra y evita actividad intensa al mediodía.'],
    [27, 'caluroso', 'Caluroso', 'Hidrátate y usa ropa ligera. Cuida a niños y adultos mayores.'],
    [18, 'agradable', 'Agradable', ''], [-99, 'fresco', 'Fresco', 'Lleva una prenda de abrigo.']] as $x)
    if ($app >= $x[0]) return ['key' => $x[1], 'label' => $x[2], 'advice' => $x[3]];
  return null;
}
function uv_level($v): array {
  foreach ([[11, 'extremo', 'Extremo', 'Evita salir al sol; si sales, protector, gorra, lentes y ropa que cubra.'], [8, 'muy-alto', 'Muy alto', 'Evita el sol de 10:00 a 15:00. Protector solar, gorra y lentes.'],
    [6, 'alto', 'Alto', 'Usa protector solar y gorra; busca sombra al mediodía.'], [3, 'moderado', 'Moderado', 'Protector solar si vas a estar más de 30 minutos al sol.'], [0, 'bajo', 'Bajo', 'Sin riesgo por el sol.']] as $u)
    if (($v ?? 0) >= $u[0]) return ['key' => $u[1], 'label' => $u[2], 'advice' => $u[3]];
  return ['key' => 'bajo', 'label' => 'Bajo', 'advice' => 'Sin riesgo por el sol.'];
}
function sun_info($s, $cloud, $intensity) {
  if (!$s) return null;
  $night = ($s['isDay'] ?? null) === 0; $c = $cloud ?? 0;
  $strong = !$night && $c < 80 && (($s['radiation'] ?? 0) >= 550 || ($s['uvIndex'] ?? 0) >= 4.5);
  $sky = $intensity > 0 ? 'lluvia' : ($night ? 'noche' : ($strong ? 'soleado' : ($c >= 80 ? 'nublado' : ($c >= 40 ? 'parcial' : 'soleado'))));
  $uv = ($s['uvIndex'] ?? null) === null ? null : round($s['uvIndex'] * 10) / 10;
  return array_merge($s, ['uvIndex' => $uv, 'uvMax' => ($s['uvMax'] ?? null) === null ? null : round($s['uvMax'] * 10) / 10, 'radiation' => ($s['radiation'] ?? null) === null ? null : (int)round($s['radiation']),
    'sky' => $sky, 'uv' => uv_level($night ? 0 : $uv), 'uvMaxLevel' => uv_level($s['uvMax'] ?? null)]);
}

// ---------- Fuentes locales (solo lo que marca el equipo; los reportes ciudadanos ya no cambian el clima) ----------
function local_sources(?array $observed): array {
  $out = [];
  // "No llueve": el equipo ve la calle seca en el centro. Manda sobre los pronósticos y las estaciones de afuera (ver combine).
  if ($observed && !empty($observed['dry']) && strtotime($observed['until']) > time())
    $out[] = ['id' => 'equipo', 'kind' => 'observación', 'name' => 'Equipo EMOVTT', 'ok' => true, 'at' => $observed['at'], 'intensity' => 0, 'rainNow' => 0, 'dry' => true,
      'detail' => 'No llueve en el centro (marcado en el panel) · vigente hasta ' . hhmm_local(strtotime($observed['until']))];
  elseif ($observed && strtotime($observed['until']) > time()) {
    // "Tormenta" (4) del equipo = truenos y rayos con lluvia moderada: el semáforo sigue a la lluvia, la tormenta se avisa aparte
    $o = max(0, min(4, (int)($observed['intensity'] ?? 0))); $i = $o >= 4 ? 2 : $o;
    $out[] = ['id' => 'equipo', 'kind' => 'observación', 'name' => 'Equipo EMOVTT', 'ok' => true, 'at' => $observed['at'], 'intensity' => $i, 'rainNow' => INT_MM[$i], 'storm' => $o >= 4 ?: null,
      'detail' => INT_TXT[$o] . ' marcada en el panel · vigente hasta ' . hhmm_local(strtotime($observed['until']))];
  }
  return $out;
}

function describe(array $w): array {
  static $CODE = [51 => [1, 'Llovizna'], 53 => [1, 'Llovizna'], 55 => [2, 'Llovizna intensa'], 56 => [1, 'Llovizna'], 57 => [2, 'Llovizna intensa'], 61 => [1, 'Lluvia leve'], 63 => [2, 'Lluvia moderada'], 65 => [3, 'Lluvia fuerte'],
    66 => [1, 'Lluvia leve'], 67 => [3, 'Lluvia fuerte'], 80 => [1, 'Chubascos leves'], 81 => [2, 'Chubascos moderados'], 82 => [3, 'Chubascos fuertes'], 95 => [0, 'Tormenta eléctrica'], 96 => [0, 'Tormenta con granizo'], 99 => [0, 'Tormenta con granizo']];
  [$codeInt, $codeTxt] = $CODE[$w['weatherCode'] ?? -1] ?? [0, ''];
  $m = mm_int($w['rainNow'] ?? 0); $intensity = max($codeInt, $m);
  $cc = $w['cloudCover'] ?? 0;
  $condition = $codeTxt ?: ($m === 3 ? 'Lluvia fuerte' : ($m === 2 ? 'Lluvia moderada' : ($m === 1 ? 'Lluvia leve' : ($cc >= 70 ? 'Nublado' : ($cc >= 30 ? 'Parcialmente nublado' : 'Despejado')))));
  return ['raining' => $intensity > 0, 'intensity' => $intensity, 'condition' => $condition, 'storm' => ($w['weatherCode'] ?? 0) >= 95];
}

// ---------- Marea ----------
function get_tide(array $cfg): array {
  $lat = $cfg['lat']; $lng = $cfg['lng']; $key = "$lat,$lng"; $c = cache_get('tide');
  if ($c && ($c['key'] ?? '') === $key && now_ms() - $c['at'] < AV_TTL * 3) return $c['data'];
  if ($c && ($c['key'] ?? '') === $key && now_ms() - $c['at'] < 6 * 3600000) {
    cache_put('tide', array_merge($c, ['at' => now_ms() - AV_TTL * 3 + 120000])); // nadie más la renueva en 2 min
    register_shutdown_function(function () use ($cfg) { if (function_exists('fastcgi_finish_request')) fastcgi_finish_request(); tide_fetch($cfg); });
    return $c['data'];
  }
  return tide_fetch($cfg);
}
function tide_fetch(array $cfg): array {
  $lat = $cfg['lat']; $lng = $cfg['lng']; $key = "$lat,$lng";
  try {
    $url = 'https://marine-api.open-meteo.com/v1/marine?' . http_build_query(['latitude' => $lat, 'longitude' => $lng, 'hourly' => 'sea_level_height_msl', 'forecast_hours' => 24, 'past_hours' => 1, 'timezone' => 'America/Guayaquil', 'cell_selection' => 'sea']);
    $j = http_json(http_one(['url' => $url, 'timeout' => 8]));
    $v = array_values(array_filter($j['hourly']['sea_level_height_msl'] ?? [], fn($x) => $x !== null));
    if (count($v) < 3) throw new RuntimeException('sin datos de marea');
    $min = min($v); $max = max($v); $now = $v[1] ?? $v[0];
    $data = ['ok' => true, 'source' => 'Open-Meteo Marine', 'levelM' => round($now, 2), 'relative' => $max > $min ? round(($now - $min) / ($max - $min), 2) : 0];
  } catch (Throwable $e) { $data = ['ok' => false, 'source' => 'Open-Meteo Marine', 'error' => $e->getMessage(), 'relative' => 0]; }
  cache_put('tide', ['at' => now_ms(), 'key' => $key, 'data' => $data]);
  return $data;
}

// ---------- Índice de riesgo y nivel ----------
// lluvia actual 30 · pronóstico 24 h 25 · ríos 20 · marea 10 (los reportes ciudadanos ya no suman)
function risk_index(array $w, array $cfg, $flood, $tide, array $rivers): array {
  $t = (float)($cfg['rainThresholdMm'] ?? 2.4) ?: 2.4; $t3 = (float)($cfg['rainThresholdMm3h'] ?? 7) ?: 7;
  $clamp = fn($x) => max(0, min(1, $x)); $parts = [];
  $ok = !empty($w['ok']); $i = $w['intensity'] ?? 0;
  $rainNow = $ok ? $clamp(max(($w['rainNow'] ?? 0) / ($t * 3), ($i ? ($w['rainPast3h'] ?? 0) : 0) / ($t3 * 2), [0, 0.25, 0.5, 0.8, 1][$i])) : 0;
  $parts[] = ['key' => 'lluvia', 'label' => 'Lluvia actual', 'max' => 30, 'value' => (int)round($rainNow * 30), 'ok' => $ok];
  $fc = $ok ? $clamp(($w['rainNext24h'] ?? 0) / ($t3 * 3)) * $clamp(($w['maxProbability24h'] ?? 100) / 100 + 0.3) : 0;
  $parts[] = ['key' => 'pronostico', 'label' => 'Pronóstico 24 h', 'max' => 25, 'value' => (int)round($fc * 25), 'ok' => $ok];
  $sev = ['EXTREME' => 1, 'SEVERE' => 0.75, 'ABOVE_NORMAL' => 0.4];
  $local = max(array_merge([0], array_map(fn($r) => ['desbordado' => 1, 'crecido' => 0.6][$r['status'] ?? ''] ?? 0, $rivers)));
  $river = max($local, !empty($flood['ok']) ? max(array_merge([0], array_map(fn($g) => $sev[$g['severity'] ?? ''] ?? 0, $flood['gauges'] ?? []))) : 0);
  $parts[] = ['key' => 'rios', 'label' => 'Ríos', 'max' => 20, 'value' => (int)round($river * 20), 'ok' => !empty($flood['ok']) || count($rivers) > 0];
  $tv = !empty($tide['ok']) ? $clamp(($tide['relative'] - 0.5) * 2) : 0;
  $parts[] = ['key' => 'marea', 'label' => 'Marea', 'max' => 10, 'value' => (int)round($tv * 10), 'ok' => !empty($tide['ok'])];
  $value = array_sum(array_map(fn($p) => $p['value'], $parts));
  return ['value' => $value, 'parts' => $parts, 'level' => $value >= 70 ? 'roja' : ($value >= 50 ? 'naranja' : ($value >= 30 ? 'amarilla' : 'normal'))];
}
// Nivel sugerido por el clima. Los acumulados (3, 6 y 12 h) y las horas seguidas de lluvia solo cuentan mientras sigue lloviendo.
function level_from_weather(array $w, array $cfg): string { return level_why($w, $cfg)['level']; }
// El mismo cálculo con el motivo en palabras. Con lluvia leve ya no se queda en roja por lo que cayó antes: baja a naranja.
function mm_txt(float $x): string { return str_replace('.', ',', (string)(round($x * 10) / 10)) . ' mm'; }
function level_why(array $w, array $cfg): array {
  if (empty($w['ok'])) return ['level' => 'normal', 'why' => ''];
  $t = (float)($cfg['rainThresholdMm'] ?? 2.4) ?: 2.4; $t3 = (float)($cfg['rainThresholdMm3h'] ?? 7) ?: 7; $i = min(3, (int)($w['intensity'] ?? 0));
  $p3 = $w['rainPast3h'] ?? 0; $p6 = $w['rainPast6h'] ?? 0; $p12 = $w['rainPast12h'] ?? 0; $wet = $w['wetHours'] ?? 0; $now = $w['rainNow'] ?? 0;
  $it = ['', 'lluvia leve', 'lluvia moderada', 'lluvia fuerte'][$i];
  if (!$i) return (($w['probNext3h'] ?? 0) >= 80 && ($w['rainNext3h'] ?? 0) >= $t / 2) ? ['level' => 'amarilla', 'why' => "lluvia casi segura en las próximas 3 h ({$w['probNext3h']} %)"] : ['level' => 'normal', 'why' => ''];
  if ($now >= $t * 3) return ['level' => 'roja', 'why' => "$it de " . mm_txt($now) . '/h'];
  if ($i >= 2 && ($p3 >= $t3 * 2 || $p6 >= $t3 * 3 || $p12 >= $t3 * 5)) { [$v, $h] = $p3 >= $t3 * 2 ? [$p3, 3] : ($p6 >= $t3 * 3 ? [$p6, 6] : [$p12, 12]); return ['level' => 'roja', 'why' => "$it con " . mm_txt($v) . " acumulados en $h h"]; }
  if ($now >= $t || $i >= 3) return ['level' => 'naranja', 'why' => "$it de " . mm_txt($now) . '/h'];
  if ($p3 >= $t3 || $p6 >= $t3 * 1.6 || $p12 >= $t3 * 2.7) { [$v, $h] = $p3 >= $t3 ? [$p3, 3] : ($p6 >= $t3 * 1.6 ? [$p6, 6] : [$p12, 12]); return ['level' => 'naranja', 'why' => "sigue la $it con " . mm_txt($v) . " acumulados en $h h"]; }
  if ($wet >= 3 && $p6 >= $t3 * 0.9) return ['level' => 'naranja', 'why' => "$wet h seguidas lloviendo (" . mm_txt($p6) . ' en 6 h)'];
  if ($p3 >= $t3 * 0.6 && $now >= $t / 2) return ['level' => 'naranja', 'why' => "$it con " . mm_txt($p3) . ' en las últimas 3 h'];
  return ['level' => 'amarilla', 'why' => "$it en curso"];
}

// ---------- Pronóstico por días (ayer, hoy y 2 días) ----------
function days_from_metno(array $ts): array {
  $byDay = [];
  foreach ($ts as $x) {
    $t = strtotime($x['time']) - 18000; $date = gmdate('Y-m-d', $t); $hr = (int)gmdate('G', $t);
    $o = $byDay[$date] ?? ['date' => $date, 't' => [], 'mm' => 0, 'prob' => null, 'sym' => '', 'symHr' => 99];
    $det = $x['data']['instant']['details'] ?? [];
    if (isset($det['air_temperature'])) $o['t'][] = $det['air_temperature'];
    $n1 = $x['data']['next_1_hours'] ?? null; $n6 = $x['data']['next_6_hours'] ?? null;
    if ($n1) $o['mm'] += $n1['details']['precipitation_amount'] ?? 0; elseif ($n6 && $hr % 6 === 0) $o['mm'] += $n6['details']['precipitation_amount'] ?? 0;
    $pr = ($n1 ?: $n6)['details']['probability_of_precipitation'] ?? null; if ($pr !== null) $o['prob'] = max($o['prob'] ?? 0, $pr);
    $sym = ($n6 ?: $n1)['summary']['symbol_code'] ?? null; if ($sym && abs($hr - 13) < $o['symHr']) { $o['sym'] = $sym; $o['symHr'] = abs($hr - 13); }
    $byDay[$date] = $o;
  }
  $dates = array_keys($byDay); sort($dates);
  $today = gmdate('Y-m-d', time() - 18000);
  $mk = function ($date, $rel) use ($byDay, $dates) {
    $o = $byDay[$date] ?? null; if (!$o) return ['date' => $date, 'rel' => $rel, 'na' => true, 'text' => ''];
    $code = metno_code($o['sym']);
    return ['date' => $date, 'rel' => $rel, 'code' => $code, 'text' => WMO_TXT[$code] ?? '', 'tMax' => $o['t'] ? max($o['t']) : null, 'tMin' => $o['t'] ? min($o['t']) : null, 'mm' => r1($o['mm']), 'prob' => $o['prob'], 'partial' => $date === ($dates[0] ?? '')];
  };
  $day = fn($k) => gmdate('Y-m-d', strtotime("$today 12:00:00 UTC") + $k * 86400);
  return [$mk($day(-1), -1), $mk($day(0), 0), $mk($day(1), 1), $mk($day(2), 2)];
}
// Ayer desde el archivo de pronósticos de Open-Meteo (otro servidor que el de pronóstico)
function yesterday_from_archive(array $cfg, string $date): ?array {
  try {
    $url = 'https://historical-forecast-api.open-meteo.com/v1/forecast?' . http_build_query(['latitude' => $cfg['lat'], 'longitude' => $cfg['lng'], 'timezone' => 'America/Guayaquil', 'start_date' => $date, 'end_date' => $date,
      'daily' => 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum']);
    $D = http_json(http_one(['url' => $url, 'timeout' => 8, 'headers' => ['user-agent' => AV_UA]]))['daily'] ?? [];
    if (empty($D['time']) || ($D['temperature_2m_max'][0] ?? null) === null) return null;
    $code = $D['weather_code'][0] ?? null;
    return ['date' => $date, 'rel' => -1, 'code' => $code, 'text' => WMO_TXT[$code] ?? '', 'tMax' => $D['temperature_2m_max'][0], 'tMin' => $D['temperature_2m_min'][0] ?? null, 'mm' => r1($D['precipitation_sum'][0] ?? 0)];
  } catch (Throwable $e) { return null; }
}
function get_days(array $cfg): array {
  $lat = $cfg['lat']; $lng = $cfg['lng']; $key = "$lat,$lng"; $c = cache_get('days');
  if ($c && ($c['key'] ?? '') === $key && now_ms() - $c['at'] < 1800000) return $c['data'];
  $errs = [];
  $res = http_multi(['om' => ['url' => 'https://api.open-meteo.com/v1/forecast?' . http_build_query(['latitude' => $lat, 'longitude' => $lng, 'timezone' => 'America/Guayaquil', 'past_days' => 1, 'forecast_days' => 3,
      'daily' => 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,precipitation_hours']), 'timeout' => 8, 'headers' => ['user-agent' => AV_UA]],
    'mn' => ['url' => metno_url($lat, $lng), 'timeout' => 9, 'headers' => ['user-agent' => METNO_UA]]]);
  try {
    $D = http_json($res['om'])['daily'] ?? []; $t = $D['time'] ?? [];
    if (count($t) < 3) throw new RuntimeException('respuesta incompleta');
    $days = []; foreach ($t as $i => $date) { $code = $D['weather_code'][$i] ?? null; $days[] = ['date' => $date, 'rel' => $i - 1, 'code' => $code, 'text' => WMO_TXT[$code] ?? '',
      'tMax' => $D['temperature_2m_max'][$i] ?? null, 'tMin' => $D['temperature_2m_min'][$i] ?? null, 'mm' => r1($D['precipitation_sum'][$i] ?? 0),
      'prob' => $D['precipitation_probability_max'][$i] ?? null, 'hours' => $D['precipitation_hours'][$i] ?? null]; }
    $data = ['ok' => true, 'source' => 'Open-Meteo', 'days' => $days];
    cache_put('days', ['at' => now_ms(), 'key' => $key, 'data' => $data]); return $data;
  } catch (Throwable $e) { $errs[] = 'Open-Meteo: ' . $e->getMessage(); }
  try {
    $data = ['ok' => true, 'source' => 'MET Norway (yr.no)', 'days' => days_from_metno(metno_ts($res['mn']))];
    cache_put('days', ['at' => now_ms() - 1200000, 'key' => $key, 'data' => $data]); return $data; // se reintenta Open-Meteo en 10 min
  } catch (Throwable $e) { $errs[] = 'MET Norway: ' . $e->getMessage(); }
  if ($c && ($c['key'] ?? '') === $key) return array_merge($c['data'], ['stale' => true]);
  return ['ok' => false, 'error' => implode(' · ', $errs), 'days' => []];
}
