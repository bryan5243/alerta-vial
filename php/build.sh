#!/usr/bin/env bash
# Arma la carpeta lista para subir a cPanel: php/dist-cpanel/ (y el zip alertavial-cpanel.zip).
set -e
# Uso: ./build.sh            (para la raíz de un dominio o subdominio)
#      ./build.sh /alertavial (para una subcarpeta, p. ej. https://sitio.com/alertavial/)
cd "$(dirname "$0")"
BASE="${1:-}"
OUT=dist-cpanel
rm -rf "$OUT" && mkdir -p "$OUT/data"
cp -r ../public/. "$OUT/"
cp -r api "$OUT/api"
cp .htaccess config.php "$OUT/"
printf 'Require all denied\n<IfModule mod_access_compat.c>\n  Deny from all\n</IfModule>\n' > "$OUT/data/.htaccess"
[ -f ../data/initial.json ] && cp ../data/initial.json "$OUT/data/initial.json" && sed -i "s#__DIR__ . '/../../data/initial.json'#dirname(__DIR__, 2) . '/data/initial.json'#" "$OUT/api/lib/db.php" || true
[ -n "$BASE" ] && python3 subfolder.py "$OUT" "$BASE"
echo "Listo: php/$OUT"
(cd "$OUT" && rm -f ../alertavial-cpanel.zip && zip -qr ../alertavial-cpanel.zip . -x '.DS_Store') && echo "Zip: php/alertavial-cpanel.zip"
