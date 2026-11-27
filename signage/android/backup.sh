#!/usr/bin/env bash
# Backup do Guará Play: cadastro (data.json), relatórios (stats.json) e arquivos (media/).
# Uso:  bash backup.sh                 (usa /opt/signage e guarda em ~/backups-guara)
#       APP_DIR=/caminho BACKUP_DIR=/destino bash backup.sh
# Mantém os últimos 14 backups. Para agendar todo dia às 3h:  crontab -e  e adicione:
#   0 3 * * * bash /opt/signage/backup.sh >> ~/backups-guara/log.txt 2>&1
set -euo pipefail
APP_DIR="${APP_DIR:-/opt/signage}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups-guara}"
KEEP="${KEEP:-14}"
mkdir -p "$BACKUP_DIR"
[ -f "$APP_DIR/data.json" ] || { echo "Não achei $APP_DIR/data.json. Confira APP_DIR."; exit 1; }
STAMP="$(date +%Y-%m-%d_%H%M%S)"
TMP="$(mktemp -d)"
cp "$APP_DIR/data.json" "$TMP/" 2>/dev/null || true
cp "$APP_DIR/stats.json" "$TMP/" 2>/dev/null || true
[ -d "$APP_DIR/media" ] && cp -r "$APP_DIR/media" "$TMP/" || true
OUT="$BACKUP_DIR/guara-$STAMP.tar.gz"
tar -czf "$OUT" -C "$TMP" .
rm -rf "$TMP"
echo "Backup criado: $OUT ($(du -h "$OUT" | cut -f1))"
# apaga os mais antigos, mantendo os últimos $KEEP
ls -1t "$BACKUP_DIR"/guara-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
