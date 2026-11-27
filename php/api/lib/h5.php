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
    if ($filters[$i] === 1) { $raw = @gzuncompress($raw); if ($raw === false) throw new Exception('bloque HDF5 dañado'); }
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
