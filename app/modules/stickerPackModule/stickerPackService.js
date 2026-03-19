import { randomBytes, randomUUID } from 'node:crypto';

import logger from '#logger';
import { STICKER_PACK_ERROR_CODES, StickerPackError } from './stickerPackErrors.js';
import { getPackClassificationSummaryByAssetIds } from './stickerClassificationService.js';
import { normalizeOwnerJid, parseEmojiList, sanitizeText, slugify, toVisibility } from './stickerPackUtils.js';

/**
 * Serviço de domínio para operações de packs e itens de figurinha.
 */
const MAX_NAME_LENGTH = 120;
const MAX_PUBLISHER_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_ACCESSIBILITY_LABEL_LENGTH = 255;
const DEFAULT_MAX_STICKERS_PER_PACK = Math.max(1, Number(process.env.STICKER_PACK_MAX_ITEMS) || 30);
const parseMaxPacksPerOwnerLimit = (value, fallback = 50) => {
  if (value === undefined || value === null || value === '') {
    return Math.max(1, Number(fallback) || 50);
  }

  const normalized = String(value).trim().toLowerCase();
  if (['0', '-1', 'inf', 'infinity', 'unlimited', 'sem-limite'].includes(normalized)) {
    return Number.POSITIVE_INFINITY;
  }

  const parsed = Number(normalized);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.max(1, Math.floor(parsed));
  }

  return Math.max(1, Number(fallback) || 50);
};
const DEFAULT_MAX_PACKS_PER_OWNER = parseMaxPacksPerOwnerLimit(process.env.STICKER_PACK_MAX_PACKS_PER_OWNER, 50);
const PACK_KEY_BASE_MAX_LENGTH = 32;
const PACK_KEY_SUFFIX_LENGTH = 5;
const PACK_KEY_SUFFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const PACK_KEY_MAX_ATTEMPTS = 24;
const PACK_STATUS_VALUES = new Set(['draft', 'uploading', 'processing', 'published', 'failed']);

/**
 * @typedef {{
 *   createPack: Function,
 *   listPacks: Function,
 *   getPackInfo: Function,
 *   getPackInfoForSend: Function,
 *   renamePack: Function,
 *   setPackPublisher: Function,
 *   setPackDescription: Function,
 *   setPackVisibility: Function,
 *   setPackCover: Function,
 *   addStickerToPack: Function,
 *   removeStickerFromPack: Function,
 *   reorderPackItems: Function,
 *   clonePack: Function,
 *   deletePack: Function,
 * }} StickerPackService
 */

const defaultDependencies = {
  logger,
  packRepository: {},
  itemRepository: {},
};

const buildError = (code, message, details = null) => new StickerPackError(code, message, details);

const ensureValue = (condition, code, message, details = null) => {
  if (!condition) {
    throw buildError(code, message, details);
  }
};

const normalizePackIdentifier = (identifier) => sanitizeText(identifier, 180, { allowEmpty: false });

const normalizeCandidate = (value) => {
  const raw = String(value || '')
    .trim()
    // Remove pontuações de cauda comuns quando o usuário cola links/comandos.
    .replace(/[)\],;.!?]+$/g, '');
  return normalizePackIdentifier(raw);
};

const extractPackKeyFromValue = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';

  try {
    const url = new URL(raw, 'https://omnizap.shop');
    const parts = String(url.pathname || '')
      .split('/')
      .map((part) => part.trim())
      .filter(Boolean);

    if (parts[0] && parts[0].toLowerCase() === 'stickers' && parts[1]) {
      return normalizeCandidate(decodeURIComponent(parts[1]));
    }
  } catch {
    // Ignora parse de URL inválida e segue para regex.
  }

  const pathMatch = raw.match(/\/stickers\/([^/?#\s]+)/i);
  if (pathMatch?.[1]) {
    return normalizeCandidate(pathMatch[1]);
  }

  return '';
};

const buildIdentifierCandidates = (identifier) => {
  const set = new Set();
  const normalized = normalizeCandidate(identifier);
  if (normalized) set.add(normalized);

  const fromPath = extractPackKeyFromValue(identifier);
  if (fromPath) set.add(fromPath);

  for (const current of Array.from(set)) {
    set.add(current.toLowerCase());
    set.add(current.replace(/_/g, '-'));
    set.add(current.replace(/-/g, '_'));
  }

  return Array.from(set).filter(Boolean);
};

const isShareableVisibility = (visibility) => ['public', 'unlisted'].includes(String(visibility || '').toLowerCase());

const areArraysEqual = (left, right) => {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
};

/**
 * Executa callback em transação SQL.
 *
 * @param {(connection: import('mysql2/promise').PoolConnection) => Promise<unknown>} handler Função transacional.
 * @returns {Promise<unknown>} Resultado do callback.
 */
async function withTransaction(handler) {
  const { pool } = await import('../../../database/index.js');
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await handler(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Cria instância do serviço de sticker pack com dependências injetáveis.
 *
 * @param {{
 *   logger?: { info?: Function, error?: Function },
 *   packRepository?: Record<string, Function>,
 *   itemRepository?: Record<string, Function>,
 *   maxStickersPerPack?: number,
 *   maxPacksPerOwner?: number,
 *   runInTransaction?: Function,
 * }} [options] Configurações e dependências de runtime.
 * @returns {StickerPackService} API de domínio para packs.
 */
export function createStickerPackService(options = {}) {
  const deps = {
    ...defaultDependencies,
    ...options,
    packRepository: {
      ...defaultDependencies.packRepository,
      ...(options.packRepository || {}),
    },
    itemRepository: {
      ...defaultDependencies.itemRepository,
      ...(options.itemRepository || {}),
    },
  };

  const maxStickersPerPack = Math.max(1, Number(options.maxStickersPerPack) || DEFAULT_MAX_STICKERS_PER_PACK);
  const maxPacksPerOwner = parseMaxPacksPerOwnerLimit(options.maxPacksPerOwner, DEFAULT_MAX_PACKS_PER_OWNER);
  const hasOwnerPackLimit = Number.isFinite(maxPacksPerOwner);
  const runInTransaction = options.runInTransaction || withTransaction;

  const requiredPackMethods = ['createStickerPack', 'listStickerPacksByOwner', 'findStickerPackByOwnerAndIdentifier', 'findStickerPackByPackKey', 'updateStickerPackFields', 'softDeleteStickerPack', 'ensureUniquePackKey', 'bumpStickerPackVersion'];

  const requiredItemMethods = ['listStickerPackItems', 'countStickerPackItems', 'getMaxStickerPackPosition', 'createStickerPackItem', 'getStickerPackItemByStickerId', 'getStickerPackItemByPosition', 'removeStickerPackItemByStickerId', 'shiftStickerPackPositionsAfter', 'bulkUpdateStickerPackPositions'];

  for (const methodName of requiredPackMethods) {
    if (typeof deps.packRepository[methodName] !== 'function') {
      throw new Error(`packRepository.${methodName} é obrigatório para createStickerPackService().`);
    }
  }

  for (const methodName of requiredItemMethods) {
    if (typeof deps.itemRepository[methodName] !== 'function') {
      throw new Error(`itemRepository.${methodName} é obrigatório para createStickerPackService().`);
    }
  }

  const runAction = async (action, context, handler, { expectedErrorCodes = [] } = {}) => {
    const start = process.hrtime.bigint();
    const expectedCodesSet = new Set(Array.isArray(expectedErrorCodes) ? expectedErrorCodes.map((code) => String(code || '').trim()).filter(Boolean) : []);

    try {
      const result = await handler();
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;

      deps.logger.info('Ação de sticker pack concluída.', {
        action: 'sticker_pack_action',
        sticker_action: action,
        duration_ms: Number(durationMs.toFixed(2)),
        ...context,
      });

      return result;
    } catch (error) {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      const payload = {
        action: 'sticker_pack_action_failed',
        sticker_action: action,
        duration_ms: Number(durationMs.toFixed(2)),
        error: error.message,
        error_code: error.code,
        ...context,
      };

      if (expectedCodesSet.has(String(error?.code || '').trim())) {
        deps.logger.warn('Falha esperada na ação de sticker pack.', {
          ...payload,
          expected_failure: true,
        });
      } else {
        deps.logger.error('Falha na ação de sticker pack.', payload);
      }

      throw error;
    }
  };

  const ensurePackKey = async (_ownerJid, name, connection = null) => {
    const base = slugify(name, { fallback: 'pack', maxLength: PACK_KEY_BASE_MAX_LENGTH });
    const buildSuffix = () => {
      let suffix = '';
      while (suffix.length < PACK_KEY_SUFFIX_LENGTH) {
        const chunk = randomBytes(PACK_KEY_SUFFIX_LENGTH);
        for (const byte of chunk) {
          // Rejection sampling keeps distribution close to uniform for base-36 chars.
          if (byte >= 252) continue;
          suffix += PACK_KEY_SUFFIX_ALPHABET[byte % PACK_KEY_SUFFIX_ALPHABET.length];
          if (suffix.length >= PACK_KEY_SUFFIX_LENGTH) break;
        }
      }
      return suffix;
    };

    for (let attempt = 0; attempt < PACK_KEY_MAX_ATTEMPTS; attempt += 1) {
      const candidate = `${base}-${buildSuffix()}`;
      const available = await deps.packRepository.ensureUniquePackKey(candidate, connection);
      if (available) return candidate;
    }

    throw buildError(STICKER_PACK_ERROR_CODES.INTERNAL_ERROR, 'Não foi possível gerar um packId único.');
  };

  const resolveOwner = (ownerJid) => {
    const normalized = normalizeOwnerJid(ownerJid);
    ensureValue(normalized, STICKER_PACK_ERROR_CODES.INVALID_INPUT, 'owner_jid inválido para operação do pack.');
    return normalized;
  };

  const resolveOwnedPack = async (ownerJid, identifier, { connection = null } = {}) => {
    const normalizedOwner = resolveOwner(ownerJid);
    const candidates = buildIdentifierCandidates(identifier);

    ensureValue(candidates.length > 0, STICKER_PACK_ERROR_CODES.INVALID_INPUT, 'Informe o pack para continuar.');

    for (const candidate of candidates) {
      const pack = await deps.packRepository.findStickerPackByOwnerAndIdentifier(normalizedOwner, candidate, {
        connection,
      });
      if (pack) return pack;
    }

    throw buildError(STICKER_PACK_ERROR_CODES.PACK_NOT_FOUND, 'Pack não encontrado para este usuário.');
  };

  const resolvePackForSend = async (ownerJid, identifier, { connection = null } = {}) => {
    const normalizedOwner = resolveOwner(ownerJid);
    const candidates = buildIdentifierCandidates(identifier);

    ensureValue(candidates.length > 0, STICKER_PACK_ERROR_CODES.INVALID_INPUT, 'Informe o pack para continuar.');

    for (const candidate of candidates) {
      const owned = await deps.packRepository.findStickerPackByOwnerAndIdentifier(normalizedOwner, candidate, {
        connection,
      });
      if (owned) return owned;
    }

    for (const candidate of candidates) {
      const shared = await deps.packRepository.findStickerPackByPackKey(candidate, {
        includeDeleted: false,
        connection,
      });

      if (shared && isShareableVisibility(shared.visibility)) {
        return shared;
      }
    }

    throw buildError(STICKER_PACK_ERROR_CODES.PACK_NOT_FOUND, 'Pack não encontrado para este usuário.');
  };

  const loadPackDetails = async (pack, { connection = null } = {}) => {
    const items = await deps.itemRepository.listStickerPackItems(pack.id, connection);
    const coverItem = items.find((item) => item.sticker_id === pack.cover_sticker_id);
    const packClassification = await getPackClassificationSummaryByAssetIds(items.map((item) => item.sticker_id)).catch(() => null);

    return {
      ...pack,
      items,
      cover_asset: coverItem?.asset || items[0]?.asset || null,
      sticker_count: items.length,
      classification: packClassification,
    };
  };

  const sanitizeMetadata = ({ name, publisher, description, visibility, defaultVisibility = 'private' }) => {
    const normalizedName = sanitizeText(name, MAX_NAME_LENGTH, { allowEmpty: false });
    const normalizedPublisher = sanitizeText(publisher, MAX_PUBLISHER_LENGTH, {
      allowEmpty: false,
    });
    const normalizedDescription = sanitizeText(description, MAX_DESCRIPTION_LENGTH, {
      allowEmpty: true,
    });
    const normalizedVisibility = toVisibility(visibility, defaultVisibility);

    ensureValue(normalizedName, STICKER_PACK_ERROR_CODES.INVALID_INPUT, 'Nome do pack é obrigatório.');
    ensureValue(normalizedPublisher, STICKER_PACK_ERROR_CODES.INVALID_INPUT, 'Publisher do pack é obrigatório.');

    return {
      name: normalizedName,
      publisher: normalizedPublisher,
      description: normalizedDescription || null,
      visibility: normalizedVisibility,
    };
  };

  const createPack = async ({ ownerJid, name, publisher, description, visibility = undefined, status = 'published', packStatus = undefined, packThemeKey = undefined, packVolume = undefined, isAutoPack = undefined, lastRebalancedAt = undefined }) => {
    const owner = resolveOwner(ownerJid);
    const isAutoPackEnabled = isAutoPack === true || Number(isAutoPack || 0) === 1;
    const normalizedStatus = PACK_STATUS_VALUES.has(String(status || '').toLowerCase()) ? String(status).toLowerCase() : 'published';

    return runAction('create_pack', { owner_jid: owner }, async () => {
      return runInTransaction(async (connection) => {
        const metadata = sanitizeMetadata({
          name,
          publisher,
          description,
          visibility,
          defaultVisibility: isAutoPackEnabled ? 'public' : 'private',
        });
        if (hasOwnerPackLimit) {
          const existing = await deps.packRepository.listStickerPacksByOwner(owner, {
            limit: maxPacksPerOwner + 1,
            connection,
          });

          ensureValue(existing.length < maxPacksPerOwner, STICKER_PACK_ERROR_CODES.PACK_LIMIT_REACHED, `Limite de packs atingido (${maxPacksPerOwner}).`);
        }

        const packKey = await ensurePackKey(owner, metadata.name, connection);

        const created = await deps.packRepository.createStickerPack(
          {
            id: randomUUID(),
            owner_jid: owner,
            name: metadata.name,
            publisher: metadata.publisher,
            description: metadata.description,
            pack_key: packKey,
            cover_sticker_id: null,
            visibility: metadata.visibility,
            status: normalizedStatus,
            pack_status: packStatus,
            pack_theme_key: packThemeKey,
            pack_volume: packVolume,
            is_auto_pack: isAutoPackEnabled,
            last_rebalanced_at: lastRebalancedAt,
            version: 1,
          },
          connection,
        );

        return loadPackDetails(created, { connection });
      });
    });
  };

  const listPacks = async ({ ownerJid, limit = 50 }) => {
    const owner = resolveOwner(ownerJid);

    return runAction('list_packs', { owner_jid: owner }, async () => {
      const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
      return deps.packRepository.listStickerPacksByOwner(owner, { limit: safeLimit });
    });
  };

  const getPackInfo = async ({ ownerJid, identifier }) => {
    const owner = resolveOwner(ownerJid);

    return runAction('pack_info', { owner_jid: owner }, async () => {
      const pack = await resolveOwnedPack(owner, identifier);
      return loadPackDetails(pack);
    });
  };

  const getPackInfoForSend = async ({ ownerJid, identifier }) => {
    const owner = resolveOwner(ownerJid);

    return runAction('pack_send_info', { owner_jid: owner }, async () => {
      const pack = await resolvePackForSend(owner, identifier);
      return loadPackDetails(pack);
    });
  };

  const renamePack = async ({ ownerJid, identifier, name }) => {
    const owner = resolveOwner(ownerJid);
    const normalizedName = sanitizeText(name, MAX_NAME_LENGTH, { allowEmpty: false });

    ensureValue(normalizedName, STICKER_PACK_ERROR_CODES.INVALID_INPUT, 'Novo nome inválido.');

    return runAction('rename_pack', { owner_jid: owner }, async () => {
      const pack = await resolveOwnedPack(owner, identifier);
      const updated = await deps.packRepository.updateStickerPackFields(pack.id, {
        name: normalizedName,
      });
      return loadPackDetails(updated);
    });
  };

  const setPackPublisher = async ({ ownerJid, identifier, publisher }) => {
    const owner = resolveOwner(ownerJid);
    const normalizedPublisher = sanitizeText(publisher, MAX_PUBLISHER_LENGTH, {
      allowEmpty: false,
    });

    ensureValue(normalizedPublisher, STICKER_PACK_ERROR_CODES.INVALID_INPUT, 'Publisher inválido.');

    return runAction('set_publisher', { owner_jid: owner }, async () => {
      const pack = await resolveOwnedPack(owner, identifier);
      const updated = await deps.packRepository.updateStickerPackFields(pack.id, {
        publisher: normalizedPublisher,
      });
      return loadPackDetails(updated);
    });
  };

  const setPackDescription = async ({ ownerJid, identifier, description }) => {
    const owner = resolveOwner(ownerJid);
    const normalizedDescription = sanitizeText(description, MAX_DESCRIPTION_LENGTH, {
      allowEmpty: true,
    });

    return runAction('set_description', { owner_jid: owner }, async () => {
      const pack = await resolveOwnedPack(owner, identifier);
      const updated = await deps.packRepository.updateStickerPackFields(pack.id, {
        description: normalizedDescription || null,
      });
      return loadPackDetails(updated);
    });
  };

  const setPackVisibility = async ({ ownerJid, identifier, visibility }) => {
    const owner = resolveOwner(ownerJid);
    const normalizedVisibility = toVisibility(visibility, null);

    ensureValue(normalizedVisibility, STICKER_PACK_ERROR_CODES.INVALID_INPUT, 'Visibilidade inválida. Use: private, public ou unlisted.');

    return runAction('set_visibility', { owner_jid: owner }, async () => {
      const pack = await resolveOwnedPack(owner, identifier);
      const updated = await deps.packRepository.updateStickerPackFields(pack.id, {
        visibility: normalizedVisibility,
      });
      return loadPackDetails(updated);
    });
  };

  const setPackCover = async ({ ownerJid, identifier, stickerId }) => {
    const owner = resolveOwner(ownerJid);
    const normalizedStickerId = sanitizeText(stickerId, 36, { allowEmpty: false });

    ensureValue(normalizedStickerId, STICKER_PACK_ERROR_CODES.INVALID_INPUT, 'Sticker inválido para capa.');

    return runAction('set_cover', { owner_jid: owner }, async () => {
      const pack = await resolveOwnedPack(owner, identifier);
      const item = await deps.itemRepository.getStickerPackItemByStickerId(pack.id, normalizedStickerId);

      ensureValue(item, STICKER_PACK_ERROR_CODES.STICKER_NOT_FOUND, 'Essa figurinha não está no pack.');

      const updated = await deps.packRepository.updateStickerPackFields(pack.id, {
        cover_sticker_id: item.sticker_id,
      });

      return loadPackDetails(updated);
    });
  };

  const addStickerToPack = async ({ ownerJid, identifier, asset, emojis = [], accessibilityLabel = null, expectedErrorCodes = [] }) => {
    const owner = resolveOwner(ownerJid);

    ensureValue(asset?.id, STICKER_PACK_ERROR_CODES.STICKER_NOT_FOUND, 'Nenhuma figurinha válida foi encontrada.');

    const normalizedLabel = sanitizeText(accessibilityLabel, MAX_ACCESSIBILITY_LABEL_LENGTH, {
      allowEmpty: true,
    });

    return runAction(
      'add_sticker',
      { owner_jid: owner },
      async () => {
        const pack = await resolveOwnedPack(owner, identifier);

        return runInTransaction(async (connection) => {
          const existingItem = await deps.itemRepository.getStickerPackItemByStickerId(pack.id, asset.id, connection);
          ensureValue(!existingItem, STICKER_PACK_ERROR_CODES.DUPLICATE_STICKER, 'Essa figurinha já está no pack.');

          const total = await deps.itemRepository.countStickerPackItems(pack.id, connection);
          ensureValue(total < maxStickersPerPack, STICKER_PACK_ERROR_CODES.PACK_LIMIT_REACHED, `O pack atingiu o limite de ${maxStickersPerPack} figurinhas.`);

          const maxPosition = await deps.itemRepository.getMaxStickerPackPosition(pack.id, connection);

          await deps.itemRepository.createStickerPackItem(
            {
              id: randomUUID(),
              pack_id: pack.id,
              sticker_id: asset.id,
              position: maxPosition + 1,
              emojis: parseEmojiList(emojis),
              accessibility_label: normalizedLabel || null,
            },
            connection,
          );

          if (!pack.cover_sticker_id) {
            await deps.packRepository.updateStickerPackFields(
              pack.id,
              {
                cover_sticker_id: asset.id,
              },
              connection,
            );
          } else {
            await deps.packRepository.bumpStickerPackVersion(pack.id, connection);
          }

          const reloaded = await deps.packRepository.findStickerPackByOwnerAndIdentifier(owner, pack.id, {
            connection,
          });

          return loadPackDetails(reloaded, { connection });
        });
      },
      { expectedErrorCodes },
    );
  };

  const removeStickerFromPack = async ({ ownerJid, identifier, selector }) => {
    const owner = resolveOwner(ownerJid);

    return runAction('remove_sticker', { owner_jid: owner }, async () => {
      const pack = await resolveOwnedPack(owner, identifier);

      return runInTransaction(async (connection) => {
        let item = null;
        const asNumber = Number(selector);

        if (Number.isInteger(asNumber) && asNumber > 0) {
          item = await deps.itemRepository.getStickerPackItemByPosition(pack.id, asNumber, connection);
        }

        if (!item) {
          const stickerId = sanitizeText(selector, 36, { allowEmpty: false });
          ensureValue(stickerId, STICKER_PACK_ERROR_CODES.INVALID_INPUT, 'Informe o índice ou ID da figurinha.');
          item = await deps.itemRepository.getStickerPackItemByStickerId(pack.id, stickerId, connection);
        }

        ensureValue(item, STICKER_PACK_ERROR_CODES.STICKER_NOT_FOUND, 'Figurinha não encontrada no pack.');

        await deps.itemRepository.removeStickerPackItemByStickerId(pack.id, item.sticker_id, connection);
        await deps.itemRepository.shiftStickerPackPositionsAfter(pack.id, item.position, connection);

        if (pack.cover_sticker_id === item.sticker_id) {
          const remaining = await deps.itemRepository.listStickerPackItems(pack.id, connection);
          const nextCover = remaining[0]?.sticker_id || null;

          await deps.packRepository.updateStickerPackFields(
            pack.id,
            {
              cover_sticker_id: nextCover,
            },
            connection,
          );
        } else {
          await deps.packRepository.bumpStickerPackVersion(pack.id, connection);
        }

        const reloaded = await deps.packRepository.findStickerPackByOwnerAndIdentifier(owner, pack.id, {
          connection,
        });

        return {
          removed: item,
          pack: await loadPackDetails(reloaded, { connection }),
        };
      });
    });
  };

  const reorderPackItems = async ({ ownerJid, identifier, orderStickerIds }) => {
    const owner = resolveOwner(ownerJid);
    ensureValue(Array.isArray(orderStickerIds) && orderStickerIds.length > 0, STICKER_PACK_ERROR_CODES.INVALID_INPUT, 'Envie a nova ordem de figurinhas.');

    return runAction('reorder_pack', { owner_jid: owner }, async () => {
      const pack = await resolveOwnedPack(owner, identifier);

      return runInTransaction(async (connection) => {
        const currentItems = await deps.itemRepository.listStickerPackItems(pack.id, connection);
        ensureValue(currentItems.length > 1, STICKER_PACK_ERROR_CODES.INVALID_INPUT, 'O pack precisa de 2+ figurinhas para reordenar.');

        const currentIds = currentItems.map((item) => item.sticker_id);
        const currentSet = new Set(currentIds);
        const seen = new Set();
        const requestedIds = [];

        for (const rawId of orderStickerIds) {
          const id = sanitizeText(rawId, 36, { allowEmpty: false });
          if (!id || !currentSet.has(id) || seen.has(id)) continue;
          requestedIds.push(id);
          seen.add(id);
        }

        ensureValue(requestedIds.length > 0, STICKER_PACK_ERROR_CODES.INVALID_INPUT, 'A ordem enviada não corresponde às figurinhas do pack.');

        const finalOrder = [...requestedIds, ...currentIds.filter((id) => !seen.has(id))];

        if (!areArraysEqual(currentIds, finalOrder)) {
          await deps.itemRepository.bulkUpdateStickerPackPositions(pack.id, finalOrder, connection);
          await deps.packRepository.bumpStickerPackVersion(pack.id, connection);
        }

        const reloaded = await deps.packRepository.findStickerPackByOwnerAndIdentifier(owner, pack.id, {
          connection,
        });

        return loadPackDetails(reloaded, { connection });
      });
    });
  };

  const clonePack = async ({ ownerJid, identifier, newName }) => {
    const owner = resolveOwner(ownerJid);
    const normalizedName = sanitizeText(newName, MAX_NAME_LENGTH, { allowEmpty: false });

    ensureValue(normalizedName, STICKER_PACK_ERROR_CODES.INVALID_INPUT, 'Novo nome do clone é obrigatório.');

    return runAction('clone_pack', { owner_jid: owner }, async () => {
      const source = await resolveOwnedPack(owner, identifier);

      return runInTransaction(async (connection) => {
        const sourceItems = await deps.itemRepository.listStickerPackItems(source.id, connection);
        const packKey = await ensurePackKey(owner, normalizedName);

        const created = await deps.packRepository.createStickerPack(
          {
            id: randomUUID(),
            owner_jid: owner,
            name: normalizedName,
            publisher: source.publisher,
            description: source.description,
            pack_key: packKey,
            cover_sticker_id: source.cover_sticker_id,
            visibility: 'private',
            version: 1,
          },
          connection,
        );

        for (const item of sourceItems) {
          await deps.itemRepository.createStickerPackItem(
            {
              id: randomUUID(),
              pack_id: created.id,
              sticker_id: item.sticker_id,
              position: item.position,
              emojis: item.emojis || [],
              accessibility_label: item.accessibility_label || null,
            },
            connection,
          );
        }

        return loadPackDetails(created, { connection });
      });
    });
  };

  const deletePack = async ({ ownerJid, identifier }) => {
    const owner = resolveOwner(ownerJid);

    return runAction('delete_pack', { owner_jid: owner }, async () => {
      const pack = await resolveOwnedPack(owner, identifier);
      const deleted = await deps.packRepository.softDeleteStickerPack(pack.id);
      return loadPackDetails(deleted);
    });
  };

  return {
    createPack,
    listPacks,
    getPackInfo,
    getPackInfoForSend,
    renamePack,
    setPackPublisher,
    setPackDescription,
    setPackVisibility,
    setPackCover,
    addStickerToPack,
    removeStickerFromPack,
    reorderPackItems,
    clonePack,
    deletePack,
  };
}
