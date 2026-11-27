<?php
// Estación meteorológica HOBO RX2100 (Onset/LI-COR) de Santa Rosa: pluviómetro real, publicado en un tablero público de
// LI-COR Cloud. Se lee la lluvia por hora con la misma consulta que hace ese tablero (como mucho cada 5 min).
// La estación está en la parte alta (~450 m, según su presión), no en el centro: su lluvia respalda a los pronósticos
// y avisa de lo que va a bajar por los ríos, pero no enciende "lloviendo en la ciudad" por sí sola.
const LICOR = [
  'dashboard' => '5e1f6cd5-0815-49b9-9d1a-a8777d544579',
  'rain' => 'f869d179-1360-4b20-9eeb-e302646514e4', 'metric' => 'com.onset.sensordata.rain_si',
  'base' => 'https://www.licor.cloud', 'ttl' => 300000, 'wetMm' => 0.5, 'freshMin' => 90,
];
const LICOR_UA = 'Mozilla/5.0 (compatible; AlertaVial/1.0; +https://www.emovttsr.gob.ec/alertavial/)';

function licor_http(string $method, string $url, ?string $body, string $cookie): array {
  $ch = curl_init($url); $set = [];
  $h = ['accept: application/json, text/plain, */*', 'origin: ' . LICOR['base'], 'referer: ' . LICOR['base'] . '/dashboards/public/' . LICOR['dashboard'] . '/true', 'user-agent: ' . LICOR_UA];
  if ($body !== null) $h[] = 'content-type: application/json';
  if ($cookie) $h[] = "cookie: $cookie";
  curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 12, CURLOPT_CONNECTTIMEOUT => 6, CURLOPT_HTTPHEADER => $h, CURLOPT_ENCODING => '',
    CURLOPT_HEADERFUNCTION => function ($c, $line) use (&$set) { if (preg_match('/^set-cookie:\s*([^=;\s]+)=([^;]*)/i', $line, $m)) $set[$m[1]] = $m[2]; return strlen($line); }]);
  if ($method === 'POST') { curl_setopt($ch, CURLOPT_POST, true); curl_setopt($ch, CURLOPT_POSTFIELDS, $body); }
  $out = (string)curl_exec($ch); $code = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE); $err = curl_errno($ch); curl_close($ch);
  return ['code' => $code, 'body' => $out, 'err' => $err ? ($err === 28 ? 'no respondió a tiempo' : 'sin conexión') : '', 'cookies' => $set];
}
function licor_query(int $now, string $cookie): array {
  $body = json_encode(['channels' => [['channelUUID' => LICOR['rain'], 'channelType' => 'dataChannel', 'metricName' => LICOR['metric'], 'limit' => 500,
    'aggregationFunction' => 'avg', 'aggregationInterval' => ['value' => 1, 'unit' => 'seconds']]],
    'time' => ['absolute' => ['from' => $now - 26 * 3600000, 'to' => $now]], 'dashboardUUID' => LICOR['dashboard']]);
  return licor_http('POST', LICOR['base'] . '/api/v2/timeseriesdata', $body, $cookie);
}
// Lecturas [[ms, mm], ...] → resumen
function licor_summary(array $pts, int $now): array {
  usort($pts, fn($a, $b) => $a[0] <=> $b[0]);
  $d = []; for ($i = 1; $i < count($pts); $i++) $d[] = $pts[$i][0] - $pts[$i - 1][0];
  sort($d); $step = $d ? max(300000, min(3600000, $d[intdiv(count($d), 2)])) : 3600000; // cada lectura cubre [hora, hora + paso)
  $sum = function (float $h) use ($pts, $now, $step) { $s = 0; foreach ($pts as [$t, $v]) if ($t + $step > $now - $h * 3600000) $s += max(0, $v); return round($s, 1); };
  [$lt, $lv] = end($pts); $end = $lt + $step; $age = max(0, (int)round(($now - $end) / 60000));
  $s = ['lastMm' => round(max(0, $lv), 1), 'lastFrom' => $lt, 'lastTo' => $end, 'stepMin' => (int)round($step / 60000), 'ageMin' => $age,
    'rain30m' => $sum(0.5), 'rain1h' => $sum(1), 'rain3h' => $sum(3), 'rain6h' => $sum(6), 'rain12h' => $sum(12), 'rain24h' => $sum(24)];
  return $s + ['wet' => licor_wet($s)];
}
// "Llueve en la estación": con lecturas cada 5 min, ≥ 0,4 mm en la última media hora (≈ 0,8 mm/h) y el dato de hace ≤ 20 min;
// si publica por hora, ≥ 0,5 mm en su última hora y el dato de hace ≤ 90 min
function licor_wet(array $s): bool { return $s['stepMin'] < 60 ? $s['ageMin'] <= 20 && $s['rain30m'] >= 0.4 : $s['ageMin'] <= LICOR['freshMin'] && $s['lastMm'] >= LICOR['wetMm']; }
function licor_detail(array $s): string {
  $hm = fn($ms) => gmdate('H:i', intdiv($ms, 1000) - 18000);
  $h1 = $s['stepMin'] < 60 ? $s['rain1h'] : $s['lastMm'];
  $last = $h1 > 0 ? "Llovió $h1 mm en la última hora" . ($s['stepMin'] < 60 && $s['rain30m'] > 0 ? " ({$s['rain30m']} mm en la última media hora)" : '') : 'Sin lluvia en la última hora';
  return "$last · últimas 3 h: {$s['rain3h']} mm · 24 h: {$s['rain24h']} mm · lectura de las {$hm($s['lastTo'])} (hace {$s['ageMin']} min) · la estación está en la parte alta (~450 m)";
}
function licor_source(): array {
  $base = ['id' => 'estacion', 'kind' => 'observación', 'name' => 'Estación HOBO (LI-COR) · pluviómetro', 'intensity' => 0, 'rainNow' => 0];
  $now = now_ms(); $c = cache_get('licor') ?: [];
  if ($now - ($c['checked'] ?? 0) >= LICOR['ttl']) {
    $c['checked'] = $now;
    try {
      $cookie = $c['cookie'] ?? '';
      $r = licor_query($now, $cookie);
      // El tablero público pide una sesión anónima: se abre la página para obtenerla y se reintenta
      if ($r['code'] === 401 || $r['code'] === 403 || (!$r['err'] && $r['code'] === 200 && !(json_decode($r['body'], true)['success'] ?? false))) {
        $p = licor_http('GET', LICOR['base'] . '/dashboards/public/' . LICOR['dashboard'] . '/true', null, '');
        $cookie = implode('; ', array_map(fn($k, $v) => "$k=$v", array_keys($p['cookies']), $p['cookies']));
        $r = licor_query($now, $cookie);
      }
      if ($r['err']) throw new Exception($r['err']);
      if ($r['code'] !== 200) throw new Exception("respondió con error {$r['code']}");
      $j = json_decode($r['body'], true);
      $rec = $j['value']['records'][0] ?? null; $pts = $rec['datum']['valid'] ?? [];
      $pts = array_values(array_filter($pts, fn($p) => is_array($p) && count($p) >= 2 && is_numeric($p[0]) && is_numeric($p[1])));
      if (!$pts) throw new Exception(empty($j['success']) ? 'el tablero no entregó datos' : 'sin lecturas de lluvia en las últimas 24 h');
      $c = array_merge($c, ['cookie' => $cookie, 'sum' => licor_summary(array_map(fn($p) => [(int)$p[0], (float)$p[1]], $pts), $now), 'error' => '', 'okAt' => $now]);
    } catch (Throwable $e) { $c['error'] = $e->getMessage(); }
    cache_put('licor', $c);
  }
  if (empty($c['sum']) || $now - ($c['okAt'] ?? 0) > 3 * 3600000) return $base + ['ok' => false, 'error' => ($c['error'] ?? '') ?: 'sin datos de la estación'];
  $s = $c['sum']; $s['ageMin'] = max(0, (int)round(($now - $s['lastTo']) / 60000));
  if (!isset($s['rain30m'])) { $s['rain30m'] = 0; $s['rain1h'] = $s['lastMm']; } // dato guardado por la versión anterior
  $s['wet'] = licor_wet($s);
  return $base + ['ok' => true, 'at' => gmdate('c', intdiv($s['lastTo'], 1000))] + $s + ['detail' => licor_detail($s)];
}
