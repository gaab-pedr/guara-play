#!/usr/bin/env bash
# Restaura um backup do Guará Play.  Uso:  bash restore.sh ~/backups-guara/guara-AAAA-MM-DD_HHMM.tar.gz
# Para o serviço, copia os arquivos de volta e inicia de novo.
set -euo pipefail
ARQ="${1:?informe o arquivo de backup}"
APP_DIR="${APP_DIR:-/opt/signage}"
sudo systemctl stop guara 2>/dev/null || pkill -f "node server.js" || true
TMP="$(mktemp -d)"; tar -xzf "$ARQ" -C "$TMP"
sudo cp "$TMP/data.json" "$APP_DIR/" 2>/dev/null || cp "$TMP/data.json" "$APP_DIR/"
[ -f "$TMP/stats.json" ] && (sudo cp "$TMP/stats.json" "$APP_DIR/" 2>/dev/null || cp "$TMP/stats.json" "$APP_DIR/") || true
[ -d "$TMP/media" ] && (sudo rm -rf "$APP_DIR/media"; sudo cp -r "$TMP/media" "$APP_DIR/" 2>/dev/null || cp -r "$TMP/media" "$APP_DIR/") || true
rm -rf "$TMP"
sudo systemctl start guara 2>/dev/null || echo "Inicie o servidor manualmente (node server.js)."
echo "Restaurado a partir de $ARQ"
