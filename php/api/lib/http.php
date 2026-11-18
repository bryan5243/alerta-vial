<?php
// Consultas HTTP en paralelo con cURL (disponible en todos los cPanel). Cada petición devuelve
// ['code' => int, 'body' => string, 'err' => string]. Los mensajes de error son los mismos que usa la versión Node.
function http_multi(array $reqs): array {
  $mh = curl_multi_init(); $hs = [];
  foreach ($reqs as $k => $r) {
    $ch = curl_init($r['url']);
    $headers = [];
    foreach (($r['headers'] ?? []) as $hk => $hv) $headers[] = "$hk: $hv";
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => true, CURLOPT_MAXREDIRS => 3,
      CURLOPT_TIMEOUT => $r['timeout'] ?? 8, CURLOPT_CONNECTTIMEOUT => 5, CURLOPT_HTTPHEADER => $headers, CURLOPT_ENCODING => '']);
    if (($r['method'] ?? 'GET') === 'POST') { curl_setopt($ch, CURLOPT_POST, true); curl_setopt($ch, CURLOPT_POSTFIELDS, $r['body'] ?? ''); }
    curl_multi_add_handle($mh, $ch); $hs[$k] = $ch;
  }
  $running = 0;
  do { curl_multi_exec($mh, $running); if ($running) curl_multi_select($mh, 1.0); } while ($running > 0);
  $res = [];
  while ($info = curl_multi_info_read($mh)) $res[(int)$info['handle']] = $info['result'];
  $out = [];
  foreach ($hs as $k => $ch) {
    $errno = $res[(int)$ch] ?? curl_errno($ch); $code0 = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE) === 0;
    $out[$k] = ['code' => (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE), 'body' => (string)curl_multi_getcontent($ch),
      'err' => $errno ? ($errno === 28 ? 'no respondió a tiempo' : 'sin conexión') : ($code0 ? 'sin conexión' : '')];
    curl_multi_remove_handle($mh, $ch); curl_close($ch);
  }
  curl_multi_close($mh);
  return $out;
}
function http_one(array $req): array { return http_multi(['x' => $req])['x']; }
// Respuesta -> JSON o excepción con el mismo texto que la versión Node
function http_json(array $res) {
  if ($res['err']) throw new RuntimeException($res['err']);
  $c = $res['code'];
  if ($c < 200 || $c >= 300) throw new RuntimeException($c === 401 ? 'API key no válida' : ($c === 429 ? 'demasiadas consultas, reintenta luego' : "respondió con error $c"));
  $j = json_decode($res['body'], true);
  if ($j === null && trim($res['body']) !== 'null') throw new RuntimeException('respuesta no válida');
  return $j;
}
