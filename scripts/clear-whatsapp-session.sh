#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$PROJECT_ROOT/.env}"
SESSION_ID_OVERRIDE=""
CLEAR_AUTH_FILES=0

log() {
  printf '[clear-whatsapp-session] %s\n' "$*"
}

fail() {
  printf '[clear-whatsapp-session] erro: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "comando ausente: $1"
  fi
}

resolve_db_name() {
  local base_name="$1"
  local node_env="${2:-development}"

  if [[ "$base_name" == *_dev || "$base_name" == *_prod ]]; then
    printf '%s' "$base_name"
    return 0
  fi

  if [[ "$node_env" == "production" ]]; then
    printf '%s_prod' "$base_name"
  else
    printf '%s_dev' "$base_name"
  fi
}

usage() {
  cat <<'EOF'
Uso:
  bash scripts/clear-whatsapp-session.sh [opcoes]

Opcoes:
  --session <id>        Forca um session_id especifico (padrao: BAILEYS_AUTH_SESSION_ID ou "default")
  --clear-auth-files    Remove app/connection/auth/*.json tambem (evita rebootstrap da sessao antiga)
  -h, --help            Mostra esta ajuda
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --session)
      [[ $# -ge 2 ]] || fail "faltou valor para --session"
      SESSION_ID_OVERRIDE="$2"
      shift 2
      ;;
    --clear-auth-files)
      CLEAR_AUTH_FILES=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "opcao invalida: $1 (use --help)"
      ;;
  esac
done

require_cmd mysql
require_cmd base64

if [[ ! -f "$ENV_FILE" ]]; then
  fail "arquivo .env nao encontrado em: $ENV_FILE"
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

DB_HOST="${DB_HOST:-}"
DB_USER="${DB_USER:-}"
DB_PASSWORD="${DB_PASSWORD:-}"
DB_NAME="${DB_NAME:-}"
NODE_ENV_VALUE="${NODE_ENV:-development}"
SESSION_ID="${SESSION_ID_OVERRIDE:-${BAILEYS_AUTH_SESSION_ID:-default}}"

[[ -n "$DB_HOST" ]] || fail "DB_HOST nao definido no .env"
[[ -n "$DB_USER" ]] || fail "DB_USER nao definido no .env"
[[ -n "$DB_PASSWORD" ]] || fail "DB_PASSWORD nao definido no .env"
[[ -n "$DB_NAME" ]] || fail "DB_NAME nao definido no .env"
[[ -n "$SESSION_ID" ]] || SESSION_ID="default"

DB_REAL_NAME="$(resolve_db_name "$DB_NAME" "$NODE_ENV_VALUE")"
SESSION_ID_B64="$(printf '%s' "$SESSION_ID" | base64 -w0)"

log "Limpando sessao '$SESSION_ID' na tabela baileys_auth_state (database: $DB_REAL_NAME)..."

mysql -h "$DB_HOST" -u "$DB_USER" "-p$DB_PASSWORD" "$DB_REAL_NAME" <<SQL
SET @sid = CONVERT(FROM_BASE64('${SESSION_ID_B64}') USING utf8mb4);
DELETE FROM baileys_auth_state WHERE session_id = @sid;
SELECT ROW_COUNT() AS removed_rows, @sid AS session_id;
SQL

if [[ "$CLEAR_AUTH_FILES" == "1" ]]; then
  AUTH_DIR="$PROJECT_ROOT/app/connection/auth"
  if compgen -G "$AUTH_DIR/*.json" >/dev/null 2>&1; then
    rm -f "$AUTH_DIR"/*.json
    log "Arquivos legados removidos em: $AUTH_DIR/*.json"
  else
    log "Nenhum arquivo legado encontrado em: $AUTH_DIR"
  fi
fi

if [[ "${BAILEYS_AUTH_BOOTSTRAP_FROM_FILES:-true}" == "true" && "$CLEAR_AUTH_FILES" != "1" ]]; then
  log "Aviso: BAILEYS_AUTH_BOOTSTRAP_FROM_FILES=true. Considere usar --clear-auth-files para evitar restaurar sessao antiga."
fi

log "Concluido. Reinicie o bot para gerar novo QR Code."
