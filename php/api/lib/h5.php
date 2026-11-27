<?php
// Lector mínimo de archivos HDF5/NetCDF-4 en PHP puro (sin extensiones): lo justo para los productos del satélite GOES
// (altura de nubes ABI-L2-ACHAF y rayos GLM-L2-LCFA). Soporta superbloque v2/v3, cabeceras de objeto v2 (con bloques
// de continuación), datos contiguos o en bloques (índice B-tree v1) con filtros "shuffle" y "deflate", y atributos sencillos.
// Las variables se buscan por nombre en los mensajes de enlace (aunque estén en el "fractal heap" del grupo raíz).

function h5_u(string $s, int $o, int $k): int { $v = 0; for ($i = $k - 1; $i >= 0; $i--) $v = $v * 256 + ord($s[$o + $i]); return $v; }

// Mensajes de una cabecera de objeto v2: [[tipo, posición, tamaño], ...]
function h5_messages(string $f, int $addr): array {
  if (substr($f, $addr, 4) !== 'OHDR') throw new Exception('cabecera HDF5 no soportada');
  $fl = ord($f[$addr + 5]); $o = $addr + 6;
  if ($fl & 0x20) $o += 16; if ($fl & 0x10) $o += 4;
  $sz = [1, 2, 4, 8][$fl & 3]; $len = h5_u($f, $o, $sz); $o += $sz;
  $blocks = [[$o, $o + $len]]; $out = [];
  for ($b = 0; $b < count($blocks) && $b < 64; $b++) {
    [$o, $end] = $blocks[$b];
    while ($o + 4 <= $end - 4) {
      $t = ord($f[$o]); $ms = h5_u($f, $o + 1, 2); $o += 4; if ($fl & 4) $o += 2;
      if ($t === 0x10) { $ca = h5_u($f, $o, 8); $cl = h5_u($f, $o + 8, 8); if (substr($f, $ca, 4) === 'OCHK') $blocks[] = [$ca + 4, $ca + $cl]; }
      elseif ($t) $out[] = [$t, $o, $ms];
      $o += $ms;
    }
  }
  return $out;
}

// Busca una variable por nombre: en el mensaje de enlace el nombre va seguido de la dirección de su cabecera
function h5_find(string $f, string $name): ?int {
  $n = strlen($name); $pos = 0;
  while (($p = strpos($f, $name, $pos)) !== false) {
    $pos = $p + 1;
    if ($p < 1 || ord($f[$p - 1]) !== $n) continue;
    $a = h5_u($f, $p + $n, 8);
    if ($a > 0 && $a + 4 < strlen($f) && substr($f, $a, 4) === 'OHDR') return $a;
  }
  return null;
}

// Tipo de dato (mensaje 0x03): clase 0 = entero, 1 = coma flotante
function h5_dtype(string $f, int $o): array {
  $cls = ord($f[$o]) & 15; $b0 = ord($f[$o + 1]);
  return ['cls' => $cls, 'size' => h5_u($f, $o + 4, 4), 'be' => (bool)($b0 & 1), 'signed' => $cls === 0 && ($b0 & 8)];
}
function h5_value(string $raw, array $t) {
  if ($t['be']) $raw = strrev($raw);
  if ($t['cls'] === 1) return $t['size'] === 8 ? unpack('e', $raw)[1] : unpack('g', $raw)[1];
  $v = h5_u($raw, 0, $t['size']);
  if ($t['signed'] && $v >= 2 ** ($t['size'] * 8 - 1)) $v -= 2 ** ($t['size'] * 8);
  return $v;
}

function h5_dataset(string $f, int $addr): array {
  $d = ['dims' => [], 'type' => null, 'layout' => null, 'filters' => [], 'attrs' => []];
  foreach (h5_messages($f, $addr) as [$t, $o, $ms]) {
    if ($t === 0x01) { $v = ord($f[$o]); $nd = ord($f[$o + 1]); $off = $v === 1 ? 8 : 4; for ($i = 0; $i < $nd; $i++) $d['dims'][] = h5_u($f, $o + $off + 8 * $i, 8); }
    elseif ($t === 0x03) $d['type'] = h5_dtype($f, $o);
    elseif ($t === 0x08) {
      $v = ord($f[$o]); $cls = ord($f[$o + 1]);
      if ($v !== 3) throw new Exception("disposición HDF5 v$v no soportada");
      if ($cls === 1) $d['layout'] = ['cls' => 1, 'addr' => h5_u($f, $o + 2, 8), 'size' => h5_u($f, $o + 10, 8)];
      elseif ($cls === 2) { $nd = ord($f[$o + 2]); $cd = []; for ($i = 0; $i < $nd; $i++) $cd[] = h5_u($f, $o + 11 + 4 * $i, 4); $d['layout'] = ['cls' => 2, 'btree' => h5_u($f, $o + 3, 8), 'chunk' => $cd]; }
      else $d['layout'] = ['cls' => 0];
    }
    elseif ($t === 0x0B) {
      $v = ord($f[$o]); $n = ord($f[$o + 1]); $p = $o + ($v === 1 ? 8 : 2);
      for ($i = 0; $i < $n; $i++) {
        $id = h5_u($f, $p, 2); $nl = ($v === 1 || $id >= 256) ? h5_u($f, $p + 2, 2) : 0; $p += ($v === 1 || $id >= 256) ? 4 : 2;
        $nv = h5_u($f, $p + 2, 2); $p += 4; if ($nl) $p += $v === 1 ? (int)(ceil($nl / 8) * 8) : $nl;
        $p += 4 * $nv; if ($v === 1 && $nv % 2) $p += 4;
        $d['filters'][] = $id;
      }
    }
    elseif ($t === 0x0C) { // atributo (v1, v2 o v3): solo números y textos sencillos
      $v = ord($f[$o]);
      if ($v === 1) { $nl = h5_u($f, $o + 2, 2); $tl = h5_u($f, $o + 4, 2); $sl = h5_u($f, $o + 6, 2); $p = $o + 8; $pad = fn($x) => (int)(ceil($x / 8) * 8);
        $name = rtrim(substr($f, $p, $nl), "\0"); $tp = $p + $pad($nl); $sp = $tp + $pad($tl); $dp = $sp + $pad($sl); }
      else { $nl = h5_u($f, $o + 2, 2); $tl = h5_u($f, $o + 4, 2); $sl = h5_u($f, $o + 6, 2); $p = $o + 8 + ($v === 3 ? 1 : 0);
        $name = rtrim(substr($f, $p, $nl), "\0"); $tp = $p + $nl; $sp = $tp + $tl; $dp = $sp + $sl; }
      $ty = h5_dtype($f, $tp);
      if ($ty['cls'] === 3) $d['attrs'][$name] = rtrim(substr($f, $dp, $ty['size']), "\0 ");
      elseif ($ty['cls'] <= 1 && $ty['size'] <= 8) $d['attrs'][$name] = h5_value(substr($f, $dp, $ty['size']), $ty);
    }
  }
  if (!$d['type'] || !$d['layout']) throw new Exception('variable HDF5 incompleta');
  return $d;
}

// Bloques de datos (B-tree v1 de tipo 1): [[desplazamientos], dirección, tamaño, máscara de filtros]
function h5_chunks(string $f, int $addr, int $rank, int $depth = 0): array {
  if ($depth > 10 || substr($f, $addr, 4) !== 'TREE') throw new Exception('índice HDF5 no soportado');
  $lvl = ord($f[$addr + 5]); $n = h5_u($f, $addr + 6, 2); $p = $addr + 24; $out = []; $ks = 8 + 8 * ($rank + 1);
  for ($i = 0; $i < $n; $i++) {
    $size = h5_u($f, $p, 4); $mask = h5_u($f, $p + 4, 4); $off = []; for ($k = 0; $k < $rank; $k++) $off[] = h5_u($f, $p + 8 + 8 * $k, 8);
    $child = h5_u($f, $p + $ks, 8); $p += $ks + 8;
    if ($lvl > 0) array_push($out, ...h5_chunks($f, $child, $rank, $depth + 1));
    else $out[] = [$off, $child, $size, $mask];
  }
  return $out;
}
function h5_unfilter(string $raw, array $filters, int $mask, int $esize): string {
  for ($i = count($filters) - 1; $i >= 0; $i--) { // los filtros se deshacen en orden inverso
    if ($mask & (1 << $i)) continue;
    if ($filters[$i] === 1) { $raw = h5_inflate($raw); if ($raw === false) throw new Exception('bloque HDF5 dañado'); }
    elseif ($filters[$i] === 2 && $esize > 1) { $n = intdiv(strlen($raw), $esize); $o = '';
      for ($e = 0; $e < $n; $e++) for ($b = 0; $b < $esize; $b++) $o .= $raw[$b * $n + $e];
      $raw = $o; }
    elseif ($filters[$i] !== 2) throw new Exception("filtro HDF5 $filters[$i] no soportado");
  }
  return $raw;
}

// Lee una variable 1-D completa o un recuadro [r0..r1]×[c0..c1] de una 2-D. Devuelve los valores crudos (sin escala).
function h5_read(string $f, array $d, ?array $box = null): array {
  $t = $d['type']; $es = $t['size']; $dims = $d['dims']; $rank = count($dims);
  [$r0, $r1, $c0, $c1] = $box ?? [0, $dims[0] - 1, 0, ($dims[1] ?? 1) - 1];
  $W = $c1 - $c0 + 1; $out = array_fill(0, ($r1 - $r0 + 1) * ($rank === 2 ? $W : 1), null);
  $put = function (string $raw, array $off, array $cd) use (&$out, $t, $es, $rank, $r0, $r1, $c0, $c1, $W) {
    if ($rank === 1) { for ($i = 0, $n = intdiv(strlen($raw), $es); $i < $n; $i++) { $g = $off[0] + $i; if ($g >= $r0 && $g <= $r1) $out[$g - $r0] = h5_value(substr($raw, $i * $es, $es), $t); } return; }
    $rs = max($r0, $off[0]); $re = min($r1, $off[0] + $cd[0] - 1); $cs = max($c0, $off[1]); $ce = min($c1, $off[1] + $cd[1] - 1);
    for ($r = $rs; $r <= $re; $r++) for ($c = $cs; $c <= $ce; $c++)
      $out[($r - $r0) * $W + ($c - $c0)] = h5_value(substr($raw, (($r - $off[0]) * $cd[1] + ($c - $off[1])) * $es, $es), $t);
  };
  $L = $d['layout'];
  if ($L['cls'] === 1) { $put(substr($f, $L['addr'], $L['size']), array_fill(0, $rank, 0), $dims); return $out; }
  if ($L['cls'] !== 2) throw new Exception('disposición HDF5 no soportada');
  $cd = array_slice($L['chunk'], 0, $rank);
  foreach (h5_chunks($f, $L['btree'], $rank) as [$off, $a, $size, $mask]) {
    if ($off[0] > $r1 || $off[0] + $cd[0] - 1 < $r0) continue;
    if ($rank === 2 && ($off[1] > $c1 || $off[1] + $cd[1] - 1 < $c0)) continue;
    $put(h5_unfilter(substr($f, $a, $size), $d['filters'], $mask, $es), $off, $cd);
  }
  return $out;
}

// Descompresión "deflate" (formato zlib). Algunos hostings no traen la extensión zlib de PHP: entonces se usa un
// decodificador escrito en PHP (RFC 1950/1951), más lento pero suficiente para los bloques pequeños del satélite.
function h5_inflate(string $data) {
  if (function_exists('gzuncompress')) return @gzuncompress($data);
  try { return h5_inflate_raw($data, 2); } catch (Throwable $e) { return false; }
}
function h5_huff(array $lens): array { // tabla: [código canónico por longitud] → símbolo
  $max = max($lens ?: [0]); $count = array_fill(0, $max + 1, 0);
  foreach ($lens as $l) if ($l) $count[$l]++;
  $code = 0; $next = []; for ($b = 1; $b <= $max; $b++) { $code = ($code + ($count[$b - 1] ?? 0)) << 1; $next[$b] = $code; }
  $t = []; foreach ($lens as $sym => $l) if ($l) { $t[$l][$next[$l]++] = $sym; }
  return [$t, $max];
}
function h5_inflate_raw(string $in, int $pos = 0): string {
  $out = ''; $bit = 0; $byte = 0; $n = strlen($in); $p = $pos;
  $get = function (int $k) use (&$bit, &$byte, &$p, $in, $n) { $v = 0; for ($i = 0; $i < $k; $i++) { if (!$bit) { if ($p >= $n) throw new Exception('datos cortados'); $byte = ord($in[$p++]); $bit = 8; } $v |= ($byte & 1) << $i; $byte >>= 1; $bit--; } return $v; };
  $dec = function (array $h) use (&$bit, &$byte, &$p, $in, $n) { [$t, $max] = $h; $code = 0;
    for ($l = 1; $l <= $max; $l++) { if (!$bit) { if ($p >= $n) throw new Exception('datos cortados'); $byte = ord($in[$p++]); $bit = 8; } $code = ($code << 1) | ($byte & 1); $byte >>= 1; $bit--; if (isset($t[$l][$code])) return $t[$l][$code]; }
    throw new Exception('código no válido'); };
  static $LB = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258], $LE = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
  static $DB = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577], $DE = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
  static $FIX = null;
  if (!$FIX) { $l = array_merge(array_fill(0, 144, 8), array_fill(0, 112, 9), array_fill(0, 24, 7), array_fill(0, 8, 8)); $FIX = [h5_huff($l), h5_huff(array_fill(0, 30, 5))]; }
  do {
    $final = $get(1); $type = $get(2);
    if ($type === 0) { $bit = 0; $len = ord($in[$p]) | (ord($in[$p + 1]) << 8); $p += 4; $out .= substr($in, $p, $len); $p += $len; continue; }
    if ($type === 1) [$lit, $dist] = $FIX;
    elseif ($type === 2) {
      $hl = $get(5) + 257; $hd = $get(5) + 1; $hc = $get(4) + 4; $ord = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];
      $cl = array_fill(0, 19, 0); for ($i = 0; $i < $hc; $i++) $cl[$ord[$i]] = $get(3);
      $ch = h5_huff($cl); $ls = [];
      while (count($ls) < $hl + $hd) { $s = $dec($ch);
        if ($s < 16) $ls[] = $s;
        elseif ($s === 16) { $r = 3 + $get(2); $v = end($ls); for ($i = 0; $i < $r; $i++) $ls[] = $v; }
        elseif ($s === 17) { $r = 3 + $get(3); for ($i = 0; $i < $r; $i++) $ls[] = 0; }
        else { $r = 11 + $get(7); for ($i = 0; $i < $r; $i++) $ls[] = 0; } }
      $lit = h5_huff(array_slice($ls, 0, $hl)); $dist = h5_huff(array_slice($ls, $hl, $hd));
    } else throw new Exception('bloque no válido');
    while (true) {
      $s = $dec($lit);
      if ($s < 256) { $out .= chr($s); continue; }
      if ($s === 256) break;
      $s -= 257; $len = $LB[$s] + $get($LE[$s]); $d = $dec($dist); $dd = $DB[$d] + $get($DE[$d]);
      $start = strlen($out) - $dd;
      if ($dd >= $len) $out .= substr($out, $start, $len);
      else for ($i = 0; $i < $len; $i++) $out .= $out[$start + $i];
    }
  } while (!$final);
  return $out;
}
