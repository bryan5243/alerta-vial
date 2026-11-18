<?php
// Google Flood Forecasting (opcional, requiere API key). Sin key devuelve "no configurado".
function get_flood(array $o): array {
  $lat = $o['lat']; $lng = $o['lng']; $key = $o['apiKey'] ?? ''; $hub = "https://sites.research.google/floods/l/$lat/$lng/10";
  if (!$key) return ['ok' => false, 'configured' => false, 'source' => 'Google Flood Forecasting', 'hubUrl' => $hub, 'gauges' => []];
  $c = cache_get('flood'); if ($c && now_ms() - $c['at'] < 1800000) return $c['data'];
  try {
    $body = json_encode(['regionCode' => 'EC', 'pageSize' => 20, 'areaBoundingBox' => ['minLatitude' => $lat - 0.5, 'maxLatitude' => $lat + 0.5, 'minLongitude' => $lng - 0.5, 'maxLongitude' => $lng + 0.5]]);
    $j = http_json(http_one(['url' => 'https://floodforecasting.googleapis.com/v1/gauges:searchGaugesByArea?key=' . urlencode($key), 'method' => 'POST', 'body' => $body, 'headers' => ['content-type' => 'application/json'], 'timeout' => 8]));
    $gauges = array_map(fn($g) => ['id' => $g['gaugeId'] ?? null, 'river' => $g['river'] ?? ($g['siteName'] ?? 'Río'), 'lat' => $g['location']['latitude'] ?? null, 'lng' => $g['location']['longitude'] ?? null, 'severity' => $g['severity'] ?? 'UNKNOWN'], $j['gauges'] ?? []);
    $data = ['ok' => true, 'configured' => true, 'source' => 'Google Flood Forecasting', 'hubUrl' => $hub, 'gauges' => $gauges];
    cache_put('flood', ['at' => now_ms(), 'data' => $data]);
    return $data;
  } catch (Throwable $e) { return ['ok' => false, 'configured' => true, 'error' => $e->getMessage(), 'source' => 'Google Flood Forecasting', 'hubUrl' => $hub, 'gauges' => []]; }
}
