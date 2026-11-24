<?php
// Notificaciones push (Web Push) solo con OpenSSL de PHP: firma VAPID (ES256) y cifrado aes128gcm (RFC 8291).
// Las claves se crean una vez y se guardan en la base (db.push), en el mismo formato que la versión Node,
// así un respaldo sirve en las dos versiones.
function b64u(string $s): string { return rtrim(strtr(base64_encode($s), '+/', '-_'), '='); }
function b64u_dec(string $s): string { return (string)base64_decode(strtr($s, '-_', '+/') . str_repeat('=', (4 - strlen($s) % 4) % 4)); }
function der_len(int $n): string { return $n < 128 ? chr($n) : "\x81" . chr($n); }
function ec_pub_pem(string $point): string { // punto sin comprimir (65 bytes) -> clave pública PEM
  $der = hex2bin('3059301306072a8648ce3d020106082a8648ce3d030107034200') . $point;
  return "-----BEGIN PUBLIC KEY-----\n" . chunk_split(base64_encode($der), 64, "\n") . "-----END PUBLIC KEY-----\n";
}
function ec_priv_pem(string $d, string $point): string { // d (32 bytes) + punto público -> clave privada PEM
  $der = "\x30\x77\x02\x01\x01\x04\x20" . $d . "\xa0\x0a\x06\x08" . hex2bin('2a8648ce3d030107') . "\xa1\x44\x03\x42\x00" . $point;
  return "-----BEGIN EC PRIVATE KEY-----\n" . chunk_split(base64_encode($der), 64, "\n") . "-----END EC PRIVATE KEY-----\n";
}
function ec_new(): array { // [clave, punto público 65 bytes, d 32 bytes]
  $k = openssl_pkey_new(['curve_name' => 'prime256v1', 'private_key_type' => OPENSSL_KEYTYPE_EC]);
  $e = openssl_pkey_get_details($k)['ec'];
  $p = fn($s) => str_pad($s, 32, "\0", STR_PAD_LEFT);
  return [$k, "\x04" . $p($e['x']) . $p($e['y']), $p($e['d'])];
}
function push_store(): array {
  $db = db_load();
  if (empty($db['push']['vapid'])) {
    db_lock(); $db = &db();
    if (empty($db['push']['vapid'])) { [, $pub, $d] = ec_new(); $db['push']['vapid'] = ['publicKey' => b64u($pub), 'privateKey' => b64u($d)]; db_save(); }
  }
  $p = db_load()['push']; $p['subs'] ??= []; $p['last'] ??= [];
  return $p;
}
function push_public_key(): string { return push_store()['vapid']['publicKey']; }
function push_count(): int { return count(push_store()['subs']); }
function push_add_sub($sub): bool {
  if (!is_array($sub) || !is_string($sub['endpoint'] ?? null) || !preg_match('#^https://#', $sub['endpoint']) || empty($sub['keys']['p256dh']) || empty($sub['keys']['auth'])) return false;
  push_store(); db_lock(); $db = &db(); $subs = $db['push']['subs'] ?? [];
  $subs = array_values(array_filter($subs, fn($s) => $s['endpoint'] !== $sub['endpoint']));
  if (count($subs) >= 5000) array_shift($subs);
  $subs[] = ['endpoint' => $sub['endpoint'], 'keys' => ['p256dh' => (string)$sub['keys']['p256dh'], 'auth' => (string)$sub['keys']['auth']], 'at' => gmdate('c')];
  $db['push']['subs'] = $subs; db_save(); return true;
}
function push_remove_sub(string $endpoint): void {
  $subs = push_store()['subs']; $n = count($subs);
  $keep = array_values(array_filter($subs, fn($s) => $s['endpoint'] !== $endpoint));
  if (count($keep) !== $n) { db_lock(); $db = &db(); $db['push']['subs'] = array_values(array_filter($db['push']['subs'] ?? [], fn($s) => $s['endpoint'] !== $endpoint)); db_save(); }
}
function vapid_header(string $endpoint, array $vapid): string {
  $u = parse_url($endpoint); $aud = $u['scheme'] . '://' . $u['host'] . (isset($u['port']) ? ':' . $u['port'] : '');
  $sub = getenv('VAPID_SUBJECT') ?: (defined('AV_VAPID_SUBJECT') ? AV_VAPID_SUBJECT : 'mailto:alertavial@emovtt.gob.ec');
  $data = b64u(json_encode(['typ' => 'JWT', 'alg' => 'ES256'])) . '.' . b64u(json_encode(['aud' => $aud, 'exp' => time() + 12 * 3600, 'sub' => $sub], JSON_UNESCAPED_SLASHES));
  $pub = b64u_dec($vapid['publicKey']);
  openssl_sign($data, $der, ec_priv_pem(b64u_dec($vapid['privateKey']), $pub), OPENSSL_ALGO_SHA256);
  // firma DER -> r||s de 32 bytes cada uno
  $o = 3; $rl = ord($der[$o]); $r = substr($der, $o + 1, $rl); $o += 1 + $rl + 1; $sl = ord($der[$o]); $s = substr($der, $o + 1, $sl);
  $fix = fn($x) => str_pad(ltrim($x, "\0"), 32, "\0", STR_PAD_LEFT);
  return 'vapid t=' . $data . '.' . b64u($fix($r) . $fix($s)) . ', k=' . $vapid['publicKey'];
}
function push_encrypt(string $payload, string $p256dh, string $auth): string {
  $uaPub = b64u_dec($p256dh); $authSecret = b64u_dec($auth);
  [$asKey, $asPub] = ec_new();
  $ecdh = openssl_pkey_derive(openssl_pkey_get_public(ec_pub_pem($uaPub)), $asKey, 32);
  $ikm = hash_hmac('sha256', "WebPush: info\0" . $uaPub . $asPub . "\x01", hash_hmac('sha256', $ecdh, $authSecret, true), true);
  $salt = random_bytes(16); $prk = hash_hmac('sha256', $ikm, $salt, true);
  $cek = substr(hash_hmac('sha256', "Content-Encoding: aes128gcm\0\x01", $prk, true), 0, 16);
  $nonce = substr(hash_hmac('sha256', "Content-Encoding: nonce\0\x01", $prk, true), 0, 12);
  $ct = openssl_encrypt($payload . "\x02", 'aes-128-gcm', $cek, OPENSSL_RAW_DATA, $nonce, $tag);
  return $salt . pack('N', 4096) . chr(65) . $asPub . $ct . $tag;
}
function push_send_all(array $msg): array {
  $p = push_store();
  $payload = json_encode(['title' => $msg['title'], 'body' => $msg['body'], 'tag' => $msg['tag'] ?? 'alertavial', 'level' => $msg['level'] ?? 'normal', 'url' => '/'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
  $sent = 0; $dead = []; $total = count($p['subs']);
  foreach (array_chunk($p['subs'], 50) as $chunk) {
    $reqs = [];
    foreach ($chunk as $i => $s) {
      try {
        $reqs[$i] = ['url' => $s['endpoint'], 'method' => 'POST', 'body' => push_encrypt($payload, $s['keys']['p256dh'], $s['keys']['auth']), 'timeout' => 10,
          'headers' => ['Authorization' => vapid_header($s['endpoint'], $p['vapid']), 'Content-Encoding' => 'aes128gcm', 'Content-Type' => 'application/octet-stream', 'TTL' => '10800', 'Urgency' => 'high']];
      } catch (Throwable $e) { $dead[] = $s['endpoint']; }
    }
    foreach (http_multi($reqs) as $i => $r) {
      if ($r['code'] >= 200 && $r['code'] < 300) $sent++;
      elseif ($r['code'] === 404 || $r['code'] === 410) $dead[] = $chunk[$i]['endpoint'];
    }
  }
  if ($dead) { db_lock(); $db = &db(); $db['push']['subs'] = array_values(array_filter($db['push']['subs'] ?? [], fn($s) => !in_array($s['endpoint'], $dead, true))); db_save(); }
  return ['sent' => $sent, 'removed' => count($dead), 'total' => $total];
}

// Decide qué avisar según el estado actual. Solo avisa cuando algo EMPIEZA o EMPEORA (no repite cada 5 minutos).
function push_check_and_notify(array $st, ?string $levelMessage, bool $simulated): array {
  // Las simulaciones llevan su propio registro (lastSim) y no tienen espera entre avisos: cada prueba avisa,
  // y una prueba no bloquea el aviso de una lluvia real durante 2 h.
  $p = push_store(); $now = now_ms(); $pre = $simulated ? 'Prueba: ' : ''; $out = [];
  $slot = $simulated ? 'lastSim' : 'last'; $L = $simulated ? ($p['lastSim'] ?? ['init' => true]) : $p['last'];
  if (!$simulated && isset($p['lastSim'])) { db_lock(); $db = &db(); unset($db['push']['lastSim']); db_save(); }
  $NAME = ['amarilla' => 'Alerta amarilla', 'naranja' => 'Alerta naranja', 'roja' => 'Alerta roja']; $COOL = 2 * 3600000;
  $w = $st['weather'] ?? []; $ol = $w['outlook']['level'] ?? null;
  $storm = ($w['intensity'] ?? 0) >= 4; foreach ($w['outlook']['reasons'] ?? [] as $r) if (preg_match('/prevé tormenta|reporta tormenta/u', (string)$r)) $storm = true;
  $rainy = $ol === 'lloviendo' || ($w['intensity'] ?? 0) > 0; $soon = $ol === 'probable';
  $can = fn($k) => $simulated || empty($L[$k . 'At']) || $now - $L[$k . 'At'] > $COOL;
  $msgs = [];
  $first = ($L['init'] ?? false) !== true; $L['init'] = true;
  $lv = LV[$st['effective']] ?? 0; $prev = $L['level'] ?? 0;
  if (!$first && $lv > $prev && $lv >= 1) $msgs['level'] = ['title' => $pre . $NAME[$st['effective']] . ' en Santa Rosa', 'body' => $levelMessage ?: 'Revisa el mapa para ver las calles afectadas.', 'tag' => 'nivel', 'level' => $st['effective']];
  $L['level'] = $lv;
  if (!$first && $storm && empty($L['storm']) && $can('storm')) $msgs['storm'] = ['title' => $pre . 'Tormenta en la zona', 'body' => 'Hay tormenta o se prevé en las próximas horas. Evita ríos, canales y calles bajas.', 'tag' => 'tormenta', 'level' => 'naranja'];
  $L['storm'] = $storm;
  if (!$first && !$storm && $soon && empty($L['soon']) && !$rainy && $can('soon')) $msgs['soon'] = ['title' => $pre . 'Se aproxima lluvia', 'body' => ($w['outlook']['text'] ?? '') ?: 'Es probable un aguacero en las próximas horas. Lleva paraguas.', 'tag' => 'lluvia', 'level' => 'amarilla'];
  $L['soon'] = $soon;
  if (!$first && $rainy && empty($L['rain']) && $can('rain')) $msgs['rain'] = ['title' => $pre . 'Está lloviendo en Santa Rosa', 'body' => 'Revisa las calles inundadas y las vías alternas antes de salir.', 'tag' => 'lluvia', 'level' => 'amarilla'];
  $L['rain'] = $rainy;
  foreach ($msgs as $k => $m) $L[$k . 'At'] = $now;
  if (json_encode($L) !== json_encode($p[$slot] ?? null)) { db_lock(); $db = &db(); $db['push'][$slot] = $L; db_save(); }
  foreach ($msgs as $k => $m) { $out[] = ['k' => $k] + $m; if ($p['subs']) push_send_all($m); }
  return $out;
}
