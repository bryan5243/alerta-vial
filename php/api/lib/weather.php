<?php
// Clima de varias fuentes (port fiel de server/weather.js): Open-Meteo con 8 modelos en una consulta, MET Norway (yr.no),
// METAR del aeropuerto SERO, OpenWeatherMap opcional, lo que marca el equipo y los reportes ciudadanos.
// Para el semáforo gana la fuente que vea la lluvia más fuerte (peor caso).
const AV_TTL = 300000, OM_TTL = 600000, OM_BLOCK = 900000, OM_STALE = 3600000, MIN_MM = 0.5, WET_MM = 0.1, NOTICE_PROB = 80;
const AV_UA = 'AlertaVial/1.0 (alertas de inundacion)', METNO_UA = 'AlertaVial/1.0 github.com/bryan5243/alerta-vial';
const MODELS = ['best_match' => 'Mejor modelo', 'ecmwf_ifs025' => 'ECMWF (Europa)', 'gfs_seamless' => 'GFS (EE. UU.)', 'icon_seamless' => 'ICON (Alemania)',
  'jma_seamless' => 'JMA (Japón)', 'meteofrance_seamless' => 'Météo-France', 'ukmo_seamless' => 'UK Met Office', 'gem_seamless' => 'GEM (Canadá)'];
const INT_MM = [0, 1, 4, 10, 20], INT_CODE = [0, 61, 63, 65, 95], INT_TXT = ['Sin lluvia', 'Lluvia leve', 'Lluvia moderada', 'Lluvia fuerte', 'Tormenta eléctrica'];
const P_MM = [[5, 90], [2.5, 80], [1, 70], [0.5, 55], [0.2, 40], [0.1, 25]];

function r1($x): float { return round((float)($x ?: 0), 1); }
function mm_int($mm): int { return $mm >= 8 ? 3 : ($mm >= 2.5 ? 2 : ($mm >= MIN_MM ? 1 : 0)); }
function fl_max(array $a, $default = 0) { return $a ? max($a) : $default; }
function hhmm_local(int $ts): string { return gmdate('H:i', $ts - 18000); }
function bad_model(string $m, string $err): array { return ['model' => $m, 'name' => MODELS[$m] ?? $m, 'ok' => false, 'error' => $err, 'intensity' => 0]; }

// ---------- Open-Meteo ----------
function om_url($lat, $lng, ?string $models): string {
  $q = ['latitude' => $lat, 'longitude' => $lng, 'current' => 'precipitation,rain,showers,temperature_2m,weather_code,cloud_cover,is_day,uv_index,shortwave_radiation',
    'daily' => 'uv_index_max,sunrise,sunset', 'hourly' => 'precipitation,precipitation_probability,cape', 'past_hours' => 3, 'forecast_hours' => 24, 'timezone' => 'America/Guayaquil'];
  if ($models) $q['models'] = $models;
  return 'https://api.open-meteo.com/v1/forecast?' . http_build_query($q);
}
function om_parse(string $model, array $j, bool $sfx): array {
  $g = fn($o, $k) => $sfx ? ($o["{$k}_{$model}"] ?? null) : ($o[$k] ?? null);
  $H = $j['hourly'] ?? []; $times = $H['time'] ?? [];
  $P = $g($H, 'precipitation') ?: []; $PP = $g($H, 'precipitation_probability') ?: []; $CP = $g($H, 'cape') ?: [];
  $hours = [];
  foreach ($times as $i => $t) $hours[] = ['time' => $t, 'precipitation' => $P[$i] ?? null, 'probability' => $PP[$i] ?? null, 'cape' => $CP[$i] ?? null];
  $allNull = true; foreach ($hours as $h) if ($h['precipitation'] !== null) { $allNull = false; break; }
  if (!$hours || $allNull) return ['model' => $model, 'name' => MODELS[$model], 'ok' => false, 'error' => 'sin datos para este punto', 'intensity' => 0];
  $cur = $j['current'] ?? []; $useCur = $model === 'best_match' || !$sfx;
  $curH = substr((string)($cur['time'] ?? ''), 0, 13); $nowIdx = 0;
  foreach ($hours as $i => $h) if (substr($h['time'], 0, 13) === $curH) { $nowIdx = $i; break; }
  $sum = fn($arr) => r1(array_sum(array_map(fn($h) => $h['precipitation'] ?? 0, $arr)));
  $k = 3600 / (($cur['interval'] ?? 0) ?: 900);
  $curMm = $useCur ? max($cur['precipitation'] ?? 0, ($cur['rain'] ?? 0) + ($cur['showers'] ?? 0)) * $k : 0;
  $rainNow = r1(max($curMm, $hours[$nowIdx]['precipitation'] ?? 0));
  $code = $useCur ? ($cur['weather_code'] ?? null) : null; $storm = $code !== null && $code >= 95 && $rainNow >= 1;
  $D = $j['daily'] ?? [];
  $sun = $useCur ? ['isDay' => $cur['is_day'] ?? null, 'uvIndex' => $cur['uv_index'] ?? null, 'radiation' => $cur['shortwave_radiation'] ?? null,
    'uvMax' => ($g($D, 'uv_index_max') ?? [])[0] ?? null, 'sunrise' => ($g($D, 'sunrise') ?? [])[0] ?? null, 'sunset' => ($g($D, 'sunset') ?? [])[0] ?? null] : null;
  $hasProb = false; foreach ($hours as $h) if ($h['probability'] !== null) { $hasProb = true; break; }
  $probOf = fn($arr) => max(array_merge([0], array_map(fn($h) => $h['probability'] ?: 0, $arr)));
  $cape = null; foreach (array_slice($hours, $nowIdx, 7) as $h) if ($h['cape'] !== null && $h['cape'] > ($cape ?? -1)) $cape = $h['cape'];
  return ['model' => $model, 'name' => MODELS[$model], 'ok' => true, 'observedAt' => $cur['time'] ?? null, 'temperature' => $useCur ? ($cur['temperature_2m'] ?? null) : null,
    'cloudCover' => $useCur ? ($cur['cloud_cover'] ?? null) : null, 'sun' => $sun, 'weatherCode' => $code, 'rainNow' => $rainNow, 'intensity' => $storm ? 4 : mm_int($rainNow),
    'rainPast3h' => $sum(array_slice($hours, max(0, $nowIdx - 3), $nowIdx + 1 - max(0, $nowIdx - 3))), 'rainNext3h' => $sum(array_slice($hours, $nowIdx + 1, 3)),
    'rainNext24h' => $sum(array_slice($hours, $nowIdx + 1, 24)),
    'probNext3h' => $hasProb ? $probOf(array_slice($hours, $nowIdx, 4)) : null,
    'maxProbability24h' => $hasProb ? $probOf(array_slice($hours, $nowIdx + 1, 24)) : null,
    'capeMax6h' => $cape,
    'hourly' => array_map(fn($h) => ['time' => $h['time'], 'precipitation' => $h['precipitation'], 'probability' => $h['probability']], array_slice($hours, $nowIdx, 25))];
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

// ---------- MET Norway ----------
function metno_code(string $s): int { return preg_match('/thunder/', $s) ? 95 : (preg_match('/heavyrain|heavysleet/', $s) ? 65 : (preg_match('/lightrain|lightsleet/', $s) ? 61 : (preg_match('/rain|sleet/', $s) ? 63
  : (preg_match('/fog/', $s) ? 45 : (preg_match('/^cloudy/', $s) ? 3 : (preg_match('/partlycloudy/', $s) ? 2 : (preg_match('/fair/', $s) ? 1 : 0))))))); }
function metno_parse(array $res): array {
  $bad = fn($e) => ['model' => 'met_no', 'name' => 'MET Norway (yr.no)', 'ok' => false, 'error' => $e, 'intensity' => 0];
  try {
    if ($res['err']) throw new RuntimeException($res['err']);
    if ($res['code'] < 200 || $res['code'] >= 300) throw new RuntimeException(in_array($res['code'], [429, 403]) ? 'demasiadas consultas, reintenta luego' : "respondió con error {$res['code']}");
    $ts = (json_decode($res['body'], true)['properties']['timeseries'] ?? []);
    $t0 = $ts[0] ?? null; if (!$t0) throw new RuntimeException('sin datos para este punto');
    $det = $t0['data']['instant']['details'] ?? []; $n1 = $t0['data']['next_1_hours'] ?? [];
    $sym = $n1['summary']['symbol_code'] ?? ($t0['data']['next_6_hours']['summary']['symbol_code'] ?? '');
    $mm = fn($i) => $ts[$i]['data']['next_1_hours']['details']['precipitation_amount'] ?? 0;
    $rainNow = r1($mm(0)); $code = metno_code($sym); $storm = $code >= 95 && $rainNow >= 1;
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
    return ['model' => 'met_no', 'name' => 'MET Norway (yr.no)', 'ok' => true, 'observedAt' => gmdate('Y-m-d\TH:i', $t0s - 18000), 'temperature' => $det['air_temperature'] ?? null,
      'cloudCover' => $cloud === null ? null : (int)round($cloud), 'weatherCode' => $code, 'rainNow' => $rainNow, 'intensity' => $storm ? 4 : mm_int($rainNow),
      'sun' => ['isDay' => $isDay, 'uvIndex' => $isDay ? $uv : 0, 'radiation' => null, 'uvMax' => null, 'sunrise' => null, 'sunset' => null],
      'rainPast3h' => 0, 'rainNext3h' => r1($mm(1) + $mm(2) + $mm(3)), 'rainNext24h' => r1($next24),
      'probNext3h' => $prob ? max($prob) : null, 'maxProbability24h' => null, 'hourly' => $hourly, 'thunder6h' => $thunder];
  } catch (Throwable $e) { return $bad($e->getMessage()); }
}

// ---------- METAR ----------
function parse_metar($raw): array {
  $body = preg_split('/\sRMK\s/', (string)$raw)[0]; $intensity = 0; $near = false; $txt = '';
  foreach (preg_split('/\s+/', $body) as $t) {
    if (!preg_match('/^(\+|-|VC)?(TS|SH)?((?:DZ|RA|GR|GS|UP)*)$/', $t, $m)) continue;
    $m1 = $m[1] ?? ''; $m2 = $m[2] ?? ''; $m3 = $m[3] ?? '';
    if (!$m2 && !$m3) continue;
    if ($m1 === 'VC') { $near = true; continue; }
    $ts = $m2 === 'TS'; $rain = (bool)preg_match('/RA|DZ|GR|GS|UP/', $m3);
    $i = $ts ? ($rain ? 4 : 3) : (preg_match('/RA|GR|GS|UP/', $m3) ? 2 : (preg_match('/DZ/', $m3) ? 1 : 0));
    if (!$ts && $m1 === '-') $i = max(1, $i - 1);
    if (!$ts && $m1 === '+') $i = 3;
    if ($i > $intensity) { $intensity = $i; $txt = $ts ? ($rain ? 'Tormenta con lluvia' : 'Tormenta eléctrica') : (($m1 === '+' ? 'Lluvia fuerte' : ($m1 === '-' ? 'Lluvia leve' : (preg_match('/DZ/', $m3) && !preg_match('/RA/', $m3) ? 'Llovizna' : 'Lluvia'))) . ($m2 === 'SH' ? ' (chubasco)' : '')); }
  }
  if (!$intensity && $near) return ['intensity' => 0, 'near' => $near, 'text' => 'Lluvia en los alrededores (no sobre el aeropuerto)'];
  return ['intensity' => $intensity, 'near' => $near, 'text' => $txt ?: 'Sin lluvia'];
}
function metar_parse(array $res, string $station): array {
  $base = ['id' => 'metar', 'kind' => 'observación', 'name' => "Aeropuerto Santa Rosa ($station)"];
  try {
    $j = http_json($res); $obs = [];
    foreach ((is_array($j) ? $j : []) as $x) { $raw = $x['rawOb'] ?? ''; if (!$raw) continue; $obs[] = ['raw' => $raw, 'at' => isset($x['obsTime']) ? (int)$x['obsTime'] : (isset($x['reportTime']) ? strtotime($x['reportTime']) : 0)]; }
    usort($obs, fn($a, $b) => $b['at'] <=> $a['at']); $last = $obs[0] ?? null;
    if (!$last) throw new RuntimeException('el aeropuerto no envió reportes en las últimas 3 h');
    $ageMin = (int)round((time() - $last['at']) / 60); $p = parse_metar($last['raw']); $fresh = $ageMin <= 90;
    return $base + ['ok' => $fresh, 'stale' => !$fresh, 'at' => gmdate('c', $last['at']), 'ageMin' => $ageMin, 'raw' => $last['raw'], 'intensity' => $fresh ? $p['intensity'] : 0, 'rainNow' => $fresh ? INT_MM[$p['intensity']] : 0,
      'near' => $fresh && !empty($p['near']), 'cb' => $fresh && (bool)preg_match('/\b(FEW|SCT|BKN|OVC)\d{3}(CB|TCU)\b/', $last['raw']),
      'ts' => $fresh && (bool)preg_match('/\b(VC)?TS/', preg_replace('/^\S+\s+\S+\s+/', '', $last['raw'])),
      'detail' => "{$p['text']} · reporte de hace $ageMin min", 'error' => $fresh ? null : "último reporte hace $ageMin min"];
  } catch (Throwable $e) { return $base + ['ok' => false, 'intensity' => 0, 'error' => $e->getMessage()]; }
}

// ---------- OpenWeatherMap (opcional) ----------
function owm_parse(array $res): array {
  $base = ['id' => 'owm', 'kind' => 'observación', 'name' => 'OpenWeatherMap'];
  try {
    $j = http_json($res); $id = $j['weather'][0]['id'] ?? 800;
    $mm = r1($j['rain']['1h'] ?? (isset($j['rain']['3h']) ? $j['rain']['3h'] / 3 : 0));
    $codeInt = $id >= 200 && $id < 300 ? 4 : (in_array($id, [501, 521, 511]) ? 2 : ($id >= 502 && $id < 600 ? 3 : 0));
    $intensity = max($codeInt, mm_int($mm));
    return $base + ['ok' => true, 'at' => gmdate('c', $j['dt'] ?? time()), 'intensity' => $intensity, 'rainNow' => max($mm, $intensity ? INT_MM[$intensity] / 2 : 0),
      'temperature' => $j['main']['temp'] ?? null, 'cloudCover' => $j['clouds']['all'] ?? null, 'detail' => ($j['weather'][0]['description'] ?? '') . ($mm ? " · $mm mm/h" : '')];
  } catch (Throwable $e) { return $base + ['ok' => false, 'intensity' => 0, 'error' => $e->getMessage()]; }
}

// ---------- Consulta con caché ----------
function get_weather(array $cfg, array $extra = []): array {
  $lat = $cfg['lat']; $lng = $cfg['lng']; $station = $cfg['metarStation'] ?? 'SERO'; $owmKey = $cfg['owmKey'] ?? '';
  $key = "$lat,$lng,$station," . ($owmKey ? 1 : 0);
  $c = cache_get('weather');
  if ($c && ($c['key'] ?? '') === $key && now_ms() - $c['at'] < AV_TTL) return combine($c['remote'], $extra);
  $om = cache_get('om') ?: []; $reqs = [];
  $omFresh = !empty($om['models']) && ($om['key'] ?? '') === "$lat,$lng" && now_ms() - ($om['at'] ?? 0) < OM_TTL;
  $omBlocked = now_ms() < ($om['blockedUntil'] ?? 0) && ($om['key'] ?? '') === "$lat,$lng";
  if (!$omFresh && !$omBlocked) $reqs['om'] = ['url' => om_url($lat, $lng, implode(',', array_keys(MODELS))), 'timeout' => 10, 'headers' => ['user-agent' => AV_UA]];
  $mn = cache_get('metno'); $mnFresh = $mn && ($mn['key'] ?? '') === "$lat,$lng" && now_ms() - $mn['at'] < OM_TTL;
  if (!$mnFresh) $reqs['metno'] = ['url' => sprintf('https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=%.4f&lon=%.4f', $lat, $lng), 'timeout' => 8, 'headers' => ['user-agent' => METNO_UA]];
  $mt = cache_get('metar'); $mtFresh = $mt && now_ms() - $mt['at'] < AV_TTL;
  if ($station && !$mtFresh) $reqs['metar'] = ['url' => "https://aviationweather.gov/api/data/metar?ids=$station&format=json&hours=3", 'timeout' => 8, 'headers' => ['user-agent' => AV_UA]];
  $ow = cache_get('owm'); $owFresh = $ow && ($ow['key'] ?? '') === "$lat,$lng,$owmKey" && now_ms() - $ow['at'] < AV_TTL;
  if ($owmKey && !$owFresh) $reqs['owm'] = ['url' => "https://api.openweathermap.org/data/2.5/weather?lat=$lat&lon=$lng&appid=" . urlencode($owmKey) . '&units=metric&lang=es', 'timeout' => 8, 'headers' => ['user-agent' => AV_UA]];
  $res = $reqs ? http_multi($reqs) : [];
  if (isset($res['om'])) $omModels = om_process($res['om'], $lat, $lng);
  elseif ($omBlocked) $omModels = om_blocked_models($om, $lat, $lng);
  else $omModels = $om['models'];
  if (isset($res['metno'])) { $metno = metno_parse($res['metno']); cache_put('metno', ['key' => "$lat,$lng", 'at' => now_ms(), 'data' => $metno]); } else $metno = $mn['data'];
  if (isset($res['metar'])) { $metar = metar_parse($res['metar'], $station); cache_put('metar', ['at' => now_ms(), 'data' => $metar]); } else $metar = $station ? $mt['data'] : null;
  if (!$owmKey) $owm = ['id' => 'owm', 'kind' => 'observación', 'name' => 'OpenWeatherMap', 'ok' => false, 'disabled' => true, 'intensity' => 0, 'error' => 'sin API key'];
  elseif (isset($res['owm'])) { $owm = owm_parse($res['owm']); cache_put('owm', ['key' => "$lat,$lng,$owmKey", 'at' => now_ms(), 'data' => $owm]); } else $owm = $ow['data'];
  $remote = ['models' => array_merge($omModels, [$metno]), 'metar' => $metar, 'owm' => $owm, 'at' => gmdate('c')];
  cache_put('weather', ['at' => now_ms(), 'key' => $key, 'remote' => $remote]);
  return combine($remote, $extra);
}
// Open-Meteo bloqueado (429): se usa el último dato bueno, si no es muy viejo
function om_blocked_models(array $om, $lat, $lng): array {
  $now = now_ms(); $err = $om['error'] ?? 'demasiadas consultas, reintenta luego';
  if (!empty($om['good']) && $now - ($om['goodAt'] ?? 0) < OM_STALE) { $min = (int)round(($now - $om['goodAt']) / 60000); return array_map(fn($m) => $m + ['stale' => true, 'staleMin' => $min, 'staleWhy' => $err], $om['good']); }
  return array_map(fn($m) => bad_model($m, $err), array_keys(MODELS));
}

// ---------- Combinar fuentes ----------
function combine(array $remote, array $extra = []): array {
  $models = $remote['models']; $metar = $remote['metar'] ?? null; $owm = $remote['owm'] ?? null; $at = $remote['at'];
  $okM = array_values(array_filter($models, fn($m) => $m['ok']));
  $find = fn($f) => (function () use ($okM, $f) { foreach ($okM as $m) if ($f($m)) return $m; return null; })();
  $base = $find(fn($m) => $m['model'] === 'best_match') ?? $find(fn($m) => $m['model'] === 'met_no') ?? ($okM[0] ?? null);
  $need = max(2, (int)ceil(count($okM) / 3));
  $kth = function (array $arr) use ($need) { rsort($arr); return count($arr) >= $need ? $arr[$need - 1] : 0; };
  $clear = ($base['cloudCover'] ?? 100) < 50;
  $raining = array_values(array_filter($okM, fn($m) => $m['intensity'] > 0));
  $mInt = $clear ? 0 : $kth(array_map(fn($m) => $m['intensity'], $okM));
  $mRain = $mInt ? r1($kth(array_map(fn($m) => $m['rainNow'], $okM))) : 0;
  $omOk = count(array_filter($okM, fn($m) => $m['model'] !== 'met_no'));
  $stale = $find(fn($m) => !empty($m['stale']));
  $provs = implode(' + ', array_filter([$omOk ? 'Open-Meteo' : null, $find(fn($m) => $m['model'] === 'met_no') ? 'MET Norway' : null])) ?: 'Open-Meteo + MET Norway';
  $errs = array_values(array_unique(array_filter(array_map(fn($m) => $m['error'] ?? null, $models))));
  $detail = !$okM ? 'Sin conexión con los pronósticos (' . implode(' · ', $errs) . ')'
    : ($stale ? "Dato de Open-Meteo de hace {$stale['staleMin']} min ({$stale['staleWhy']}) · " : '') . count($raining) . ' de ' . count($okM) . ' modelos ven lluvia medible'
      . ($raining ? ' (' . implode(', ', array_map(fn($m) => $m['name'], $raining)) . ')' : '') . "; hacen falta $need" . ($clear && $raining ? ' · no cuenta: el cielo está casi despejado' : '') . ' · nubosidad ' . ($base['cloudCover'] ?? '—') . ' %';
  $modelSrc = ['id' => 'modelos', 'kind' => 'pronóstico', 'name' => "$provs · " . count($okM) . ' de ' . count($models) . ' modelos', 'ok' => count($okM) > 0, 'at' => $base['observedAt'] ?? null,
    'intensity' => $mInt, 'rainNow' => $mRain, 'detail' => $detail, 'error' => $okM ? null : ($models[0]['error'] ?? null),
    'models' => array_map(fn($m) => ['name' => $m['name'], 'ok' => $m['ok'], 'rainNow' => $m['rainNow'] ?? 0, 'intensity' => $m['intensity'] ?? 0, 'error' => $m['error'] ?? null, 'stale' => !empty($m['stale']) ? $m['staleMin'] : null], $models)];
  $sources = array_values(array_filter(array_merge([$modelSrc, $metar, $owm], $extra)));
  $live = array_values(array_filter($sources, fn($s) => !empty($s['ok'])));
  if (!$live) return ['ok' => false, 'source' => 'Open-Meteo', 'error' => $modelSrc['error'] ?: 'sin conexión', 'rainNow' => 0, 'rainPast3h' => 0, 'rainNext3h' => 0, 'rainNext24h' => 0, 'hourly' => [], 'sources' => $sources, 'checkedAt' => $at];
  $top = $live[0];
  foreach ($live as $s) if ($s['intensity'] > $top['intensity'] || ($s['intensity'] === $top['intensity'] && ($s['rainNow'] ?? 0) > ($top['rainNow'] ?? 0))) $top = $s;
  $intensity = $top['intensity'] ?? 0;
  $pick = function ($k) use ($okM, $need, $kth) { $v = array_map(fn($m) => $m[$k] ?? 0, $okM); return r1(count($v) >= $need ? $kth($v) : fl_max($v)); };
  $baseCode = $base['weatherCode'] ?? 0; $baseRainy = $baseCode >= 50;
  $tempOk = $base['temperature'] ?? null; if ($tempOk === null) foreach ($okM as $m) if (($m['temperature'] ?? null) !== null) { $tempOk = $m['temperature']; break; }
  $w = ['ok' => true, 'sources' => $sources, 'checkedAt' => $at, 'modelsNeeded' => $need, 'decidedBy' => $intensity > 0 ? $top['name'] : null,
    'source' => implode(' + ', array_map(fn($s) => $s['id'] === 'modelos' ? "$provs (" . count($okM) . ' modelos)' : $s['name'], $live)),
    'observedAt' => ($intensity > 0 ? ($top['at'] ?? null) : ($base['observedAt'] ?? null)) ?: $at,
    'temperature' => $tempOk ?? ($owm['temperature'] ?? null), 'cloudCover' => max($base['cloudCover'] ?? 0, $owm['cloudCover'] ?? 0, $intensity ? 95 : 0),
    'rainNow' => $intensity ? r1(max(array_map(fn($s) => !empty($s['intensity']) ? ($s['rainNow'] ?? 0) : 0, $live))) : 0,
    'rainPast3h' => max($pick('rainPast3h'), $intensity >= 2 ? INT_MM[$intensity] : 0), 'rainNext3h' => $pick('rainNext3h'), 'rainNext24h' => $pick('rainNext24h'),
    'probNext3h' => null, 'maxProbability24h' => null,
    'weatherCode' => $intensity ? INT_CODE[$intensity] : ($baseRainy ? 3 : $baseCode), 'hourly' => merge_hourly($okM)];
  if ($intensity > 0 && $w['hourly']) $w['hourly'][0] = raining_now($w['hourly'][0], $w['rainNow']);
  if ($w['hourly']) {
    $w['probNext3h'] = max(array_map(fn($h) => $h['probability'], array_slice($w['hourly'], 0, 4)));
    $w['maxProbability24h'] = max(array_map(fn($h) => $h['probability'], array_slice($w['hourly'], 1, 24)) ?: [0]);
    $w['probEstimated'] = !array_filter(array_slice($w['hourly'], 0, 4), fn($h) => empty($h['estimated'])) ;
  }
  $w['periods'] = day_parts($w['hourly']);
  $sunSrc = $base['sun'] ?? null; if (!$sunSrc) foreach ($okM as $m) if (($m['sun']['uvIndex'] ?? null) !== null) { $sunSrc = $m['sun']; break; }
  $w['sun'] = sun_info($sunSrc, $w['cloudCover'], $intensity);
  $w = array_merge($w, describe($w));
  if ($intensity !== $w['intensity']) $w = array_merge($w, ['intensity' => $intensity, 'raining' => $intensity > 0, 'condition' => $intensity ? INT_TXT[$intensity] : $w['condition']]);
  if (!$w['intensity'] && $w['condition'] === 'Despejado' && $w['sun']) $w['condition'] = $w['sun']['sky'] === 'noche' ? 'Noche despejada' : 'Soleado';
  $w['outlook'] = outlook_of($w, $okM, $metar, $need);
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
  $level = $w['intensity'] > 0 ? 'lloviendo' : ($peak >= NOTICE_PROB ? 'probable' : 'calma');
  $title = ['lloviendo' => 'Está lloviendo', 'probable' => 'Lluvia probable en las próximas horas', 'calma' => 'Sin lluvia a la vista'][$level];
  $text = $level === 'lloviendo' ? 'Revisa las calles inundadas y las vías alternas antes de salir.'
    : ($level === 'calma' ? 'No hay una probabilidad alta de lluvia (' . NOTICE_PROB . ' % o más) en las próximas 6 horas.'
    : 'Ahora no llueve, pero es probable un aguacero' . ($from ? ' desde las ' . substr($from, 11, 5) . ', aproximadamente' : '') . '. Lleva paraguas y evita las calles que suelen inundarse.');
  return ['level' => $level, 'score' => $score, 'title' => $title, 'text' => $text, 'reasons' => $level === 'calma' ? [] : $reasons, 'from' => $from, 'peak' => $peak, 'min' => NOTICE_PROB];
}

// ---------- Sol y UV ----------
function uv_level($v): array {
  foreach ([[11, 'extremo', 'Extremo', 'Evita salir al sol; si sales, protector, gorra, lentes y ropa que cubra.'], [8, 'muy-alto', 'Muy alto', 'Evita el sol de 10:00 a 15:00. Protector solar, gorra y lentes.'],
    [6, 'alto', 'Alto', 'Usa protector solar y gorra; busca sombra al mediodía.'], [3, 'moderado', 'Moderado', 'Protector solar si vas a estar más de 30 minutos al sol.'], [0, 'bajo', 'Bajo', 'Sin riesgo por el sol.']] as $u)
    if (($v ?? 0) >= $u[0]) return ['key' => $u[1], 'label' => $u[2], 'advice' => $u[3]];
  return ['key' => 'bajo', 'label' => 'Bajo', 'advice' => 'Sin riesgo por el sol.'];
}
function sun_info($s, $cloud, $intensity) {
  if (!$s) return null;
  $night = ($s['isDay'] ?? null) === 0; $c = $cloud ?? 0;
  $sky = $intensity > 0 ? 'lluvia' : ($night ? 'noche' : ($c >= 80 ? 'nublado' : ($c >= 40 ? 'parcial' : 'soleado')));
  $uv = ($s['uvIndex'] ?? null) === null ? null : round($s['uvIndex'] * 10) / 10;
  return array_merge($s, ['uvIndex' => $uv, 'uvMax' => ($s['uvMax'] ?? null) === null ? null : round($s['uvMax'] * 10) / 10, 'radiation' => ($s['radiation'] ?? null) === null ? null : (int)round($s['radiation']),
    'sky' => $sky, 'uv' => uv_level($night ? 0 : $uv), 'uvMaxLevel' => uv_level($s['uvMax'] ?? null)]);
}

// ---------- Fuentes locales ----------
function local_sources(?array $observed, array $reports = []): array {
  $out = [];
  if ($observed && strtotime($observed['until']) > time()) {
    $i = max(0, min(4, (int)($observed['intensity'] ?? 0)));
    $out[] = ['id' => 'equipo', 'kind' => 'observación', 'name' => 'Equipo EMOVTT', 'ok' => true, 'at' => $observed['at'], 'intensity' => $i, 'rainNow' => INT_MM[$i],
      'detail' => INT_TXT[$i] . ' marcada en el panel · vigente hasta ' . hhmm_local(strtotime($observed['until']))];
  }
  $recent = array_values(array_filter($reports, fn($r) => ($r['status'] ?? '') !== 'descartado' && time() - strtotime($r['createdAt']) < 3600));
  if ($recent) {
    $ver = array_values(array_filter($recent, fn($r) => $r['status'] === 'verificado'));
    $grave = array_filter($ver, fn($r) => ($r['level'] ?? '') === 'grave');
    $i = $grave ? 3 : ($ver ? 2 : (count($recent) >= 3 ? 2 : (count($recent) >= 2 ? 1 : 0)));
    $ats = array_map(fn($r) => $r['createdAt'], $recent); sort($ats);
    $out[] = ['id' => 'reportes', 'kind' => 'observación', 'name' => 'Reportes ciudadanos', 'ok' => true, 'at' => end($ats), 'intensity' => $i, 'rainNow' => INT_MM[$i],
      'detail' => count($recent) . ' reporte' . (count($recent) > 1 ? 's' : '') . ' en la última hora' . ($ver ? ' (' . count($ver) . ' verificado' . (count($ver) > 1 ? 's' : '') . ')' : '') . ($i ? '' : ' · hace falta otro para contar como lluvia')];
  }
  return $out;
}

function describe(array $w): array {
  static $CODE = [51 => [1, 'Llovizna'], 53 => [1, 'Llovizna'], 55 => [2, 'Llovizna intensa'], 56 => [1, 'Llovizna'], 57 => [2, 'Llovizna intensa'], 61 => [1, 'Lluvia leve'], 63 => [2, 'Lluvia moderada'], 65 => [3, 'Lluvia fuerte'],
    66 => [1, 'Lluvia leve'], 67 => [3, 'Lluvia fuerte'], 80 => [1, 'Chubascos leves'], 81 => [2, 'Chubascos moderados'], 82 => [3, 'Chubascos fuertes'], 95 => [4, 'Tormenta eléctrica'], 96 => [4, 'Tormenta con granizo'], 99 => [4, 'Tormenta con granizo']];
  [$codeInt, $codeTxt] = $CODE[$w['weatherCode'] ?? -1] ?? [0, ''];
  $m = mm_int($w['rainNow'] ?? 0); $intensity = max($codeInt, $m);
  $cc = $w['cloudCover'] ?? 0;
  $condition = $codeTxt ?: ($m === 3 ? 'Lluvia fuerte' : ($m === 2 ? 'Lluvia moderada' : ($m === 1 ? 'Lluvia leve' : (($w['probNext3h'] ?? 0) >= NOTICE_PROB ? 'Lluvia probable' : ($cc >= 70 ? 'Nublado' : ($cc >= 30 ? 'Parcialmente nublado' : 'Despejado'))))));
  return ['raining' => $intensity > 0, 'intensity' => $intensity, 'condition' => $condition];
}

// ---------- Marea ----------
function get_tide(array $cfg): array {
  $lat = $cfg['lat']; $lng = $cfg['lng']; $key = "$lat,$lng"; $c = cache_get('tide');
  if ($c && ($c['key'] ?? '') === $key && now_ms() - $c['at'] < AV_TTL * 3) return $c['data'];
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
function risk_index(array $w, array $cfg, $flood, array $reports, $tide, array $rivers): array {
  $t = $cfg['rainThresholdMm'] ?? 5; $t3 = $cfg['rainThresholdMm3h'] ?? 15;
  $clamp = fn($x) => max(0, min(1, $x)); $parts = [];
  $ok = !empty($w['ok']);
  $rainNow = $ok ? $clamp(max(($w['rainNow'] ?? 0) / ($t * 3), ($w['rainPast3h'] ?? 0) / ($t3 * 2), [0, 0.25, 0.5, 0.8, 1][$w['intensity'] ?? 0])) : 0;
  $parts[] = ['key' => 'lluvia', 'label' => 'Lluvia actual', 'max' => 30, 'value' => (int)round($rainNow * 30), 'ok' => $ok];
  $fc = $ok ? $clamp(($w['rainNext24h'] ?? 0) / ($t3 * 3)) * $clamp(($w['maxProbability24h'] ?? 100) / 100 + 0.3) : 0;
  $parts[] = ['key' => 'pronostico', 'label' => 'Pronóstico 24 h', 'max' => 25, 'value' => (int)round($fc * 25), 'ok' => $ok];
  $sev = ['EXTREME' => 1, 'SEVERE' => 0.75, 'ABOVE_NORMAL' => 0.4];
  $local = max(array_merge([0], array_map(fn($r) => ['desbordado' => 1, 'crecido' => 0.6][$r['status'] ?? ''] ?? 0, $rivers)));
  $river = max($local, !empty($flood['ok']) ? max(array_merge([0], array_map(fn($g) => $sev[$g['severity'] ?? ''] ?? 0, $flood['gauges'] ?? []))) : 0);
  $parts[] = ['key' => 'rios', 'label' => 'Ríos', 'max' => 20, 'value' => (int)round($river * 20), 'ok' => !empty($flood['ok']) || count($rivers) > 0];
  $recent = array_filter($reports, fn($r) => ($r['status'] ?? '') !== 'descartado' && time() - strtotime($r['createdAt']) < 3 * 3600);
  $rep = $clamp(array_reduce($recent, fn($s, $r) => $s + (['leve' => 0.15, 'moderado' => 0.3, 'grave' => 0.5][$r['level'] ?? ''] ?? 0.2) * (($r['status'] ?? '') === 'verificado' ? 1.5 : 1), 0));
  $parts[] = ['key' => 'reportes', 'label' => 'Reportes (3 h)', 'max' => 15, 'value' => (int)round($rep * 15), 'ok' => true];
  $tv = !empty($tide['ok']) ? $clamp(($tide['relative'] - 0.5) * 2) : 0;
  $parts[] = ['key' => 'marea', 'label' => 'Marea', 'max' => 10, 'value' => (int)round($tv * 10), 'ok' => !empty($tide['ok'])];
  $value = array_sum(array_map(fn($p) => $p['value'], $parts));
  return ['value' => $value, 'parts' => $parts, 'level' => $value >= 70 ? 'roja' : ($value >= 50 ? 'naranja' : ($value >= 30 ? 'amarilla' : 'normal'))];
}
function level_from_weather(array $w, array $cfg): string {
  if (empty($w['ok'])) return 'normal';
  $t = $cfg['rainThresholdMm']; $t3 = $cfg['rainThresholdMm3h']; $i = $w['intensity'] ?? 0;
  if ($w['rainNow'] >= $t * 3 || $w['rainPast3h'] >= $t3 * 2 || ($i >= 4 && $w['rainNow'] >= $t)) return 'roja';
  if ($w['rainNow'] >= $t || $w['rainPast3h'] >= $t3 || $i >= 3) return 'naranja';
  if ($i >= 1 || (($w['probNext3h'] ?? 0) >= 80 && $w['rainNext3h'] >= $t / 2)) return 'amarilla';
  return 'normal';
}
