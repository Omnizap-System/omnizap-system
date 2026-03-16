import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import logger from '#logger';
import { getJidUser } from '../../config/index.js';

const TEMP_DIR = path.join(process.cwd(), 'temp', 'stickers');
const METADATA_MAX_LENGTH = 64;
const WEBPMUX_CHECK_TIMEOUT_MS = 5000;
const WEBPMUX_EXEC_TIMEOUT_MS = 12000;

let webpmuxAvailabilityPromise = null;

/**
 * Contexto de placeholders usados nos metadados (`#nome`, `#id`).
 * @typedef {Object} StickerReplaceContext
 * @property {string} [senderName] - Nome exibido do remetente.
 * @property {string} [userId] - JID/ID de origem para preencher `#id`.
 */

/**
 * Resultado da execução de processo externo.
 * @typedef {Object} ProcessExecutionResult
 * @property {string} stdout
 * @property {string} stderr
 */

/**
 * Envia sinal para um processo filho com tratamento seguro de erro.
 *
 * @param {import('node:child_process').ChildProcessWithoutNullStreams} child - Processo filho alvo.
 * @param {NodeJS.Signals} signal - Sinal a ser enviado.
 * @returns {boolean} `true` se o sinal foi enviado; `false` caso contrário.
 */
function safeKill(child, signal) {
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

/**
 * Executa um comando externo com timeout e captura de stdout/stderr.
 *
 * @param {string} command - Binário a executar.
 * @param {string[]} args - Argumentos separados (sem shell).
 * @param {{ timeoutMs: number }} options - Opções de execução.
 * @returns {Promise<ProcessExecutionResult>} Saídas do comando.
 */
function runProcess(command, args, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let didTimeout = false;

    const timeoutRef = setTimeout(() => {
      didTimeout = true;
      safeKill(child, 'SIGTERM');
      setTimeout(() => safeKill(child, 'SIGKILL'), 1500);
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      clearTimeout(timeoutRef);
      reject(error);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timeoutRef);

      if (didTimeout) {
        const timeoutError = new Error(`Processo excedeu o timeout de ${timeoutMs}ms.`);
        timeoutError.code = 'ETIMEDOUT';
        timeoutError.signal = signal;
        timeoutError.stderr = stderr;
        reject(timeoutError);
        return;
      }

      if (code !== 0) {
        const processError = new Error(`${command} finalizou com código ${code}${signal ? ` (sinal: ${signal})` : ''}.`);
        processError.code = code;
        processError.signal = signal;
        processError.stderr = stderr;
        processError.stdout = stdout;
        reject(processError);
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

/**
 * Verifica se `webpmux` está disponível no ambiente, com cache em memória.
 *
 * @returns {Promise<true>} Resolve `true` quando o binário está disponível.
 * @throws {Error} Quando `webpmux` não está instalado ou não responde.
 */
async function ensureWebpmuxAvailable() {
  if (webpmuxAvailabilityPromise) {
    return webpmuxAvailabilityPromise;
  }

  webpmuxAvailabilityPromise = runProcess('webpmux', ['-version'], {
    timeoutMs: WEBPMUX_CHECK_TIMEOUT_MS,
  })
    .then(() => true)
    .catch((error) => {
      webpmuxAvailabilityPromise = null;
      throw error;
    });

  return webpmuxAvailabilityPromise;
}

/**
 * Normaliza texto de metadado: remove quebras de linha, compacta espaços e limita tamanho.
 *
 * @param {unknown} value - Valor de entrada.
 * @param {string} [fallback=''] - Valor padrão quando o resultado fica vazio.
 * @returns {string} Texto pronto para ser serializado no EXIF.
 */
function normalizeMetadataText(value, fallback = '') {
  const normalized = String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, METADATA_MAX_LENGTH);
  return normalized || fallback;
}

/**
 * Adiciona metadados EXIF de pacote ao arquivo WEBP.
 *
 * Em caso de erro, a função retorna o `stickerPath` original para evitar bloquear o envio.
 *
 * @param {string} stickerPath - Caminho do WEBP base.
 * @param {string} packName - Nome do pacote (aceita placeholders: `#nome`, `#data`, `#hora`, `#id`).
 * @param {string} packAuthor - Autor do pacote (aceita placeholders: `#nome`, `#data`, `#hora`, `#id`).
 * @param {StickerReplaceContext} [replaceContext={}] - Dados para substituir placeholders.
 * @returns {Promise<string>} Caminho do WEBP final com metadados (ou o original em fallback).
 */
export async function addStickerMetadata(stickerPath, packName, packAuthor, replaceContext = {}) {
  const { senderName = '', userId = '' } = replaceContext;
  const now = __timeNow();
  const pad = (n) => n.toString().padStart(2, '0');
  const dataAtual = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`;
  const horaAtual = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const baseSenderName = normalizeMetadataText(senderName, 'Omnizap');
  const resolvedUserId = String(getJidUser(userId) || userId || '').trim();

  function doReplaces(str) {
    return String(str ?? '')
      .replace(/#nome/gi, baseSenderName)
      .replace(/#data/gi, dataAtual)
      .replace(/#hora/gi, horaAtual)
      .replace(/#id/gi, resolvedUserId);
  }

  const finalPackName = normalizeMetadataText(doReplaces(packName), 'Omnizap');
  const finalPackAuthor = normalizeMetadataText(doReplaces(packAuthor), baseSenderName);

  logger.info(`addStickerMetadata Adicionando metadados ao sticker. Nome: "${finalPackName}", Autor: "${finalPackAuthor}"`);

  let exifPath = null;
  let outputPath = null;
  let shouldKeepOutput = false;

  try {
    await fs.mkdir(TEMP_DIR, { recursive: true });
    await ensureWebpmuxAvailable();

    const stickerDir = path.dirname(stickerPath) || TEMP_DIR;
    await fs.mkdir(stickerDir, { recursive: true });

    const exifData = {
      'sticker-pack-id': `com.omnizap.${randomUUID()}`,
      'sticker-pack-name': finalPackName,
      'sticker-pack-publisher': finalPackAuthor,
    };

    const fileTag = randomUUID();
    exifPath = path.join(TEMP_DIR, `exif_${fileTag}.exif`);
    const exifAttr = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00]);
    const jsonBuffer = Buffer.from(JSON.stringify(exifData), 'utf8');
    const exifBuffer = Buffer.concat([exifAttr, jsonBuffer]);
    exifBuffer.writeUIntLE(jsonBuffer.length, 14, 4);

    await fs.writeFile(exifPath, exifBuffer);

    outputPath = path.join(stickerDir, `final_${fileTag}.webp`);
    await runProcess('webpmux', ['-set', 'exif', exifPath, stickerPath, '-o', outputPath], {
      timeoutMs: WEBPMUX_EXEC_TIMEOUT_MS,
    });

    const outputStats = await fs.stat(outputPath);
    if (!outputStats.isFile() || outputStats.size <= 0) {
      throw new Error('Sticker final gerado inválido ao aplicar metadados.');
    }

    shouldKeepOutput = true;
    logger.info(`addStickerMetadata Metadados adicionados com sucesso. Sticker final: ${outputPath}`);
    return outputPath;
  } catch (error) {
    if (error.code === 'ENOENT') {
      logger.error('addStickerMetadata webpmux não encontrado no PATH.');
    }
    logger.error(`addStickerMetadata Erro ao adicionar metadados: ${error.message}`, {
      label: 'addStickerMetadata',
      error: error.stack,
    });
    return stickerPath;
  } finally {
    const filesToClean = [exifPath];
    if (!shouldKeepOutput && outputPath) {
      filesToClean.push(outputPath);
    }

    for (const filePath of filesToClean.filter(Boolean)) {
      await fs.unlink(filePath).catch((cleanupError) => {
        if (cleanupError?.code !== 'ENOENT') {
          logger.warn(`addStickerMetadata Falha ao limpar arquivo temporário ${filePath}: ${cleanupError.message}`);
        }
      });
    }
  }
}
