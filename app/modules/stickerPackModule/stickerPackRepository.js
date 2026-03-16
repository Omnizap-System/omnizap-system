import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import { executeQuery, TABLES } from '../../../database/index.js';
import { STICKER_DOMAIN_EVENTS } from './domainEvents.js';
import { publishStickerDomainEvent } from './stickerDomainEventBus.js';

const CATALOG_COMPLETE_PACK_TARGET = Math.max(1, Number(process.env.STICKER_PACK_MAX_ITEMS) || 30);

/**
 * Normaliza linha da tabela de packs para formato usado no domínio.
 *
 * @param {Record<string, unknown>|null|undefined} row Linha retornada da query.
 * @returns {object|null} Pack normalizado.
 */
const normalizeStickerPackRow = (row) => {
  if (!row) return null;

  return {
    id: row.id,
    owner_jid: row.owner_jid,
    name: row.name,
    publisher: row.publisher,
    description: row.description,
    pack_key: row.pack_key,
    cover_sticker_id: row.cover_sticker_id,
    visibility: row.visibility,
    status: row.status || 'published',
    pack_status: row.pack_status || 'ready',
    pack_theme_key: row.pack_theme_key || null,
    pack_volume: row.pack_volume !== null && row.pack_volume !== undefined ? Number(row.pack_volume) : null,
    is_auto_pack: row.is_auto_pack === 1 || row.is_auto_pack === true,
    last_rebalanced_at: row.last_rebalanced_at || null,
    version: Number(row.version || 1),
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
    sticker_count: row.sticker_count !== null && row.sticker_count !== undefined ? Number(row.sticker_count) : undefined,
  };
};

/**
 * Busca pack por ID.
 *
 * @param {string} packId ID interno do pack.
 * @param {{ includeDeleted?: boolean, connection?: import('mysql2/promise').PoolConnection|null }} [options]
 * @returns {Promise<object|null>} Pack encontrado.
 */
export async function findStickerPackById(packId, { includeDeleted = false, connection = null } = {}) {
  const rows = await executeQuery(
    `SELECT p.*,
      (SELECT COUNT(*) FROM ${TABLES.STICKER_PACK_ITEM} i WHERE i.pack_id = p.id) AS sticker_count
     FROM ${TABLES.STICKER_PACK} p
     WHERE p.id = ? ${includeDeleted ? '' : 'AND p.deleted_at IS NULL'}
     LIMIT 1`,
    [packId],
    connection,
  );

  return normalizeStickerPackRow(rows?.[0] || null);
}

/**
 * Busca pack por chave pública (pack_key).
 *
 * @param {string} packKey Chave pública do pack.
 * @param {{ includeDeleted?: boolean, connection?: import('mysql2/promise').PoolConnection|null }} [options]
 * @returns {Promise<object|null>} Pack encontrado.
 */
export async function findStickerPackByPackKey(packKey, { includeDeleted = false, connection = null } = {}) {
  const rows = await executeQuery(
    `SELECT p.*,
      (SELECT COUNT(*) FROM ${TABLES.STICKER_PACK_ITEM} i WHERE i.pack_id = p.id) AS sticker_count
     FROM ${TABLES.STICKER_PACK} p
     WHERE p.pack_key = ? ${includeDeleted ? '' : 'AND p.deleted_at IS NULL'}
     LIMIT 1`,
    [packKey],
    connection,
  );

  return normalizeStickerPackRow(rows?.[0] || null);
}

/**
 * Busca pack do dono por ID, pack_key ou nome.
 *
 * @param {string} ownerJid JID do dono.
 * @param {string} identifier ID, chave ou nome do pack.
 * @param {{ includeDeleted?: boolean, connection?: import('mysql2/promise').PoolConnection|null }} [options]
 * @returns {Promise<object|null>} Pack encontrado.
 */
export async function findStickerPackByOwnerAndIdentifier(ownerJid, identifier, { includeDeleted = false, connection = null } = {}) {
  if (!identifier) return null;

  const idOrPack = await executeQuery(
    `SELECT p.*,
      (SELECT COUNT(*) FROM ${TABLES.STICKER_PACK_ITEM} i WHERE i.pack_id = p.id) AS sticker_count
     FROM ${TABLES.STICKER_PACK} p
     WHERE p.owner_jid = ?
       ${includeDeleted ? '' : 'AND p.deleted_at IS NULL'}
       AND (p.id = ? OR p.pack_key = ?)
     ORDER BY p.updated_at DESC
     LIMIT 1`,
    [ownerJid, identifier, identifier],
    connection,
  );

  if (idOrPack?.[0]) {
    return normalizeStickerPackRow(idOrPack[0]);
  }

  const byName = await executeQuery(
    `SELECT p.*,
      (SELECT COUNT(*) FROM ${TABLES.STICKER_PACK_ITEM} i WHERE i.pack_id = p.id) AS sticker_count
     FROM ${TABLES.STICKER_PACK} p
     WHERE p.owner_jid = ?
       ${includeDeleted ? '' : 'AND p.deleted_at IS NULL'}
       AND LOWER(p.name) = LOWER(?)
     ORDER BY p.updated_at DESC
     LIMIT 1`,
    [ownerJid, identifier],
    connection,
  );

  return normalizeStickerPackRow(byName?.[0] || null);
}

/**
 * Lista packs de um usuário com paginação simples.
 *
 * @param {string} ownerJid JID do dono.
 * @param {{ includeDeleted?: boolean, limit?: number, offset?: number, connection?: import('mysql2/promise').PoolConnection|null }} [options]
 * @returns {Promise<object[]>} Lista de packs.
 */
export async function listStickerPacksByOwner(ownerJid, { includeDeleted = false, limit = 50, offset = 0, connection = null } = {}) {
  const safeLimit = Math.max(1, Number(limit) || 50);
  const safeOffset = Math.max(0, Number(offset) || 0);

  const rows = await executeQuery(
    `SELECT p.*,
      (SELECT COUNT(*) FROM ${TABLES.STICKER_PACK_ITEM} i WHERE i.pack_id = p.id) AS sticker_count
     FROM ${TABLES.STICKER_PACK} p
     WHERE p.owner_jid = ? ${includeDeleted ? '' : 'AND p.deleted_at IS NULL'}
     ORDER BY p.updated_at DESC
     LIMIT ${safeLimit} OFFSET ${safeOffset}`,
    [ownerJid],
    connection,
  );

  return rows.map((row) => normalizeStickerPackRow(row));
}

/**
 * Lista packs automáticos de curadoria para um conjunto de owners.
 *
 * @param {{
 *   ownerJids?: string[],
 *   includeArchived?: boolean,
 *   themeKey?: string,
 *   limit?: number,
 *   offset?: number,
 *   connection?: import('mysql2/promise').PoolConnection|null,
 * }} [options]
 * @returns {Promise<object[]>}
 */
export async function listStickerAutoPacksForCuration({ ownerJids = [], includeArchived = true, themeKey = '', includeLegacyMarkers = true, limit = 2000, offset = 0, connection = null } = {}) {
  const owners = Array.from(new Set((Array.isArray(ownerJids) ? ownerJids : []).filter(Boolean)));
  if (!owners.length) return [];

  const safeLimit = Math.max(1, Math.min(5000, Number(limit) || 2000));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const ownerPlaceholders = owners.map(() => '?').join(', ');

  const whereClauses = ['p.deleted_at IS NULL', `p.owner_jid IN (${ownerPlaceholders})`];
  const params = [...owners];

  if (includeLegacyMarkers) {
    whereClauses.push("(p.is_auto_pack = 1 OR p.description LIKE '%[auto-theme:%' OR p.description LIKE '%[auto-tag:%')");
  } else {
    whereClauses.push('p.is_auto_pack = 1');
  }

  const normalizedThemeKey = String(themeKey || '')
    .trim()
    .toLowerCase();
  if (normalizedThemeKey) {
    whereClauses.push("LOWER(COALESCE(p.pack_theme_key, '')) = ?");
    params.push(normalizedThemeKey);
  }

  if (!includeArchived) {
    whereClauses.push("COALESCE(p.pack_status, 'ready') <> 'archived'");
  }

  const rows = await executeQuery(
    `SELECT p.*,
      (SELECT COUNT(*) FROM ${TABLES.STICKER_PACK_ITEM} i WHERE i.pack_id = p.id) AS sticker_count
     FROM ${TABLES.STICKER_PACK} p
     WHERE ${whereClauses.join(' AND ')}
     ORDER BY
       COALESCE(p.pack_theme_key, '') ASC,
       COALESCE(p.pack_volume, 0) ASC,
       p.updated_at DESC
     LIMIT ${safeLimit} OFFSET ${safeOffset}`,
    params,
    connection,
  );

  return rows.map((row) => normalizeStickerPackRow(row));
}

/**
 * Lista packs públicos para catálogo web com busca e paginação.
 *
 * @param {{
 *   visibility?: 'public'|'unlisted'|'all',
 *   search?: string,
 *   limit?: number,
 *   offset?: number,
 *   connection?: import('mysql2/promise').PoolConnection|null,
 * }} [options] Filtros de listagem.
 * @returns {Promise<{ packs: object[], hasMore: boolean }>} Resultado paginado.
 */
export async function listStickerPacksForCatalog({ visibility = 'public', search = '', limit = 24, offset = 0, connection = null } = {}) {
  const safeLimit = Math.max(1, Math.min(60, Number(limit) || 24));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const safeLimitWithSentinel = safeLimit + 1;

  const normalizedVisibility = String(visibility || 'public')
    .trim()
    .toLowerCase();
  const visibilityValues = normalizedVisibility === 'all' ? ['public', 'unlisted'] : normalizedVisibility === 'unlisted' ? ['unlisted'] : ['public'];

  const normalizedSearch = String(search || '')
    .trim()
    .toLowerCase()
    .slice(0, 120);
  const params = [...visibilityValues];
  const whereClauses = ['p.deleted_at IS NULL', "p.status = 'published'", "COALESCE(p.pack_status, 'ready') = 'ready'", `p.visibility IN (${visibilityValues.map(() => '?').join(', ')})`];

  if (normalizedSearch) {
    const like = `%${normalizedSearch}%`;
    whereClauses.push("(LOWER(p.name) LIKE ? OR LOWER(p.publisher) LIKE ? OR LOWER(COALESCE(p.description, '')) LIKE ? OR LOWER(p.pack_key) LIKE ?)");
    params.push(like, like, like, like);
  }

  const rows = await executeQuery(
    `SELECT p.*,
      (SELECT COUNT(*) FROM ${TABLES.STICKER_PACK_ITEM} i WHERE i.pack_id = p.id) AS sticker_count
     FROM ${TABLES.STICKER_PACK} p
     WHERE ${whereClauses.join(' AND ')}
     ORDER BY
       (sticker_count >= ${CATALOG_COMPLETE_PACK_TARGET}) DESC,
       sticker_count DESC,
       p.updated_at DESC
     LIMIT ${safeLimitWithSentinel} OFFSET ${safeOffset}`,
    params,
    connection,
  );

  const hasMore = rows.length > safeLimit;
  return {
    packs: rows.slice(0, safeLimit).map((row) => normalizeStickerPackRow(row)),
    hasMore,
  };
}

/**
 * Cria um registro de pack.
 *
 * @param {object} pack Dados do pack.
 * @param {import('mysql2/promise').PoolConnection|null} [connection=null] Conexão transacional opcional.
 * @returns {Promise<object|null>} Pack criado.
 */
export async function createStickerPack(pack, connection = null) {
  await executeQuery(
    `INSERT INTO ${TABLES.STICKER_PACK}
      (
        id,
        owner_jid,
        name,
        publisher,
        description,
        pack_key,
        cover_sticker_id,
        visibility,
        status,
        pack_status,
        pack_theme_key,
        pack_volume,
        is_auto_pack,
        last_rebalanced_at,
        version
      )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [pack.id, pack.owner_jid, pack.name, pack.publisher, pack.description ?? null, pack.pack_key, pack.cover_sticker_id ?? null, pack.visibility, pack.status ?? 'published', pack.pack_status ?? 'ready', pack.pack_theme_key ?? null, pack.pack_volume ?? null, pack.is_auto_pack ? 1 : 0, pack.last_rebalanced_at ?? null, pack.version ?? 1],
    connection,
  );

  await publishStickerDomainEvent(
    {
      eventType: STICKER_DOMAIN_EVENTS.PACK_UPDATED,
      aggregateType: 'sticker_pack',
      aggregateId: pack.id,
      payload: {
        action: 'created',
        pack_id: pack.id,
        pack_key: pack.pack_key,
        owner_jid: pack.owner_jid,
        visibility: pack.visibility,
      },
      priority: 75,
      idempotencyKey: `pack_created:${pack.id}`,
    },
    { connection },
  );

  return findStickerPackById(pack.id, { includeDeleted: true, connection });
}

const UPDATE_FIELD_MAP = {
  name: 'name',
  publisher: 'publisher',
  description: 'description',
  pack_key: 'pack_key',
  cover_sticker_id: 'cover_sticker_id',
  visibility: 'visibility',
  status: 'status',
  pack_status: 'pack_status',
  pack_theme_key: 'pack_theme_key',
  pack_volume: 'pack_volume',
  is_auto_pack: 'is_auto_pack',
  last_rebalanced_at: 'last_rebalanced_at',
  deleted_at: 'deleted_at',
};

/**
 * Atualiza campos permitidos de um pack.
 *
 * @param {string} packId ID do pack.
 * @param {Record<string, unknown>} fields Campos para atualização.
 * @param {import('mysql2/promise').PoolConnection|null} [connection=null] Conexão transacional opcional.
 * @returns {Promise<object|null>} Pack atualizado.
 */
export async function updateStickerPackFields(packId, fields, connection = null) {
  const setClauses = [];
  const params = [];

  for (const [field, column] of Object.entries(UPDATE_FIELD_MAP)) {
    if (!(field in fields)) continue;
    setClauses.push(`${column} = ?`);
    params.push(fields[field]);
  }

  if (!setClauses.length) {
    return findStickerPackById(packId, { includeDeleted: true, connection });
  }

  setClauses.push('version = version + 1');
  setClauses.push('updated_at = CURRENT_TIMESTAMP');

  await executeQuery(
    `UPDATE ${TABLES.STICKER_PACK}
     SET ${setClauses.join(', ')}
     WHERE id = ?`,
    [...params, packId],
    connection,
  );

  await publishStickerDomainEvent(
    {
      eventType: STICKER_DOMAIN_EVENTS.PACK_UPDATED,
      aggregateType: 'sticker_pack',
      aggregateId: packId,
      payload: {
        action: 'updated',
        pack_id: packId,
        fields: Object.keys(fields || {}).slice(0, 30),
      },
      priority: 70,
      idempotencyKey: `pack_updated:${packId}:${Object.keys(fields || {})
        .sort()
        .join(',')}`,
    },
    { connection },
  );

  return findStickerPackById(packId, { includeDeleted: true, connection });
}

/**
 * Marca um pack como deletado sem remover dados físicos.
 *
 * @param {string} packId ID do pack.
 * @param {import('mysql2/promise').PoolConnection|null} [connection=null] Conexão transacional opcional.
 * @returns {Promise<object|null>} Pack atualizado.
 */
export async function softDeleteStickerPack(packId, connection = null) {
  return updateStickerPackFields(
    packId,
    {
      deleted_at: __timeNow(),
    },
    connection,
  );
}

/**
 * Verifica se a chave pública (pack_key) está disponível.
 *
 * @param {string} packKey Chave candidata.
 * @param {import('mysql2/promise').PoolConnection|null} [connection=null] Conexão transacional opcional.
 * @returns {Promise<boolean>} `true` quando não existe pack com essa chave.
 */
export async function ensureUniquePackKey(packKey, connection = null) {
  const existing = await findStickerPackByPackKey(packKey, { includeDeleted: true, connection });
  return !existing;
}

/**
 * Incrementa versão e timestamp de atualização do pack.
 *
 * @param {string} packId ID do pack.
 * @param {import('mysql2/promise').PoolConnection|null} [connection=null] Conexão transacional opcional.
 * @returns {Promise<object|null>} Pack atualizado.
 */
export async function bumpStickerPackVersion(packId, connection = null) {
  await executeQuery(
    `UPDATE ${TABLES.STICKER_PACK}
     SET version = version + 1,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [packId],
    connection,
  );

  await publishStickerDomainEvent(
    {
      eventType: STICKER_DOMAIN_EVENTS.PACK_UPDATED,
      aggregateType: 'sticker_pack',
      aggregateId: packId,
      payload: {
        action: 'version_bumped',
        pack_id: packId,
      },
      priority: 65,
      idempotencyKey: `pack_version_bumped:${packId}`,
    },
    { connection },
  );

  return findStickerPackById(packId, { includeDeleted: true, connection });
}
