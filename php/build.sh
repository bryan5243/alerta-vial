#!/usr/bin/env bash
# Arma la carpeta lista para subir a cPanel: php/dist-cpanel/ (y el zip alertavial-cpanel.zip).
set -e
cd "$(dirname "$0")"
OUT=dist-cpanel
rm -rf "$OUT" && mkdir -p "$OUT/data"
cp -r ../public/. "$OUT/"
cp -r api "$OUT/api"
cp .htaccess config.php "$OUT/"
printf 'Require all denied\n<IfModule mod_access_compat.c>\n  Deny from all\n</IfModule>\n' > "$OUT/data/.htaccess"
[ -f ../data/initial.json ] && cp ../data/initial.json "$OUT/data/initial.json" && sed -i "s#__DIR__ . '/../../data/initial.json'#dirname(__DIR__, 2) . '/data/initial.json'#" "$OUT/api/lib/db.php" || true
echo "Listo: php/$OUT"
(cd "$OUT" && rm -f ../alertavial-cpanel.zip && zip -qr ../alertavial-cpanel.zip . -x '.DS_Store') && echo "Zip: php/alertavial-cpanel.zip"
