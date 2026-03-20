#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="${DEPLOY_SOURCE_DIR:-$PROJECT_ROOT/public}"
DEPLOY_DIR="${DEPLOY_TARGET_DIR:-/var/www/omnizap}"
BACKUP_ENABLED="${DEPLOY_CREATE_BACKUP:-1}"
BACKUP_DIR="${DEPLOY_BACKUP_DIR:-$DEPLOY_DIR/.backup}"
NGINX_SERVICE="${DEPLOY_NGINX_SERVICE:-nginx}"
RESTART_PM2="${DEPLOY_RESTART_PM2:-1}"
PM2_APP_NAME="${DEPLOY_PM2_APP_NAME:-omnizap-production}"
BUILD_ID="${DEPLOY_BUILD_ID:-$(date -u +%Y%m%d%H%M%S)}"
VERIFY_URL="${DEPLOY_VERIFY_URL:-https://omnizap.shop/}"
WEB_SURFACE_VERIFY_ENABLED="${DEPLOY_VERIFY_WEB_SECURITY_SURFACE:-1}"
WEB_SURFACE_VERIFY_BASE_URL="${DEPLOY_VERIFY_WEB_SECURITY_SURFACE_BASE_URL:-$VERIFY_URL}"
WEB_SURFACE_VERIFY_REPORT_PATH="${DEPLOY_VERIFY_WEB_SECURITY_SURFACE_REPORT_PATH:-$PROJECT_ROOT/temp/security-web-surface-report.json}"
DRY_RUN="${DEPLOY_DRY_RUN:-0}"
GITHUB_NOTIFY="${DEPLOY_GITHUB_NOTIFY:-1}"
GITHUB_ENVIRONMENT="${DEPLOY_GITHUB_ENVIRONMENT:-production}"
GITHUB_DEPLOYMENT_ID=""
PACKAGE_STEP="${DEPLOY_PACKAGE_STEP:-0}"
PACKAGE_INSTALL="${DEPLOY_PACKAGE_INSTALL:-1}"
PACKAGE_TEST="${DEPLOY_PACKAGE_TEST:-0}"
PACKAGE_PACK="${DEPLOY_PACKAGE_PACK:-0}"
PACKAGE_ARTIFACTS_DIR="${DEPLOY_PACKAGE_ARTIFACTS_DIR:-$PROJECT_ROOT/.artifacts}"
PACKAGE_PUBLISH="${DEPLOY_PACKAGE_PUBLISH:-0}"
PACKAGE_PUBLISH_SKIP_IF_EXISTS="${DEPLOY_PACKAGE_PUBLISH_SKIP_IF_EXISTS:-1}"
PACKAGE_REGISTRY="${DEPLOY_PACKAGE_REGISTRY:-https://npm.pkg.github.com}"
PACKAGE_TAG="${DEPLOY_PACKAGE_TAG:-latest}"
PACKAGE_TOKEN="${DEPLOY_PACKAGE_TOKEN:-}"
PACKAGE_OTP="${DEPLOY_PACKAGE_OTP:-}"
PACKAGE_PUBLISH_SECONDARY="${DEPLOY_PACKAGE_PUBLISH_SECONDARY:-0}"
PACKAGE_SECONDARY_REGISTRY="${DEPLOY_PACKAGE_SECONDARY_REGISTRY:-https://registry.npmjs.org}"
PACKAGE_SECONDARY_TAG="${DEPLOY_PACKAGE_SECONDARY_TAG:-latest}"
PACKAGE_SECONDARY_TOKEN="${DEPLOY_PACKAGE_SECONDARY_TOKEN:-}"
PACKAGE_SECONDARY_OTP="${DEPLOY_PACKAGE_SECONDARY_OTP:-}"
PACKAGE_SECONDARY_ACCESS="${DEPLOY_PACKAGE_SECONDARY_ACCESS:-public}"
PACKAGE_SECONDARY_PUBLISH_SKIP_IF_EXISTS="${DEPLOY_PACKAGE_SECONDARY_PUBLISH_SKIP_IF_EXISTS:-$PACKAGE_PUBLISH_SKIP_IF_EXISTS}"
PACKAGE_SECONDARY_TOKEN_KEYS="${DEPLOY_PACKAGE_SECONDARY_TOKEN_KEYS:-}"
ASSET_BUILD_ENABLED="${DEPLOY_BUILD_ASSETS:-1}"
ASSET_BUILD_CMD="${DEPLOY_BUILD_ASSETS_CMD:-npm run build:all}"
BACKEND_CACHE_BUST_ENABLED="${DEPLOY_BACKEND_CACHE_BUST_ENABLED:-1}"
BACKEND_BUILD_ID_ENV="${DEPLOY_BACKEND_BUILD_ID_ENV:-OMNIZAP_BUILD_ID}"
BACKEND_BUILD_ID_VALUE="${DEPLOY_BACKEND_BUILD_ID_VALUE:-$BUILD_ID}"
BACKEND_ASSET_VERSION_ENV="${DEPLOY_BACKEND_ASSET_VERSION_ENV:-STICKER_WEB_ASSET_VERSION}"
BACKEND_ASSET_VERSION_VALUE="${DEPLOY_BACKEND_ASSET_VERSION_VALUE:-$BUILD_ID}"
VERIFY_BUILD_OUTPUTS_ENABLED="${DEPLOY_VERIFY_BUILD_OUTPUTS:-1}"
VERIFY_CACHE_BUST_ENABLED="${DEPLOY_VERIFY_CACHE_BUST:-1}"
REQUIRE_CACHE_BUST_REFERENCES="${DEPLOY_REQUIRE_CACHE_BUST_REFERENCES:-1}"
VERIFY_POST_SYNC_CACHE_BUST_ENABLED="${DEPLOY_VERIFY_POST_SYNC_CACHE_BUST:-1}"
NPMRC_TMP_FILES=()

log() {
  printf '[deploy] %s\n' "$*"
}

is_valid_env_key() {
  [[ "$1" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]
}

resolve_github_repo() {
  local explicit_repo="${DEPLOY_GITHUB_REPO:-${GITHUB_REPOSITORY:-}}"
  if [ -n "$explicit_repo" ] && printf '%s' "$explicit_repo" | grep -q '/'; then
    printf '%s' "$explicit_repo"
    return 0
  fi

  local remote_url=""
  remote_url="$(cd "$PROJECT_ROOT" && git config --get remote.origin.url 2>/dev/null || true)"
  if [ -z "$remote_url" ]; then
    return 0
  fi

  local repo=""
  repo="$(printf '%s' "$remote_url" | sed -nE 's#.*github\.com[:/]([^/]+/[^/.]+)(\.git)?$#\1#p' | head -n 1)"
  if [ -n "$repo" ]; then
    printf '%s' "$repo"
  fi
}

resolve_github_owner() {
  local repo=""
  repo="$(resolve_github_repo)"
  if [ -z "$repo" ]; then
    return 0
  fi
  printf '%s' "$repo" | cut -d'/' -f1
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf '[deploy] comando ausente: %s\n' "$1" >&2
    exit 1
  fi
}

resolve_token_from_dotenv() {
  local token_keys="$1"
  if [ -z "$token_keys" ]; then
    return 0
  fi

  (
    cd "$PROJECT_ROOT" && TOKEN_KEYS="$token_keys" node --input-type=module -e "
      import dotenv from 'dotenv';
      dotenv.config({ path: '.env' });
      const keys = String(process.env.TOKEN_KEYS || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      for (const key of keys) {
        const value = process.env[key];
        if (value && String(value).trim()) {
          process.stdout.write(String(value).trim());
          process.exit(0);
        }
      }
    " 2>/dev/null || true
  )
}

default_token_keys_for_registry() {
  local registry="$1"
  if printf '%s' "$registry" | grep -q 'npm.pkg.github.com'; then
    printf 'DEPLOY_PACKAGE_TOKEN,DEPLOY_GITHUB_TOKEN,GITHUB_TOKEN,GH_TOKEN,NPM_TOKEN,NODE_AUTH_TOKEN'
  else
    printf 'DEPLOY_PACKAGE_SECONDARY_TOKEN,NPM_TOKEN,NODE_AUTH_TOKEN'
  fi
}

create_npmrc_for_registry() {
  local registry="$1"
  local token="$2"
  local scope_owner="$3"
  local registry_host=""
  registry_host="$(printf '%s' "$registry" | sed -E 's#^https?://##; s#/*$##')"

  local npmrc_tmp=""
  npmrc_tmp="$(mktemp /tmp/omnizap-npmrc.XXXXXX)"
  {
    printf 'registry=%s\n' "$registry"
    if [ -n "$scope_owner" ]; then
      printf '@%s:registry=%s\n' "$scope_owner" "$registry"
    fi
    printf '//%s/:_authToken=%s\n' "$registry_host" "$token"
    printf '//%s:_authToken=%s\n' "$registry_host" "$token"
  } > "$npmrc_tmp"
  chmod 600 "$npmrc_tmp"
  NPMRC_TMP_FILES+=("$npmrc_tmp")
  printf '%s' "$npmrc_tmp"
}

publish_package_to_registry() {
  local pkg_name="$1"
  local pkg_version="$2"
  local registry="$3"
  local tag="$4"
  local explicit_token="$5"
  local skip_if_exists="$6"
  local access="$7"
  local token_keys_override="$8"
  local otp="$9"

  local token="$explicit_token"
  if [ -z "$token" ]; then
    local token_keys="$token_keys_override"
    if [ -z "$token_keys" ]; then
      token_keys="$(default_token_keys_for_registry "$registry")"
    fi
    token="$(resolve_token_from_dotenv "$token_keys")"
  fi

  if [ -z "$token" ]; then
    printf '[deploy] Publish habilitado para %s, mas nenhum token foi encontrado.\n' "$registry" >&2
    exit 1
  fi

  if printf '%s' "$registry" | grep -q 'registry.npmjs.org'; then
    if printf '%s' "$token" | grep -Eq '^(ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)'; then
      printf '[deploy] Token incompatível para npmjs.org (parece token do GitHub).\n' >&2
      printf '[deploy] Configure DEPLOY_PACKAGE_SECONDARY_TOKEN ou NPM_TOKEN com token do npmjs.\n' >&2
      exit 1
    fi
  fi

  local scope_owner=""
  scope_owner="$(printf '%s' "$pkg_name" | sed -nE 's#^@([^/]+)/.*#\1#p')"
  local pkg_base_name=""
  pkg_base_name="$(printf '%s' "$pkg_name" | sed -E 's#^@[^/]+/##')"

  if printf '%s' "$registry" | grep -q 'npm.pkg.github.com'; then
    if ! printf '%s' "$pkg_name" | grep -q '^@'; then
      printf '[deploy] Para GitHub Packages o nome do pacote deve ser escopado (ex: @owner/repo).\n' >&2
      exit 1
    fi

    local expected_owner="${DEPLOY_PACKAGE_SCOPE_OWNER:-}"
    if [ -z "$expected_owner" ]; then
      expected_owner="$(resolve_github_owner)"
    fi

    local expected_owner_normalized=""
    local scope_owner_normalized=""
    expected_owner_normalized="$(printf '%s' "$expected_owner" | tr '[:upper:]' '[:lower:]')"
    scope_owner_normalized="$(printf '%s' "$scope_owner" | tr '[:upper:]' '[:lower:]')"

    if [ -n "$expected_owner" ] && [ -n "$scope_owner" ] && [ "$scope_owner_normalized" != "$expected_owner_normalized" ]; then
      printf '[deploy] Scope do pacote (%s) difere do owner GitHub esperado (%s).\n' "$scope_owner" "$expected_owner" >&2
      printf '[deploy] Ajuste com: npm pkg set name=\"@%s/%s\"\n' "$expected_owner" "$pkg_base_name" >&2
      printf '[deploy] Ou defina DEPLOY_PACKAGE_SCOPE_OWNER para publicar em outro owner.\n' >&2
      exit 1
    fi
  fi

  local npmrc_tmp=""
  npmrc_tmp="$(create_npmrc_for_registry "$registry" "$token" "$scope_owner")"

  if ! (
    cd "$PROJECT_ROOT" &&
    npm_config_userconfig="$npmrc_tmp" npm whoami --registry "$registry" --userconfig "$npmrc_tmp" >/dev/null 2>&1
  ); then
    printf '[deploy] Falha de autenticação no registry %s. Verifique token/permissões.\n' "$registry" >&2
    exit 1
  fi

  if [ "$skip_if_exists" = "1" ]; then
    if (
      cd "$PROJECT_ROOT" &&
      npm_config_userconfig="$npmrc_tmp" npm view "${pkg_name}@${pkg_version}" --registry "$registry" --userconfig "$npmrc_tmp" >/dev/null 2>&1
    ); then
      log "Pacote ${pkg_name}@${pkg_version} já publicado em $registry (skip)."
      return 0
    fi
  fi

  log "Publicando ${pkg_name}@${pkg_version} em $registry (tag=$tag)"
  local publish_cmd=(npm publish --registry "$registry" --tag "$tag" --userconfig "$npmrc_tmp")
  if [ -n "$access" ] && printf '%s' "$registry" | grep -q 'registry.npmjs.org' && printf '%s' "$pkg_name" | grep -q '^@'; then
    publish_cmd+=(--access "$access")
  fi
  if [ -n "$otp" ]; then
    publish_cmd+=(--otp "$otp")
  fi
  (
    cd "$PROJECT_ROOT" &&
    npm_config_userconfig="$npmrc_tmp" "${publish_cmd[@]}"
  )
  log "Publish concluído para ${pkg_name}@${pkg_version} em $registry."
}

as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
    return
  fi

  if command -v sudo >/dev/null 2>&1; then
    sudo "$@"
    return
  fi

  printf '[deploy] precisa de root/sudo para executar: %s\n' "$*" >&2
  exit 1
}

require_cmd node
require_cmd rsync
require_cmd nginx
require_cmd systemctl

if [ ! -d "$SOURCE_DIR" ]; then
  printf '[deploy] pasta de origem não encontrada: %s\n' "$SOURCE_DIR" >&2
  exit 1
fi

STAGING_DIR="$(mktemp -d /tmp/omnizap-deploy.XXXXXX)"
PM2_RESTART_ENV_ARGS=()

if [ "$BACKEND_CACHE_BUST_ENABLED" = "1" ]; then
  if ! is_valid_env_key "$BACKEND_BUILD_ID_ENV"; then
    printf '[deploy] nome inválido para DEPLOY_BACKEND_BUILD_ID_ENV: %s\n' "$BACKEND_BUILD_ID_ENV" >&2
    exit 1
  fi
  if ! is_valid_env_key "$BACKEND_ASSET_VERSION_ENV"; then
    printf '[deploy] nome inválido para DEPLOY_BACKEND_ASSET_VERSION_ENV: %s\n' "$BACKEND_ASSET_VERSION_ENV" >&2
    exit 1
  fi
  PM2_RESTART_ENV_ARGS+=("${BACKEND_BUILD_ID_ENV}=${BACKEND_BUILD_ID_VALUE}")
  PM2_RESTART_ENV_ARGS+=("${BACKEND_ASSET_VERSION_ENV}=${BACKEND_ASSET_VERSION_VALUE}")
fi

github_deploy_start() {
  if [ "$DRY_RUN" = "1" ] || [ "$GITHUB_NOTIFY" != "1" ]; then
    return 0
  fi

  local deployment_id=""
  deployment_id="$(
    node "$PROJECT_ROOT/scripts/github-deploy-notify.mjs" start \
      --build-id "$BUILD_ID" \
      --environment "$GITHUB_ENVIRONMENT" \
      --environment-url "$VERIFY_URL" \
      --log-url "$VERIFY_URL" 2>/dev/null || true
  )"
  deployment_id="$(printf '%s' "$deployment_id" | tr -d '[:space:]')"

  if [ -n "$deployment_id" ]; then
    GITHUB_DEPLOYMENT_ID="$deployment_id"
    log "GitHub deployment iniciado: id=$GITHUB_DEPLOYMENT_ID"
  else
    log "GitHub deployment não iniciado (token/repo ausente ou API indisponível)."
  fi
}

github_deploy_status() {
  local state="$1"
  if [ -z "$GITHUB_DEPLOYMENT_ID" ] || [ "$GITHUB_NOTIFY" != "1" ]; then
    return 0
  fi

  if node "$PROJECT_ROOT/scripts/github-deploy-notify.mjs" status \
    --deployment-id "$GITHUB_DEPLOYMENT_ID" \
    --state "$state" \
    --build-id "$BUILD_ID" \
    --environment "$GITHUB_ENVIRONMENT" \
    --environment-url "$VERIFY_URL" \
    --log-url "$VERIFY_URL" >/dev/null 2>&1; then
    log "GitHub deployment atualizado: id=$GITHUB_DEPLOYMENT_ID state=$state"
  else
    log "Aviso: falha ao atualizar status do deployment no GitHub (state=$state)."
  fi
}

run_package_stage() {
  if [ "$DRY_RUN" = "1" ] || [ "$PACKAGE_STEP" != "1" ]; then
    return 0
  fi

  require_cmd npm

  local pkg_version="n/d"
  pkg_version="$(cd "$PROJECT_ROOT" && npm pkg get version 2>/dev/null | tr -d '"[:space:]' || true)"
  log "Etapa package iniciada (versão=$pkg_version)."

  if [ "$PACKAGE_INSTALL" = "1" ]; then
    if [ -f "$PROJECT_ROOT/package-lock.json" ]; then
      log "Instalando dependências com npm ci --omit=dev"
      (cd "$PROJECT_ROOT" && npm ci --omit=dev)
    else
      printf '[deploy] package-lock.json ausente; npm install foi bloqueado por segurança.\n' >&2
      printf '[deploy] Gere/commite o lockfile e mantenha instalação reprodutível via npm ci.\n' >&2
      exit 1
    fi
  fi

  if [ "$PACKAGE_TEST" = "1" ]; then
    log "Executando testes de package (npm test)"
    (cd "$PROJECT_ROOT" && npm test)
  fi

  if [ "$PACKAGE_PACK" = "1" ]; then
    log "Gerando artefato npm pack"
    mkdir -p "$PACKAGE_ARTIFACTS_DIR"
    local pack_name=""
    pack_name="$(cd "$PROJECT_ROOT" && npm pack --silent | tail -n 1)"
    if [ -n "$pack_name" ] && [ -f "$PROJECT_ROOT/$pack_name" ]; then
      mv "$PROJECT_ROOT/$pack_name" "$PACKAGE_ARTIFACTS_DIR/$pack_name"
      log "Artefato salvo em $PACKAGE_ARTIFACTS_DIR/$pack_name"
    else
      log "Aviso: npm pack não retornou artefato válido para mover."
    fi
  fi

  if [ "$PACKAGE_PUBLISH" = "1" ] || [ "$PACKAGE_PUBLISH_SECONDARY" = "1" ]; then
    local pkg_name=""
    pkg_name="$(cd "$PROJECT_ROOT" && npm pkg get name 2>/dev/null | tr -d '"[:space:]' || true)"
    if [ -z "$pkg_name" ] || [ -z "$pkg_version" ] || [ "$pkg_version" = "n/d" ]; then
      printf '[deploy] não foi possível ler nome/versão do package para publish.\n' >&2
      exit 1
    fi

    if [ "$PACKAGE_PUBLISH" = "1" ]; then
      publish_package_to_registry \
        "$pkg_name" \
        "$pkg_version" \
        "$PACKAGE_REGISTRY" \
        "$PACKAGE_TAG" \
        "$PACKAGE_TOKEN" \
        "$PACKAGE_PUBLISH_SKIP_IF_EXISTS" \
        "" \
        "" \
        "$PACKAGE_OTP"
    fi

    if [ "$PACKAGE_PUBLISH_SECONDARY" = "1" ]; then
      if [ "$PACKAGE_PUBLISH" = "1" ] && [ "$PACKAGE_SECONDARY_REGISTRY" = "$PACKAGE_REGISTRY" ] && [ "$PACKAGE_SECONDARY_TAG" = "$PACKAGE_TAG" ]; then
        log "Registry/tag secundário igual ao primário. Publish secundário ignorado."
      else
        publish_package_to_registry \
          "$pkg_name" \
          "$pkg_version" \
          "$PACKAGE_SECONDARY_REGISTRY" \
          "$PACKAGE_SECONDARY_TAG" \
          "$PACKAGE_SECONDARY_TOKEN" \
          "$PACKAGE_SECONDARY_PUBLISH_SKIP_IF_EXISTS" \
          "$PACKAGE_SECONDARY_ACCESS" \
          "$PACKAGE_SECONDARY_TOKEN_KEYS" \
          "$PACKAGE_SECONDARY_OTP"
      fi
    fi
  fi

  log "Etapa package concluída."
}

run_assets_build_stage() {
  if [ "$ASSET_BUILD_ENABLED" != "1" ]; then
    log "Build de assets desativado (DEPLOY_BUILD_ASSETS=$ASSET_BUILD_ENABLED)."
    return 0
  fi

  require_cmd npm
  log "Compilando assets frontend: $ASSET_BUILD_CMD"
  (
    cd "$PROJECT_ROOT" &&
    bash -lc "$ASSET_BUILD_CMD"
  )
}

verify_build_outputs() {
  if [ "$VERIFY_BUILD_OUTPUTS_ENABLED" != "1" ]; then
    log "Validação de artefatos de build desativada (DEPLOY_VERIFY_BUILD_OUTPUTS=$VERIFY_BUILD_OUTPUTS_ENABLED)."
    return 0
  fi

  log "Validando artefatos obrigatórios de build em $SOURCE_DIR"
  (
    SOURCE_DIR="$SOURCE_DIR" node --input-type=module <<'NODE'
import fs from 'node:fs';
import path from 'node:path';

const sourceDir = process.env.SOURCE_DIR;
if (!sourceDir) {
  console.error('[deploy] SOURCE_DIR ausente para validação de build.');
  process.exit(1);
}

const requiredJsBundles = [
  'home-react.bundle.js',
  'user-react.bundle.js',
  'login-react.bundle.js',
  'terms-react.bundle.js',
  'api-docs.bundle.js',
  'stickers-react.bundle.js',
  'create-pack-react.bundle.js',
  'stickers-admin.bundle.js',
  'user-systemadm.bundle.js',
];
const requiredCssBundles = [
  'home-react.css',
  'user-react.css',
  'login-react.css',
  'terms-react.css',
  'api-docs.css',
  'stickers-react.css',
  'create-pack-react.css',
  'stickers-admin.css',
  'user-systemadm.css',
];

const missing = [];
const empty = [];
const inspectFile = (absolutePath, label) => {
  if (!fs.existsSync(absolutePath)) {
    missing.push(label);
    return;
  }
  const stats = fs.statSync(absolutePath);
  if (!stats.isFile() || stats.size <= 0) {
    empty.push(label);
  }
};

for (const file of requiredJsBundles) {
  inspectFile(path.join(sourceDir, 'assets', 'js', file), `assets/js/${file}`);
}
for (const file of requiredCssBundles) {
  inspectFile(path.join(sourceDir, 'assets', 'css', file), `assets/css/${file}`);
}

if (missing.length > 0) {
  console.error('[deploy] Artefatos ausentes após build:');
  for (const item of missing) {
    console.error(`[deploy] - ${item}`);
  }
  process.exit(1);
}

if (empty.length > 0) {
  console.error('[deploy] Artefatos vazios ou inválidos após build:');
  for (const item of empty) {
    console.error(`[deploy] - ${item}`);
  }
  process.exit(1);
}

let chunkCount = 0;
const chunksDir = path.join(sourceDir, 'assets', 'js', 'chunks');
if (fs.existsSync(chunksDir)) {
  const entries = fs.readdirSync(chunksDir, { withFileTypes: true });
  chunkCount = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.js')).length;
}

console.log(`[deploy] Artefatos de build OK. js=${requiredJsBundles.length} css=${requiredCssBundles.length} chunks=${chunkCount}`);
NODE
  )
}

verify_compiled_asset_refs() {
  local verify_assets="${DEPLOY_VERIFY_ASSETS:-1}"
  if [ "$verify_assets" != "1" ]; then
    log "Verificação de assets desativada (DEPLOY_VERIFY_ASSETS=$verify_assets)."
    return 0
  fi

  log "Validando referências de assets compilados em $SOURCE_DIR"
  (
    SOURCE_DIR="$SOURCE_DIR" node --input-type=module <<'NODE'
import fs from 'node:fs';
import path from 'node:path';

const sourceDir = process.env.SOURCE_DIR;
if (!sourceDir) {
  console.error('[deploy] SOURCE_DIR ausente para validação de assets.');
  process.exit(1);
}
if (!fs.existsSync(sourceDir)) {
  console.error(`[deploy] SOURCE_DIR inexistente: ${sourceDir}`);
  process.exit(1);
}

const htmlFiles = [];
const stack = [sourceDir];
while (stack.length > 0) {
  const current = stack.pop();
  const entries = fs.readdirSync(current, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      stack.push(fullPath);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.html')) {
      htmlFiles.push(fullPath);
    }
  }
}

const refRegex = /\b(?:src|href)=["'](\/assets\/(?:css|js)\/[^"'?#]+)(?:\?[^"']*)?["']/g;
const missing = [];

for (const filePath of htmlFiles) {
  const html = fs.readFileSync(filePath, 'utf8');
  let match = null;
  while ((match = refRegex.exec(html)) !== null) {
    const assetRef = match[1];
    const diskPath = path.join(sourceDir, assetRef.replace(/^\//, ''));
    if (!fs.existsSync(diskPath)) {
      missing.push({
        file: path.relative(sourceDir, filePath),
        asset: assetRef,
      });
    }
  }
}

if (missing.length > 0) {
  console.error('[deploy] Assets ausentes referenciados em HTML:');
  for (const item of missing) {
    console.error(`[deploy] - ${item.file} -> ${item.asset}`);
  }
  process.exit(1);
}

console.log('[deploy] Referências de assets compilados OK.');
NODE
  )
}

verify_cache_bust_refs() {
  local target_dir="$1"
  local label="${2:-cache-bust}"
  if [ "$VERIFY_CACHE_BUST_ENABLED" != "1" ]; then
    log "Verificação de cache-bust desativada (DEPLOY_VERIFY_CACHE_BUST=$VERIFY_CACHE_BUST_ENABLED)."
    return 0
  fi

  log "Validando cache-bust ($label) em $target_dir (v=$BUILD_ID)"
  (
    SOURCE_DIR="$target_dir" BUILD_ID="$BUILD_ID" REQUIRE_REFS="$REQUIRE_CACHE_BUST_REFERENCES" node --input-type=module <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { URLSearchParams } from 'node:url';

const sourceDir = process.env.SOURCE_DIR;
const buildId = String(process.env.BUILD_ID || '').trim();
const requireRefs = String(process.env.REQUIRE_REFS || '1') === '1';
if (!sourceDir || !buildId) {
  console.error('[deploy] SOURCE_DIR/BUILD_ID ausentes para validação de cache-bust.');
  process.exit(1);
}
if (!fs.existsSync(sourceDir)) {
  console.error(`[deploy] Diretório inexistente para validação de cache-bust: ${sourceDir}`);
  process.exit(1);
}

const targetExtensions = new Set(['.html', '.js', '.mjs', '.css']);
const assetPathPattern = /\.(?:js|mjs|cjs|css|png|jpe?g|gif|svg|webp|ico|json|map|woff2?|ttf|eot)(?:\?[^"'#\s)]*)?(?:#[^"' \s)]*)?$/i;
const sourcePatterns = [
  { regex: /\b(?:src|href|poster)=["']([^"']+)["']/gi, index: 1 },
  { regex: /(["'])((?:\/|\.{1,2}\/)[^"'\s]+)\1/gi, index: 2 },
  { regex: /url\(\s*["']?([^"')\s]+)["']?\s*\)/gi, index: 1 },
];
const urlSchemePattern = /^[a-zA-Z][a-zA-Z\d+.-]*:/;

const isLocalAssetPath = (assetPath) => {
  const value = String(assetPath || '').trim();
  if (!value) return false;
  if (value.startsWith('//') || value.startsWith('#') || urlSchemePattern.test(value)) return false;
  return value.startsWith('/') || value.startsWith('./') || value.startsWith('../');
};

const hasExpectedVersion = (assetPath) => {
  const [withoutHash] = String(assetPath || '').split('#', 1);
  const queryIndex = withoutHash.indexOf('?');
  if (queryIndex < 0) return false;
  const params = new URLSearchParams(withoutHash.slice(queryIndex + 1));
  return params.get('v') === buildId;
};

const listFiles = [];
const stack = [sourceDir];
while (stack.length > 0) {
  const current = stack.pop();
  const entries = fs.readdirSync(current, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      stack.push(absolute);
      continue;
    }
    if (!entry.isFile()) continue;
    if (targetExtensions.has(path.extname(absolute).toLowerCase())) {
      listFiles.push(absolute);
    }
  }
}

let totalRefs = 0;
let versionedRefs = 0;
const missingVersion = [];

for (const filePath of listFiles) {
  const source = fs.readFileSync(filePath, 'utf8');
  const relativeFile = path.relative(sourceDir, filePath);
  for (const { regex, index } of sourcePatterns) {
    regex.lastIndex = 0;
    let match = null;
    while ((match = regex.exec(source)) !== null) {
      const assetPath = String(match[index] || '').trim();
      if (!assetPathPattern.test(assetPath)) continue;
      if (!isLocalAssetPath(assetPath)) continue;
      totalRefs += 1;
      if (hasExpectedVersion(assetPath)) {
        versionedRefs += 1;
        continue;
      }
      if (missingVersion.length < 80) {
        missingVersion.push({ file: relativeFile, asset: assetPath });
      }
    }
  }
}

if (requireRefs && totalRefs === 0) {
  console.error('[deploy] Nenhuma referência local de asset encontrada para validar cache-bust.');
  process.exit(1);
}

if (missingVersion.length > 0) {
  console.error(`[deploy] Referências sem ?v=${buildId}:`);
  for (const item of missingVersion) {
    console.error(`[deploy] - ${item.file} -> ${item.asset}`);
  }
  process.exit(1);
}

console.log(`[deploy] Cache-bust validado. refs=${totalRefs} versioned=${versionedRefs} build_id=${buildId}`);
NODE
  )
}

prepare_legacy_static_entrypoints() {
  local target_dir="$1"
  local pages_dir="$target_dir/pages"
  if [ ! -d "$pages_dir" ]; then
    log "Pasta pages ausente em $target_dir; aliases legados nao serao gerados."
    return 0
  fi

  log "Gerando aliases estaticos legados em $target_dir"

  copy_page_alias() {
    local source_name="$1"
    local dest_relative="$2"
    local source_path="$pages_dir/$source_name"
    local dest_path="$target_dir/$dest_relative"

    if [ ! -f "$source_path" ]; then
      log "Aviso: template ausente para alias legado ($source_name)."
      return 0
    fi

    mkdir -p "$(dirname "$dest_path")"
    cp "$source_path" "$dest_path"
  }

  copy_page_alias "home.html" "index.html"
  copy_page_alias "api-docs.html" "api-docs/index.html"
  copy_page_alias "aup.html" "aup/index.html"
  copy_page_alias "comandos.html" "comandos/index.html"
  copy_page_alias "dpa.html" "dpa/index.html"
  copy_page_alias "licenca.html" "licenca/index.html"
  copy_page_alias "notice-and-takedown.html" "notice-and-takedown/index.html"
  copy_page_alias "politica-de-privacidade.html" "politica-de-privacidade/index.html"
  copy_page_alias "suboperadores.html" "suboperadores/index.html"
  copy_page_alias "termos-de-uso.html" "termos-de-uso/index.html"
  copy_page_alias "termos-de-uso-texto-integral.html" "termos-de-uso/texto-integral/index.html"
  copy_page_alias "termos-de-uso-texto-integral.html" "termos-de-uso/texto-integral.html"
  copy_page_alias "login.html" "login/index.html"
  copy_page_alias "user.html" "user/index.html"
  copy_page_alias "user-password-reset.html" "user/password-reset/index.html"
  copy_page_alias "user-systemadm.html" "user/systemadm/index.html"
  copy_page_alias "stickers.html" "stickers/index.html"
  copy_page_alias "stickers-admin.html" "stickers/admin/index.html"
  copy_page_alias "stickers-create.html" "stickers/create/index.html"

  for seo_template in "$pages_dir"/seo-*.html; do
    if [ ! -f "$seo_template" ]; then
      continue
    fi

    local seo_slug=""
    seo_slug="$(basename "$seo_template")"
    seo_slug="${seo_slug#seo-}"
    seo_slug="${seo_slug%.html}"
    if [ -z "$seo_slug" ]; then
      continue
    fi

    local seo_dest_dir="$target_dir/seo/$seo_slug"
    mkdir -p "$seo_dest_dir"
    cp "$seo_template" "$seo_dest_dir/index.html"
  done
}

verify_post_sync_cache_bust() {
  if [ "$VERIFY_POST_SYNC_CACHE_BUST_ENABLED" != "1" ]; then
    log "Verificação pós-sync de cache-bust desativada (DEPLOY_VERIFY_POST_SYNC_CACHE_BUST=$VERIFY_POST_SYNC_CACHE_BUST_ENABLED)."
    return 0
  fi

  log "Validando cache-bust em páginas-chave no diretório de deploy"
  local sample_files=(
    "pages/home.html"
    "pages/login.html"
    "pages/user.html"
    "pages/user-password-reset.html"
    "pages/termos-de-uso.html"
    "pages/stickers.html"
    "pages/stickers-create.html"
    "pages/stickers-admin.html"
    "pages/api-docs.html"
    "pages/user-systemadm.html"
  )
  local missing_samples=()

  for sample in "${sample_files[@]}"; do
    local absolute_path="$DEPLOY_DIR/$sample"
    if [ ! -f "$absolute_path" ]; then
      continue
    fi

    if command -v rg >/dev/null 2>&1; then
      if ! rg -q "/assets/(css|js)/[^\"']*\\?[^\"']*v=${BUILD_ID}" "$absolute_path"; then
        missing_samples+=("$sample")
      fi
    else
      if ! grep -Eq "/assets/(css|js)/[^\"']*\\?[^\"']*v=${BUILD_ID}" "$absolute_path"; then
        missing_samples+=("$sample")
      fi
    fi
  done

  if [ "${#missing_samples[@]}" -gt 0 ]; then
    printf '[deploy] páginas sem marker de cache-bust esperado (v=%s):\n' "$BUILD_ID" >&2
    for sample in "${missing_samples[@]}"; do
      printf '[deploy] - %s\n' "$sample" >&2
    done
    exit 1
  fi

  log "Cache-bust pós-sync validado nas páginas-chave."
}

finalize() {
  local exit_code=$?
  if [ "$exit_code" -eq 0 ]; then
    github_deploy_status "success"
  else
    github_deploy_status "failure"
  fi
  for npmrc_tmp in "${NPMRC_TMP_FILES[@]:-}"; do
    if [ -n "$npmrc_tmp" ] && [ -f "$npmrc_tmp" ]; then
      rm -f "$npmrc_tmp"
    fi
  done
  rm -rf "$STAGING_DIR"
}
trap finalize EXIT

log "build_id=$BUILD_ID"
if [ "$BACKEND_CACHE_BUST_ENABLED" = "1" ]; then
  log "Cache-bust backend ativo: ${BACKEND_BUILD_ID_ENV}=${BACKEND_BUILD_ID_VALUE} | ${BACKEND_ASSET_VERSION_ENV}=${BACKEND_ASSET_VERSION_VALUE}"
else
  log "Cache-bust backend desativado (DEPLOY_BACKEND_CACHE_BUST_ENABLED=$BACKEND_CACHE_BUST_ENABLED)."
fi
run_assets_build_stage
verify_build_outputs
verify_compiled_asset_refs
log "Preparando staging em $STAGING_DIR"
rsync -a --delete "$SOURCE_DIR"/ "$STAGING_DIR"/
log "Aplicando cache-bust de frontend (versão=$BUILD_ID)"
CACHE_BUST_OUTPUT="$(node "$PROJECT_ROOT/scripts/cache-bust.mjs" --dir "$STAGING_DIR" --version "$BUILD_ID")"
printf '%s\n' "$CACHE_BUST_OUTPUT"
if [ "$REQUIRE_CACHE_BUST_REFERENCES" = "1" ]; then
  CACHE_BUST_REFS="$(printf '%s' "$CACHE_BUST_OUTPUT" | sed -nE 's/.* refs=([0-9]+).*/\1/p' | tail -n 1)"
  if [ -z "$CACHE_BUST_REFS" ] || ! [[ "$CACHE_BUST_REFS" =~ ^[0-9]+$ ]]; then
    printf '[deploy] Não foi possível validar o total de refs do cache-bust.\n' >&2
    exit 1
  fi
  if [ "$CACHE_BUST_REFS" -le 0 ]; then
    printf '[deploy] Cache-bust não alterou nenhuma referência (refs=%s).\n' "$CACHE_BUST_REFS" >&2
    exit 1
  fi
fi
prepare_legacy_static_entrypoints "$STAGING_DIR"
verify_cache_bust_refs "$STAGING_DIR" "staging"

if [ "$BACKUP_ENABLED" = "1" ] && [ "$DRY_RUN" != "1" ] && [ -d "$DEPLOY_DIR" ]; then
  BACKUP_STAMP="$(date -u +%Y%m%d-%H%M%S)"
  BACKUP_PATH="$BACKUP_DIR/$BACKUP_STAMP"
  log "Criando backup em $BACKUP_PATH"
  as_root mkdir -p "$BACKUP_PATH"
  as_root rsync -a --delete --exclude '.backup/' "$DEPLOY_DIR"/ "$BACKUP_PATH"/
fi

if [ ! -d "$DEPLOY_DIR" ]; then
  log "Criando diretório de deploy $DEPLOY_DIR"
  as_root mkdir -p "$DEPLOY_DIR"
fi

if [ "$DRY_RUN" = "1" ]; then
  log "DRY_RUN=1 ativo. Simulando sync para $DEPLOY_DIR"
  as_root rsync -avhn --delete --exclude '.backup/' "$STAGING_DIR"/ "$DEPLOY_DIR"/
  log "Dry-run finalizado."
  exit 0
fi

github_deploy_start
run_package_stage

log "Sincronizando arquivos para $DEPLOY_DIR"
as_root rsync -a --delete --exclude '.backup/' "$STAGING_DIR"/ "$DEPLOY_DIR"/
verify_post_sync_cache_bust

log "Validando configuração do nginx"
as_root nginx -t

log "Recarregando serviço $NGINX_SERVICE"
as_root systemctl reload "$NGINX_SERVICE"
as_root systemctl is-active --quiet "$NGINX_SERVICE"

if [ "$RESTART_PM2" = "1" ] && command -v pm2 >/dev/null 2>&1; then
  if as_root pm2 describe "$PM2_APP_NAME" >/dev/null 2>&1; then
    log "Reiniciando PM2 app $PM2_APP_NAME"
    if [ "${#PM2_RESTART_ENV_ARGS[@]}" -gt 0 ]; then
      as_root env "${PM2_RESTART_ENV_ARGS[@]}" pm2 restart "$PM2_APP_NAME" --update-env >/dev/null
    else
      as_root pm2 restart "$PM2_APP_NAME" --update-env >/dev/null
    fi
  else
    log "PM2 app '$PM2_APP_NAME' não encontrada. Restart ignorado."
  fi
fi

if [ -f "$DEPLOY_DIR/pages/home.html" ]; then
  if command -v rg >/dev/null 2>&1; then
    DEPLOYED_REF="$(rg -o '/assets/js/home-react\\.bundle\\.js\\?v=[^"]+' "$DEPLOY_DIR/pages/home.html" -m 1 || true)"
  else
    DEPLOYED_REF="$(grep -oE '/assets/js/home-react\\.bundle\\.js\\?v=[^"]+' "$DEPLOY_DIR/pages/home.html" | head -n 1 || true)"
  fi
  if [ -n "$DEPLOYED_REF" ]; then
    log "Cache-bust aplicado: $DEPLOYED_REF"
  fi
fi

if command -v curl >/dev/null 2>&1; then
  if curl -kfsS "$VERIFY_URL" >/dev/null; then
    log "Health check OK em $VERIFY_URL"
  else
    log "Health check falhou em $VERIFY_URL (deploy concluído, verifique manualmente)."
  fi
fi

if [ "$WEB_SURFACE_VERIFY_ENABLED" = "1" ]; then
  log "Executando validacao web de seguranca em $WEB_SURFACE_VERIFY_BASE_URL"
  SECURITY_WEB_SURFACE_BASE_URL="$WEB_SURFACE_VERIFY_BASE_URL" \
  SECURITY_WEB_SURFACE_REPORT_PATH="$WEB_SURFACE_VERIFY_REPORT_PATH" \
  node "$PROJECT_ROOT/scripts/security-web-surface-check.mjs"
fi

log "Deploy concluído com sucesso."
