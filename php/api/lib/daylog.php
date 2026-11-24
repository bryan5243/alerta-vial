<?php
// Diario del clima: cada día se anota lo que se vio (temperaturas, lluvia confirmada) y el último pronóstico del día.
// Así "Ayer" tiene dato aunque Open-Meteo no responda (MET Norway no da días pasados).
const RAIN_CODES = [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99];

function day_key(?int $ms = null): string { return gmdate('Y-m-d', (int)((($ms ?? now_ms()) - 5 * 3600000) / 1000)); }
function add_days(string $date, int $k): string { return gmdate('Y-m-d', strtotime($date . 'T12:00:00Z') + $k * 86400); }
function daylog_prune(array &$db): void {
  $keys = array_keys($db['dayLog'] ?? []); sort($keys);
  foreach (array_slice($keys, 0, max(0, count($keys) - 40)) as $k) unset($db['dayLog'][$k]);
}
// Se guarda si cambió algo o cada 5 minutos (para contar observaciones), sin escribir en cada visita
function daylog_due(): bool { $c = cache_get('daylog_save'); return !$c || now_ms() - ($c['at'] ?? 0) > 300000; }

function note_observation(array $w): void {
  if (empty($w['ok'])) return;
  $now = now_ms(); $date = day_key($now);
  $e0 = db_load()['dayLog'][$date] ?? ['date' => $date]; $e = $e0;
  if (($w['temperature'] ?? null) !== null) { $e['oMax'] = max($e['oMax'] ?? -99, $w['temperature']); $e['oMin'] = min($e['oMin'] ?? 99, $w['temperature']); }
  $since = ($now - strtotime($date . 'T05:00:00Z') * 1000) / 3600000;
  $e['oMm'] = max($e['oMm'] ?? 0, rain_from_log(max(0.1, $since), $now));
  $e['maxInt'] = max($e['maxInt'] ?? 0, $w['intensity'] ?? 0);
  $strip = function ($x) { unset($x['obs']); return $x; };
  $changed = json_encode($strip($e)) !== json_encode($strip($e0));
  if (!$changed && !daylog_due()) return;
  db_lock(); $db = &db();
  $cur = $db['dayLog'][$date] ?? ['date' => $date];
  $e['obs'] = ($cur['obs'] ?? 0) + 1;
  $db['dayLog'][$date] = $e; daylog_prune($db); db_save(); cache_put('daylog_save', ['at' => $now]);
}
function note_forecast(array &$db, ?array $card): bool {
  if (!$card || !empty($card['na'])) return false;
  $e = $db['dayLog'][$card['date']] ?? ['date' => $card['date']]; $before = json_encode($e);
  if (($card['tMax'] ?? null) !== null) $e['fMax'] = max($e['fMax'] ?? -99, $card['tMax']);
  if (($card['tMin'] ?? null) !== null) $e['fMin'] = min($e['fMin'] ?? 99, $card['tMin']);
  if (($card['mm'] ?? 0) >= ($e['fMm'] ?? -1)) { $e['fMm'] = $card['mm'] ?? 0; $e['code'] = $card['code'] ?? null; $e['text'] = $card['text'] ?? ''; }
  $db['dayLog'][$card['date']] = $e;
  return json_encode($e) !== $before;
}
function card_from_log(?array $e, int $rel): ?array {
  if (!$e || (($e['fMax'] ?? null) === null && ($e['oMax'] ?? null) === null)) return null;
  $observedRain = ($e['maxInt'] ?? 0) > 0 || ($e['oMm'] ?? 0) > 0; $obs = $e['obs'] ?? 0;
  $mm = $obs >= 6 ? r1($e['oMm'] ?? 0) : r1(max($e['oMm'] ?? 0, $e['fMm'] ?? 0));
  $text = $e['text'] ?? ''; $code = $e['code'] ?? null;
  if ($observedRain && !empty($e['maxInt'])) $text = INT_TXT[min(4, $e['maxInt'])];
  elseif ($obs >= 6 && in_array($code, RAIN_CODES, true)) { $text = WMO_TXT[3]; $code = 3; }
  return ['date' => $e['date'], 'rel' => $rel, 'code' => $code, 'text' => $text, 'tMax' => $e['oMax'] ?? $e['fMax'] ?? null, 'tMin' => $e['oMin'] ?? $e['fMin'] ?? null, 'mm' => $mm, 'saved' => true];
}
function with_history(array $d, array $cfg): array {
  if (empty($d['ok']) || empty($d['days'])) return $d;
  $today = null; foreach ($d['days'] as $x) if (($x['rel'] ?? null) === 0) $today = $x;
  $yDate = add_days($today['date'] ?? day_key(), -1);
  $days = $d['days']; $yi = null;
  foreach ($days as $i => $x) if (($x['rel'] ?? null) === -1) $yi = $i;
  if ($yi !== null && (!empty($days[$yi]['na']) || !empty($days[$yi]['partial']))) {
    $card = card_from_log(db_load()['dayLog'][$yDate] ?? null, -1);
    if (!$card) {
      $a = cache_get('archive');
      if ($a && ($a['date'] ?? '') === $yDate && !empty($a['card'])) $card = $a['card'];
      elseif (!$a || ($a['date'] ?? '') !== $yDate || now_ms() - ($a['at'] ?? 0) > 1800000) {
        $card = yesterday_from_archive($cfg, $yDate);
        cache_put('archive', ['date' => $yDate, 'card' => $card, 'at' => now_ms()]);
      }
    }
    if ($card) $days[$yi] = $card;
  }
  $db0 = db_load(); $tmp = $db0;
  if (note_forecast($tmp, $today)) { db_lock(); $db = &db(); note_forecast($db, $today); daylog_prune($db); db_save(); }
  return array_merge($d, ['days' => $days]);
}
