import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import logger from '#logger';
import { downloadMediaMessage, extractMediaDetails } from '../../config/index.js';
import { isFeatureEnabled } from '../../services/infra/featureFlagService.js';
import { createStickerAsset, findLatestStickerAssetByOwner, findStickerAssetById, findStickerAssetBySha256, updateStickerAssetStoragePath } from './stickerAssetRepository.js';
import { ensureStickerAssetClassified } from './stickerClassificationService.js';
import { STICKER_PACK_ERROR_CODES, StickerPackError } from './stickerPackErrors.js';
import { normalizeOwnerJid } from './stickerPackUtils.js';
import { getStickerObjectStorageUrl, isStickerObjectStorageEnabled, readStickerFromObjectStorage, uploadStickerToObjectStorage } from './stickerObjectStorageService.js';

/**
 * Camada de storage local para assets de figurinha do sistema de packs.
 */
const STORAGE_ROOT = path.resolve(process.env.STICKER_STORAGE_DIR || path.join(process.cwd(), 'data', 'stickers'));
const TEMP_ROOT = path.join(process.cwd(), 'temp', 'sticker-pack-assets');
const DEFAULT_MAX_STICKER_BYTES = 2 * 1024 * 1024;
const MAX_STICKER_BYTES = Math.max(64 * 1024, Number(process.env.STICKER_PACK_MAX_STICKER_BYTES) || DEFAULT_MAX_STICKER_BYTES);
const LAST_STICKER_TTL_MS = Math.max(60_000, Number(process.env.STICKER_PACK_LAST_CACHE_TTL_MS) || 6 * 60 * 60 * 1000);
const OBJECT_STORAGE_UPLOAD_TIMEOUT_MS = Math.max(1_000, Number(process.env.STICKER_OBJECT_STORAGE_UPLOAD_TIMEOUT_MS) || 10_000);

const lastStickerCache = new Map();

const withTimeout = (promise, ms) =>
  Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`timeout_after_${ms}ms`));
      }, ms);
    }),
  ]);

const isObjectStorageDeliveryEnabled = async (subjectKey = '') =>
  isFeatureEnabled('enable_object_storage_delivery', {
    fallback: false,
    subjectKey: subjectKey || 'object_storage_delivery',
  });

/**
 * Converte JID para um token seguro no caminho de disco.
 *
 * @param {string} ownerJid JID do usuário.
 * @returns {string} Token seguro para diretório.
 */
const safeOwnerToken = (ownerJid) => {
  const normalized = normalizeOwnerJid(ownerJid);
  const token = String(normalized || 'unknown')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 100);
  return token || 'unknown';
};

const buildStoragePath = (ownerJid, sha256) => path.join(STORAGE_ROOT, safeOwnerToken(ownerJid), `${sha256}.webp`);

/**
 * Verifica se um caminho existe no sistema de arquivos.
 *
 * @param {string} targetPath Caminho absoluto do arquivo.
 * @returns {Promise<boolean>} `true` quando o arquivo existe.
 */
const fileExists = async (targetPath) => {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
};

/**
 * Faz validação rápida de assinatura WEBP.
 *
 * @param {Buffer} buffer Buffer da mídia.
 * @returns {boolean} `true` quando parece WEBP.
 */
const isLikelyWebp = (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return false;
  return buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
};

/**
 * Detecta chunks de animação em WEBP.
 *
 * @param {Buffer} buffer Buffer da mídia.
 * @returns {boolean} `true` quando o sticker é animado.
 */
const detectAnimatedWebp = (buffer) => {
  if (!Buffer.isBuffer(buffer)) return false;
  return buffer.includes(Buffer.from('ANIM')) || buffer.includes(Buffer.from('ANMF'));
};

/**
 * Lê dimensões de um arquivo WEBP a partir dos headers.
 *
 * @param {Buffer} buffer Buffer do sticker.
 * @returns {{ width: number|null, height: number|null }} Dimensões detectadas.
 */
const parseWebpDimensions = (buffer) => {
  if (!isLikelyWebp(buffer)) return { width: null, height: null };

  const chunk = buffer.subarray(12, 16).toString('ascii');

  if (chunk === 'VP8X' && buffer.length >= 30) {
    const width = 1 + buffer.readUIntLE(24, 3);
    const height = 1 + buffer.readUIntLE(27, 3);
    return { width, height };
  }

  if (chunk === 'VP8 ' && buffer.length >= 30) {
    const width = buffer.readUInt16LE(26) & 0x3fff;
    const height = buffer.readUInt16LE(28) & 0x3fff;
    return {
      width: width > 0 ? width : null,
      height: height > 0 ? height : null,
    };
  }

  if (chunk === 'VP8L' && buffer.length >= 25) {
    const b0 = buffer[21];
    const b1 = buffer[22];
    const b2 = buffer[23];
    const b3 = buffer[24];

    const width = 1 + (((b1 & 0x3f) << 8) | b0);
    const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));

    return {
      width: width > 0 ? width : null,
      height: height > 0 ? height : null,
    };
  }

  return { width: null, height: null };
};

/**
 * Memoriza o último sticker salvo por dono para fallback rápido.
 *
 * @param {string} ownerJid JID do dono.
 * @param {string} assetId ID do asset.
 * @returns {void}
 */
const rememberLastSticker = (ownerJid, assetId) => {
  if (!ownerJid || !assetId) return;

  const normalized = normalizeOwnerJid(ownerJid);
  lastStickerCache.set(normalized, {
    assetId,
    expiresAt: __timeNowMs() + LAST_STICKER_TTL_MS,
  });
};

/**
 * Resolve asset do cache do último sticker (com TTL).
 *
 * @param {string} ownerJid JID do dono.
 * @returns {string|null} ID do asset ainda válido.
 */
const resolveLastStickerAssetId = (ownerJid) => {
  const normalized = normalizeOwnerJid(ownerJid);
  const entry = lastStickerCache.get(normalized);
  if (!entry) return null;

  if (entry.expiresAt <= __timeNowMs()) {
    lastStickerCache.delete(normalized);
    return null;
  }

  return entry.assetId;
};

/**
 * Gera hash SHA-256 do buffer.
 *
 * @param {Buffer} buffer Conteúdo da figurinha.
 * @returns {string} Hash SHA-256 em hexadecimal.
 */
const computeSha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

/**
 * Garante persistência física do arquivo no storage definitivo.
 *
 * @param {{ ownerJid: string, sha256: string, buffer: Buffer }} params Contexto de escrita.
 * @returns {Promise<string>} Caminho final persistido.
 */
const ensureStorageForAsset = async ({ ownerJid, sha256, buffer }) => {
  const targetPath = buildStoragePath(ownerJid, sha256);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });

  if (!(await fileExists(targetPath))) {
    await fs.writeFile(targetPath, buffer);
  }

  return targetPath;
};

const uploadExternalStorageBestEffort = async ({ ownerJid, sha256, buffer, mimetype = 'image/webp', assetId = null }) => {
  if (!isStickerObjectStorageEnabled()) return;
  const canUpload = await isObjectStorageDeliveryEnabled(normalizeOwnerJid(ownerJid) || sha256);
  if (!canUpload) return;
  try {
    await withTimeout(
      uploadStickerToObjectStorage({
        ownerJid,
        sha256,
        buffer,
        mimetype,
      }),
      OBJECT_STORAGE_UPLOAD_TIMEOUT_MS,
    );
  } catch (error) {
    logger.warn('Falha no upload best-effort para object storage.', {
      action: 'sticker_object_storage_upload_best_effort_failed',
      owner_jid: ownerJid || null,
      asset_id: assetId || null,
      sha256: sha256 || null,
      error: error?.message,
    });
  }
};

/**
 * Extrai detalhes de mídia sticker de uma mensagem.
 *
 * @param {object} messageInfo Mensagem original.
 * @param {{ includeQuoted?: boolean }} [options] Inclui mídia citada.
 * @returns {object|null} Detalhes da mídia quando for sticker.
 */
const resolveStickerMediaDetails = (messageInfo, { includeQuoted = true } = {}) => {
  const mediaDetails = extractMediaDetails(messageInfo, { includeQuoted });
  if (!mediaDetails || mediaDetails.mediaType !== 'sticker') {
    return null;
  }

  return mediaDetails;
};

/**
 * Valida buffer recebido antes de salvar no storage.
 *
 * @param {Buffer} buffer Buffer da figurinha.
 * @returns {void}
 * @throws {StickerPackError} Quando o buffer for inválido, grande demais ou não-WEBP.
 */
const validateStickerBuffer = (buffer) => {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new StickerPackError(STICKER_PACK_ERROR_CODES.STORAGE_ERROR, 'Arquivo da figurinha veio vazio.');
  }

  if (buffer.length > MAX_STICKER_BYTES) {
    throw new StickerPackError(STICKER_PACK_ERROR_CODES.INVALID_INPUT, `Figurinha excede o limite de ${(MAX_STICKER_BYTES / (1024 * 1024)).toFixed(1)} MB.`);
  }

  if (!isLikelyWebp(buffer)) {
    throw new StickerPackError(STICKER_PACK_ERROR_CODES.INVALID_INPUT, 'A mídia precisa estar no formato WEBP para entrar no pack.');
  }
};

/**
 * Persiste um asset de sticker a partir de buffer em memória.
 *
 * @param {{ ownerJid: string, buffer: Buffer, mimetype?: string }} params Dados de persistência.
 * @returns {Promise<object>} Asset salvo ou já existente.
 */
async function persistStickerAssetBuffer({ ownerJid, buffer, mimetype = 'image/webp' }) {
  const normalizedOwner = normalizeOwnerJid(ownerJid);
  validateStickerBuffer(buffer);

  const sha256 = computeSha256(buffer);
  const existing = await findStickerAssetBySha256(sha256);

  if (existing) {
    const existingPathOk = existing.storage_path ? await fileExists(existing.storage_path) : false;

    if (!existingPathOk) {
      const fixedPath = await ensureStorageForAsset({ ownerJid: normalizedOwner, sha256, buffer });
      const repaired = await updateStickerAssetStoragePath(existing.id, fixedPath);
      rememberLastSticker(normalizedOwner, repaired.id);
      await ensureStickerAssetClassified({ asset: repaired, buffer }).catch((error) => {
        logger.warn('Falha ao classificar figurinha reparada durante persistência.', {
          action: 'sticker_asset_classify_repaired_failed',
          asset_id: repaired.id,
          owner_jid: normalizedOwner,
          error: error?.message,
        });
      });
      await uploadExternalStorageBestEffort({
        ownerJid: normalizedOwner,
        sha256,
        buffer,
        mimetype,
        assetId: repaired.id,
      });
      return repaired;
    }

    rememberLastSticker(normalizedOwner, existing.id);
    await ensureStickerAssetClassified({ asset: existing, buffer }).catch((error) => {
      logger.warn('Falha ao classificar figurinha existente durante persistência.', {
        action: 'sticker_asset_classify_existing_failed',
        asset_id: existing.id,
        owner_jid: normalizedOwner,
        error: error?.message,
      });
    });
    await uploadExternalStorageBestEffort({
      ownerJid: normalizedOwner,
      sha256,
      buffer,
      mimetype,
      assetId: existing.id,
    });
    return existing;
  }

  const storagePath = await ensureStorageForAsset({ ownerJid: normalizedOwner, sha256, buffer });
  const { width, height } = parseWebpDimensions(buffer);

  try {
    const created = await createStickerAsset({
      id: randomUUID(),
      owner_jid: normalizedOwner,
      sha256,
      mimetype,
      is_animated: detectAnimatedWebp(buffer),
      width,
      height,
      size_bytes: buffer.length,
      storage_path: storagePath,
    });

    rememberLastSticker(normalizedOwner, created.id);
    await ensureStickerAssetClassified({ asset: created, buffer }).catch((error) => {
      logger.warn('Falha ao classificar figurinha recém-criada durante persistência.', {
        action: 'sticker_asset_classify_created_failed',
        asset_id: created.id,
        owner_jid: normalizedOwner,
        error: error?.message,
      });
    });
    await uploadExternalStorageBestEffort({
      ownerJid: normalizedOwner,
      sha256,
      buffer,
      mimetype,
      assetId: created.id,
    });
    return created;
  } catch (error) {
    if (error?.code === 'ER_DUP_ENTRY') {
      const duplicated = await findStickerAssetBySha256(sha256);
      if (duplicated) {
        rememberLastSticker(normalizedOwner, duplicated.id);
        return duplicated;
      }
    }
    throw error;
  }
}

/**
 * Faz download do sticker da mensagem e delega persistência do buffer.
 *
 * @param {{ mediaDetails: object, ownerJid: string }} params Detalhes da mídia e dono.
 * @returns {Promise<object>} Asset salvo.
 */
async function persistStickerAssetFromDetails({ mediaDetails, ownerJid }) {
  const normalizedOwner = normalizeOwnerJid(ownerJid);
  const mediaSize = Number(mediaDetails?.details?.fileLength || mediaDetails?.mediaKey?.fileLength || 0);

  if (mediaSize > MAX_STICKER_BYTES) {
    throw new StickerPackError(STICKER_PACK_ERROR_CODES.INVALID_INPUT, `Figurinha excede o limite de ${(MAX_STICKER_BYTES / (1024 * 1024)).toFixed(1)} MB.`);
  }

  const tempOwnerDir = path.join(TEMP_ROOT, safeOwnerToken(normalizedOwner));
  await fs.mkdir(tempOwnerDir, { recursive: true });

  let downloadedPath = null;

  try {
    downloadedPath = await downloadMediaMessage(mediaDetails.mediaKey, 'sticker', tempOwnerDir);
    if (!downloadedPath) {
      throw new StickerPackError(STICKER_PACK_ERROR_CODES.STORAGE_ERROR, 'Não foi possível baixar a figurinha para armazenamento.');
    }

    const buffer = await fs.readFile(downloadedPath);

    return await persistStickerAssetBuffer({
      ownerJid: normalizedOwner,
      buffer,
      mimetype: mediaDetails?.details?.mimetype || 'image/webp',
    });
  } catch (error) {
    if (error instanceof StickerPackError) {
      throw error;
    }

    logger.error('Falha ao persistir figurinha no storage local.', {
      action: 'sticker_asset_store_failed',
      owner_jid: normalizedOwner,
      error: error.message,
    });
    throw new StickerPackError(STICKER_PACK_ERROR_CODES.STORAGE_ERROR, 'Falha ao salvar figurinha no servidor.', error);
  } finally {
    if (downloadedPath) {
      await fs.unlink(downloadedPath).catch(() => {});
    }
  }
}

/**
 * Salva figurinha direto de um buffer local.
 *
 * @param {{ ownerJid: string, buffer: Buffer, mimetype?: string }} params Dados da figurinha.
 * @returns {Promise<object>} Asset salvo.
 */
export async function saveStickerAssetFromBuffer({ ownerJid, buffer, mimetype = 'image/webp' }) {
  const normalizedOwner = normalizeOwnerJid(ownerJid);

  try {
    return await persistStickerAssetBuffer({ ownerJid: normalizedOwner, buffer, mimetype });
  } catch (error) {
    if (error instanceof StickerPackError) {
      throw error;
    }

    logger.error('Falha ao persistir figurinha gerada localmente.', {
      action: 'sticker_asset_store_from_buffer_failed',
      owner_jid: normalizedOwner,
      error: error.message,
    });

    throw new StickerPackError(STICKER_PACK_ERROR_CODES.STORAGE_ERROR, 'Falha ao salvar figurinha gerada no servidor.', error);
  }
}

/**
 * Salva figurinha a partir de mensagem (opcionalmente quoted).
 *
 * @param {{ messageInfo: object, ownerJid: string, includeQuoted?: boolean }} params Contexto da mensagem.
 * @returns {Promise<object|null>} Asset salvo ou `null` quando não há sticker.
 */
export async function saveStickerAssetFromMessage({ messageInfo, ownerJid, includeQuoted = true }) {
  const mediaDetails = resolveStickerMediaDetails(messageInfo, { includeQuoted });
  if (!mediaDetails) return null;

  return persistStickerAssetFromDetails({ mediaDetails, ownerJid });
}

/**
 * Captura stickers recebidos no fluxo passivo (sem quoted).
 *
 * @param {{ messageInfo: object, ownerJid: string }} params Contexto da mensagem.
 * @returns {Promise<object|null>} Asset capturado.
 */
export async function captureIncomingStickerAsset({ messageInfo, ownerJid }) {
  return saveStickerAssetFromMessage({ messageInfo, ownerJid, includeQuoted: false });
}

/**
 * Recupera o último sticker conhecido do usuário via cache+banco.
 *
 * @param {string} ownerJid JID do usuário.
 * @returns {Promise<object|null>} Último asset encontrado.
 */
export async function getLastStickerAssetForOwner(ownerJid) {
  const normalizedOwner = normalizeOwnerJid(ownerJid);
  const cachedAssetId = resolveLastStickerAssetId(normalizedOwner);

  if (cachedAssetId) {
    const cachedAsset = await findStickerAssetById(cachedAssetId);
    if (cachedAsset) return cachedAsset;
  }

  const latest = await findLatestStickerAssetByOwner(normalizedOwner);
  if (latest) {
    rememberLastSticker(normalizedOwner, latest.id);
  }
  return latest;
}

/**
 * Resolve sticker para comandos: mensagem atual, quoted ou último cacheado.
 *
 * @param {{
 *   messageInfo: object,
 *   ownerJid: string,
 *   includeQuoted?: boolean,
 *   fallbackToLast?: boolean,
 * }} params Contexto de resolução.
 * @returns {Promise<object|null>} Asset resolvido.
 */
export async function resolveStickerAssetForCommand({ messageInfo, ownerJid, includeQuoted = true, fallbackToLast = true }) {
  const mediaDetails = resolveStickerMediaDetails(messageInfo, { includeQuoted });

  if (mediaDetails) {
    return persistStickerAssetFromDetails({ mediaDetails, ownerJid });
  }

  if (!fallbackToLast) {
    return null;
  }

  return getLastStickerAssetForOwner(ownerJid);
}

/**
 * Lê o arquivo de sticker em disco a partir de um asset.
 *
 * @param {{ storage_path?: string }} asset Registro do asset.
 * @returns {Promise<Buffer>} Buffer da figurinha.
 * @throws {StickerPackError} Quando o arquivo não puder ser lido.
 */
export async function readStickerAssetBuffer(asset) {
  if (asset?.storage_path) {
    try {
      return await fs.readFile(asset.storage_path);
    } catch (error) {
      const externalBuffer = await readStickerFromObjectStorage(asset).catch(() => null);
      if (Buffer.isBuffer(externalBuffer) && externalBuffer.length) {
        return externalBuffer;
      }
      throw new StickerPackError(STICKER_PACK_ERROR_CODES.STORAGE_ERROR, `Não foi possível ler a figurinha em disco (${asset.storage_path}).`, error);
    }
  }

  const externalBuffer = await readStickerFromObjectStorage(asset).catch(() => null);
  if (Buffer.isBuffer(externalBuffer) && externalBuffer.length) {
    return externalBuffer;
  }

  throw new StickerPackError(STICKER_PACK_ERROR_CODES.STORAGE_ERROR, 'Caminho do sticker não encontrado no storage.');
}

export async function getStickerAssetExternalUrl(asset, { secure = true, expiresInSeconds = 300 } = {}) {
  if (!asset) return null;
  const canUseExternalDelivery = await isObjectStorageDeliveryEnabled(normalizeOwnerJid(asset?.owner_jid || '') || String(asset?.id || asset?.sha256 || ''));
  if (!canUseExternalDelivery) return null;
  return getStickerObjectStorageUrl(asset, {
    secure,
    expiresInSeconds,
  });
}

/**
 * Retorna configuração efetiva do storage do módulo.
 *
 * @returns {{ storageRoot: string, maxStickerBytes: number }} Configuração ativa.
 */
export function getStickerStorageConfig() {
  return {
    storageRoot: STORAGE_ROOT,
    maxStickerBytes: MAX_STICKER_BYTES,
    objectStorageEnabled: isStickerObjectStorageEnabled(),
  };
}
