import { initAuthCreds, makeCacheableSignalKeyStore, proto } from '@whiskeysockets/baileys';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { baileysAuthLogger as logger } from '../config/index.js';
import { TABLES, executeQuery, pool } from '../../database/index.js';

const AUTH_TABLE = TABLES.BAILEYS_AUTH_STATE;
const CREDS_CATEGORY = 'creds';
const CREDS_ITEM_ID = 'default';
const AUTH_FILE_EXTENSION = '.json';
const KNOWN_SIGNAL_KEY_TYPES = ['pre-key', 'session', 'sender-key', 'sender-key-memory', 'app-state-sync-key', 'app-state-sync-version', 'lid-mapping', 'device-list', 'tctoken'];
const KNOWN_SIGNAL_KEY_TYPES_SORTED = [...KNOWN_SIGNAL_KEY_TYPES].sort((left, right) => right.length - left.length);
const parseEnvBool = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
};
const BAILEYS_AUTH_KEYS_CACHE_ENABLED = parseEnvBool(process.env.BAILEYS_AUTH_KEYS_CACHE_ENABLED, true);

let ensureTablePromise = null;

const BufferJSON = {
  replacer: (_, value) => {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array || value?.type === 'Buffer') {
      return { type: 'Buffer', data: Buffer.from(value?.data || value).toString('base64') };
    }
    return value;
  },
  reviver: (_, value) => {
    if (typeof value === 'object' && value !== null && value.type === 'Buffer' && typeof value.data === 'string') {
      return Buffer.from(value.data, 'base64');
    }
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const keys = Object.keys(value);
      if (keys.length > 0 && keys.every((key) => !Number.isNaN(Number.parseInt(key, 10)))) {
        const values = Object.values(value);
        if (values.every((entry) => typeof entry === 'number')) {
          return Buffer.from(values);
        }
      }
    }
    return value;
  },
};

const buildInClause = (count) => new Array(count).fill('?').join(', ');

const normalizeSessionId = (sessionId) => {
  const normalized = String(sessionId || '').trim();
  return normalized || 'default';
};

const normalizeStorageId = (value) =>
  String(value || '')
    .replace(/\//g, '__')
    .replace(/:/g, '-');

const toJsonPayload = (value) => JSON.stringify(value, BufferJSON.replacer);

const parseJsonPayload = (rawPayload) => {
  if (rawPayload === null || rawPayload === undefined) return null;
  try {
    return JSON.parse(String(rawPayload), BufferJSON.reviver);
  } catch (error) {
    logger.warn('Falha ao interpretar payload do auth state no banco.', {
      table: AUTH_TABLE,
      errorMessage: error?.message,
    });
    return null;
  }
};

const ensureAuthStateTable = async () => {
  if (ensureTablePromise) {
    return ensureTablePromise;
  }

  ensureTablePromise = (async () => {
    try {
      await executeQuery(`
        CREATE TABLE IF NOT EXISTS \`${AUTH_TABLE}\` (
          \`session_id\` varchar(64) NOT NULL,
          \`category\` varchar(64) NOT NULL,
          \`item_id\` varchar(191) NOT NULL,
          \`payload\` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(\`payload\`)),
          \`created_at\` timestamp NOT NULL DEFAULT current_timestamp(),
          \`updated_at\` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
          PRIMARY KEY (\`session_id\`, \`category\`, \`item_id\`),
          KEY \`idx_baileys_auth_state_category_updated\` (\`category\`, \`updated_at\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);
    } catch (error) {
      try {
        await executeQuery(`SELECT 1 FROM \`${AUTH_TABLE}\` LIMIT 1`);
      } catch {
        throw error;
      }
    }
  })().catch((error) => {
    ensureTablePromise = null;
    throw error;
  });

  return ensureTablePromise;
};

const hasSessionData = async (sessionId) => {
  const rows = await executeQuery(`SELECT 1 FROM \`${AUTH_TABLE}\` WHERE session_id = ? LIMIT 1`, [sessionId]);
  return Array.isArray(rows) && rows.length > 0;
};

const upsertAuthRow = async (sessionId, category, itemId, value, connection = null) => {
  const payload = toJsonPayload(value);
  await executeQuery(
    `
      INSERT INTO \`${AUTH_TABLE}\` (session_id, category, item_id, payload)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE payload = VALUES(payload), updated_at = current_timestamp()
    `,
    [sessionId, category, itemId, payload],
    connection,
  );
};

const deleteAuthRow = async (sessionId, category, itemId, connection = null) => {
  await executeQuery(`DELETE FROM \`${AUTH_TABLE}\` WHERE session_id = ? AND category = ? AND item_id = ?`, [sessionId, category, itemId], connection);
};

const readCredsFromDb = async (sessionId) => {
  const rows = await executeQuery(`SELECT payload FROM \`${AUTH_TABLE}\` WHERE session_id = ? AND category = ? AND item_id = ? LIMIT 1`, [sessionId, CREDS_CATEGORY, CREDS_ITEM_ID]);
  const payload = rows?.[0]?.payload;
  const parsed = parseJsonPayload(payload);
  return parsed || null;
};

const parseAuthFileMetadata = (fileName) => {
  if (!fileName || typeof fileName !== 'string' || !fileName.endsWith(AUTH_FILE_EXTENSION)) {
    return null;
  }

  const stem = fileName.slice(0, -AUTH_FILE_EXTENSION.length);
  if (stem === 'creds') {
    return {
      category: CREDS_CATEGORY,
      itemId: CREDS_ITEM_ID,
    };
  }

  for (const type of KNOWN_SIGNAL_KEY_TYPES_SORTED) {
    const prefix = `${type}-`;
    if (stem.startsWith(prefix)) {
      const itemId = stem.slice(prefix.length);
      if (!itemId) return null;
      return {
        category: type,
        itemId,
      };
    }
  }

  return null;
};

const migrateSessionFromFiles = async (sessionId, bootstrapFromDir) => {
  if (!bootstrapFromDir) return false;

  const existsInDb = await hasSessionData(sessionId);
  if (existsInDb) return false;

  let directoryEntries = [];
  try {
    directoryEntries = await readdir(bootstrapFromDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }

  const candidateFiles = directoryEntries.filter((entry) => entry.isFile() && entry.name.endsWith(AUTH_FILE_EXTENSION));
  if (!candidateFiles.length) return false;

  const connection = await pool.getConnection();
  let importedRows = 0;
  let skippedRows = 0;

  try {
    await connection.beginTransaction();
    for (const fileEntry of candidateFiles) {
      const meta = parseAuthFileMetadata(fileEntry.name);
      if (!meta) {
        skippedRows += 1;
        continue;
      }

      const filePath = path.join(bootstrapFromDir, fileEntry.name);
      let payload = null;
      try {
        const raw = await readFile(filePath, 'utf8');
        payload = JSON.parse(raw, BufferJSON.reviver);
      } catch (error) {
        skippedRows += 1;
        logger.warn('Falha ao migrar arquivo de auth para MySQL.', {
          filePath,
          errorMessage: error?.message,
        });
        continue;
      }

      if (payload === null || payload === undefined) {
        await deleteAuthRow(sessionId, meta.category, meta.itemId, connection);
        continue;
      }

      await upsertAuthRow(sessionId, meta.category, meta.itemId, payload, connection);
      importedRows += 1;
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  if (importedRows > 0) {
    logger.info('Auth state do Baileys migrado do disco para MySQL.', {
      action: 'baileys_auth_db_migration',
      sessionId,
      importedRows,
      skippedRows,
      bootstrapFromDir,
      table: AUTH_TABLE,
    });
  }

  return importedRows > 0;
};

const createDbSignalKeyStore = (sessionId) => ({
  /**
   * @param {string} type
   * @param {string[]} ids
   * @returns {Promise<Record<string, any>>}
   */
  async get(type, ids) {
    if (!Array.isArray(ids) || ids.length === 0) {
      return {};
    }

    const normalizedIds = ids.map((id) => String(id));
    const storageIds = normalizedIds.map((id) => normalizeStorageId(id));
    const storageIdToRaw = new Map(storageIds.map((storageId, index) => [storageId, normalizedIds[index]]));

    const rows = await executeQuery(`SELECT item_id, payload FROM \`${AUTH_TABLE}\` WHERE session_id = ? AND category = ? AND item_id IN (${buildInClause(storageIds.length)})`, [sessionId, type, ...storageIds]);

    const data = {};
    for (const row of rows || []) {
      const rawId = storageIdToRaw.get(String(row?.item_id || ''));
      if (!rawId) continue;

      let value = parseJsonPayload(row?.payload);
      if (type === 'app-state-sync-key' && value) {
        value = proto.Message.AppStateSyncKeyData.fromObject(value);
      }

      if (value !== null && value !== undefined) {
        data[rawId] = value;
      }
    }

    return data;
  },
  /**
   * @param {Record<string, Record<string, any>>} data
   * @returns {Promise<void>}
   */
  async set(data) {
    if (!data || typeof data !== 'object') return;

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      for (const category of Object.keys(data)) {
        const categoryEntries = data[category];
        if (!categoryEntries || typeof categoryEntries !== 'object') continue;

        for (const id of Object.keys(categoryEntries)) {
          const value = categoryEntries[id];
          const itemId = normalizeStorageId(id);
          if (value) {
            await upsertAuthRow(sessionId, category, itemId, value, connection);
          } else {
            await deleteAuthRow(sessionId, category, itemId, connection);
          }
        }
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },
});

/**
 * Cria um AuthenticationState compatível com o Baileys usando MySQL.
 *
 * @param {{
 *   sessionId?: string,
 *   bootstrapFromDir?: string|null,
 *   bootstrapFromFiles?: boolean
 * }} [options]
 * @returns {Promise<{state: import('@whiskeysockets/baileys').AuthenticationState, saveCreds: () => Promise<void>}>}
 */
export async function useDbAuthState(options = {}) {
  const sessionId = normalizeSessionId(options.sessionId);
  const bootstrapFromDir = typeof options.bootstrapFromDir === 'string' ? options.bootstrapFromDir : null;
  const bootstrapFromFiles = options.bootstrapFromFiles !== false;

  await ensureAuthStateTable();

  if (bootstrapFromFiles) {
    try {
      await migrateSessionFromFiles(sessionId, bootstrapFromDir);
    } catch (error) {
      logger.warn('Falha ao executar bootstrap de auth state do Baileys para MySQL.', {
        action: 'baileys_auth_db_bootstrap_error',
        sessionId,
        bootstrapFromDir,
        errorMessage: error?.message,
      });
    }
  }

  const creds = (await readCredsFromDb(sessionId)) || initAuthCreds();
  const keyStore = createDbSignalKeyStore(sessionId);
  const wrappedKeyStore = BAILEYS_AUTH_KEYS_CACHE_ENABLED ? makeCacheableSignalKeyStore(keyStore, logger) : keyStore;

  return {
    state: {
      creds,
      keys: wrappedKeyStore,
    },
    saveCreds: async () => {
      await upsertAuthRow(sessionId, CREDS_CATEGORY, CREDS_ITEM_ID, creds);
    },
  };
}
