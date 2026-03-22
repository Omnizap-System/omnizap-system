import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import 'dotenv/config';

import { isAdminCommand } from '../modules/adminModule/groupCommandHandlers.js';
import { explicarComandoGlobal, registerGlobalHelpCommandExecution } from '../services/ai/globalModuleAiHelpService.js';
import { extractSupportedStickerMediaDetails, processSticker } from '../modules/stickerModule/stickerCommand.js';
import { detectAllMediaTypes, extractMessageContent, getExpiration, getJidServer, isGroupJid, isStatusJid, isSameJidUser, normalizeJid, normalizeWAPresence, resolveBotJid, extractSenderInfoFromMessage, resolveUserId, resolveAddressingModeFromMessageKey, resolveCanonicalWhatsAppJid, parseEnvBool, parseEnvInt } from '../config/index.js';
import { isUserAdmin } from '../config/index.js';
import { isAdminSenderAsync } from '../config/index.js';
import { executeQuery, TABLES } from '../../database/index.js';
import logger from '#logger';
import { handleAntiLink } from '../utils/antiLink/antiLinkModule.js';
import { maybeCaptureIncomingSticker } from '../modules/stickerPackModule/stickerPackCommandHandlers.js';
import groupConfigStore from '../store/groupConfigStore.js';
import { sendAndStore } from '../configParts/messagePersistenceService.js';
import { resolveCaptchaByMessage } from '../services/messaging/captchaService.js';
import { buildWhatsAppGoogleLoginUrl } from '../services/auth/whatsappLoginLinkService.js';
import { isWhatsAppUserLinkedToGoogleWebAccount } from '../services/auth/googleWebLinkService.js';
import { createMessageAnalysisEvent } from '../modules/analyticsModule/messageAnalysisEventRepository.js';
import { routeConversationMessage } from '../services/ai/conversationRouterService.js';
import { executeMessageCommandRoute, isKnownNonAdminCommand } from '../services/ai/messageCommandExecutionService.js';
import { canSendMessageInStickerFocus, registerMessageUsageInStickerFocus, resolveStickerFocusMessageClassification, resolveStickerFocusState, shouldSendStickerFocusWarning } from '../services/sticker/stickerFocusService.js';
import { createPreProcessingMiddlewares } from './messagePipeline/preProcessingMiddlewares.js';
import { createConversationMiddleware } from './messagePipeline/conversationMiddleware.js';
import { createCommandMiddleware } from './messagePipeline/commandMiddleware.js';
import { createPostProcessingMiddleware } from './messagePipeline/postProcessingMiddleware.js';

const DEFAULT_COMMAND_PREFIX = process.env.COMMAND_PREFIX || '/';
const COMMAND_REACT_EMOJI = process.env.COMMAND_REACT_EMOJI || '🤖';
const START_LOGIN_TRIGGER =
  String(process.env.WHATSAPP_LOGIN_TRIGGER || 'iniciar')
    .trim()
    .toLowerCase() || 'iniciar';
const MESSAGE_ANALYTICS_ENABLED = parseEnvBool(process.env.MESSAGE_ANALYTICS_ENABLED, true);
const MESSAGE_ANALYTICS_SOURCE =
  String(process.env.MESSAGE_ANALYTICS_SOURCE || 'whatsapp')
    .trim()
    .slice(0, 32) || 'whatsapp';
const MESSAGE_COMMAND_DEDUPE_TTL_MS = parseEnvInt(process.env.MESSAGE_COMMAND_DEDUPE_TTL_MS, 120_000, 15_000, 30 * 60 * 1000);
const MESSAGE_REPLY_PRESENCE_BEFORE = normalizeWAPresence(process.env.MESSAGE_REPLY_PRESENCE_BEFORE, 'composing');
const MESSAGE_REPLY_PRESENCE_AFTER = normalizeWAPresence(process.env.MESSAGE_REPLY_PRESENCE_AFTER, 'paused');
const MESSAGE_REPLY_PRESENCE_DELAY_MS = parseEnvInt(process.env.MESSAGE_REPLY_PRESENCE_DELAY_MS, 280, 0, 3_000);
const MESSAGE_REPLY_PRESENCE_SUBSCRIBE = parseEnvBool(process.env.MESSAGE_REPLY_PRESENCE_SUBSCRIBE, true);
const CONVERSATIONAL_AUTO_REPLY_ENABLED = parseEnvBool(process.env.CONVERSATIONAL_AUTO_REPLY_ENABLED, false);
const WHATSAPP_COMMAND_REQUIRES_GOOGLE_LOGIN = parseEnvBool(process.env.WHATSAPP_COMMAND_REQUIRES_GOOGLE_LOGIN, true);
const SITE_ORIGIN =
  String(process.env.SITE_ORIGIN || process.env.WHATSAPP_LOGIN_BASE_URL || 'https://omnizap.shop')
    .trim()
    .replace(/\/+$/, '') || 'https://omnizap.shop';
const SITE_LOGIN_URL = `${SITE_ORIGIN}/login/`;
const SITE_GROUP_LOGIN_URL = `${SITE_ORIGIN}/login`;

let messageAnalyticsTableMissingLogged = false;
const recentCommandExecutions = new Map();

const pruneRecentCommandExecutions = (nowMs = __timeNowMs()) => {
  for (const [cacheKey, expiresAt] of recentCommandExecutions.entries()) {
    if (expiresAt <= nowMs) {
      recentCommandExecutions.delete(cacheKey);
    }
  }
};

const buildCommandExecutionCacheKey = (chatId, messageId) => {
  const normalizedChatId = String(chatId || '').trim();
  const normalizedMessageId = String(messageId || '').trim();
  if (!normalizedChatId || !normalizedMessageId) return '';
  return `${normalizedChatId}:${normalizedMessageId}`;
};

const isDuplicateCommandExecution = (chatId, messageId) => {
  const cacheKey = buildCommandExecutionCacheKey(chatId, messageId);
  if (!cacheKey) return false;

  const nowMs = __timeNowMs();
  const expiresAt = recentCommandExecutions.get(cacheKey) || 0;
  if (expiresAt <= nowMs) {
    recentCommandExecutions.delete(cacheKey);
    return false;
  }

  return true;
};

const markCommandExecution = (chatId, messageId) => {
  const cacheKey = buildCommandExecutionCacheKey(chatId, messageId);
  if (!cacheKey) return;
  pruneRecentCommandExecutions(__timeNowMs());
  recentCommandExecutions.set(cacheKey, __timeNowMs() + MESSAGE_COMMAND_DEDUPE_TTL_MS);
};

const normalizeTriggerText = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

const isStartLoginTrigger = (text) => normalizeTriggerText(text) === START_LOGIN_TRIGGER;

const resolveCanonicalSenderJidFromMessage = async ({ messageInfo, senderJid }) => {
  const key = messageInfo?.key || {};
  const senderInfo = extractSenderInfoFromMessage(messageInfo);
  let canonicalUserId = resolveCanonicalWhatsAppJid(senderInfo?.jid, senderInfo?.remoteJidAlt, senderInfo?.participantAlt, key.remoteJidAlt, key.participantAlt, key.participant, key.remoteJid, senderJid);

  try {
    const resolvedUserId = await resolveUserId(senderInfo);
    canonicalUserId = resolveCanonicalWhatsAppJid(resolvedUserId, canonicalUserId, senderInfo?.jid, senderInfo?.remoteJidAlt, senderInfo?.participantAlt);
  } catch (error) {
    logger.warn('Falha ao resolver ID canonico do remetente.', {
      action: 'resolve_sender_canonical_id_failed',
      error: error?.message,
    });
  }

  return canonicalUserId;
};

const resolveSenderContext = async ({ messageInfo, isGroupMessage, remoteJid }) => {
  const key = messageInfo?.key || {};
  const senderInfo = extractSenderInfoFromMessage(messageInfo);
  let resolvedUserId = '';

  try {
    const resolved = await resolveUserId(senderInfo);
    resolvedUserId = String(resolved || '').trim();
  } catch (error) {
    logger.debug('Falha ao resolver senderId via lidMapService.', {
      action: 'resolve_sender_context_failed',
      error: error?.message,
    });
  }

  const senderJidCandidates = isGroupMessage ? [resolvedUserId, senderInfo?.jid, senderInfo?.participantAlt, key.participantAlt, key.participant, key.remoteJidAlt, remoteJid] : [resolvedUserId, senderInfo?.jid, senderInfo?.participantAlt, key.remoteJidAlt, key.remoteJid, remoteJid];

  const canonicalSender = resolveCanonicalWhatsAppJid(...senderJidCandidates);
  const fallbackSender = senderJidCandidates.find((candidate) => String(candidate || '').trim()) || '';
  const senderJid = canonicalSender || String(fallbackSender || '').trim();
  const addressingMode = resolveAddressingModeFromMessageKey(key, senderInfo);

  const senderIdentity = isGroupMessage
    ? {
        participant: key?.participant || null,
        participantAlt: key?.participantAlt || null,
        jid: senderJid || null,
      }
    : senderJid;

  return {
    senderJid,
    senderIdentity,
    senderInfo,
    resolvedUserId,
    addressingMode,
  };
};

const sendReply = (sock, remoteJid, messageInfo, expirationMessage, content, options = {}) =>
  sendAndStore(sock, remoteJid, content, {
    quoted: messageInfo,
    ephemeralExpiration: expirationMessage,
    presenceBefore: MESSAGE_REPLY_PRESENCE_BEFORE,
    presenceAfter: MESSAGE_REPLY_PRESENCE_AFTER,
    presenceDelayMs: MESSAGE_REPLY_PRESENCE_DELAY_MS,
    presenceSubscribe: MESSAGE_REPLY_PRESENCE_SUBSCRIBE,
    ...(options || {}),
  });

const maybeHandleStartLoginMessage = async ({ sock, messageInfo, extractedText, senderName, senderJid, remoteJid, expirationMessage, isMessageFromBot, isGroupMessage }) => {
  if (isMessageFromBot || !isStartLoginTrigger(extractedText)) return false;

  if (isGroupMessage) {
    await sendReply(sock, remoteJid, messageInfo, expirationMessage, {
      text: '🔐 *Segurança dos seus dados*\n\n' + 'Para proteger sua conta, o acesso é feito apenas no *privado*.\n' + 'Envie *iniciar* no chat privado do bot para receber seu link de login seguro.\n\n' + '⚠️ Por segurança, não enviamos links de acesso em grupos.',
    });
    return true;
  }

  const key = messageInfo?.key || {};
  const senderInfo = extractSenderInfoFromMessage(messageInfo);
  const canonicalUserId = await resolveCanonicalSenderJidFromMessage({ messageInfo, senderJid });

  const loginUrl = buildWhatsAppGoogleLoginUrl({ userId: canonicalUserId });
  if (!loginUrl) {
    logger.warn('Nao foi possivel montar link de login para mensagem "iniciar".', {
      action: 'login_link_missing_user_phone',
      remoteServer: getJidServer(key.remoteJid || ''),
      remoteAltServer: getJidServer(key.remoteJidAlt || ''),
      participantServer: getJidServer(key.participant || ''),
      participantAltServer: getJidServer(key.participantAlt || ''),
      hasLid: Boolean(senderInfo?.lid),
      hasJid: Boolean(senderInfo?.jid),
    });
    await sendReply(sock, remoteJid, messageInfo, expirationMessage, {
      text: 'Nao consegui identificar seu numero de WhatsApp para o login. Tente novamente em alguns segundos.',
    });
    return true;
  }

  const safeName = String(senderName || '').trim();
  const greeting = safeName ? `Oi, *${safeName}*!` : 'Oi!';
  await sendReply(sock, remoteJid, messageInfo, expirationMessage, {
    text: `${greeting}\n\n` + '🚀 *Bem-vindo ao OmniZap!*\n\n' + 'Para continuar, faça login com sua conta *Google* no link abaixo:\n\n' + `${loginUrl}\n\n` + '🔐 Seu número do WhatsApp será vinculado automaticamente à conta após o login.\n' + '⚠️ Use apenas este link e não compartilhe com outras pessoas.',
  });

  return true;
};

/**
 * Resolve o prefixo de comandos.
 * Usa o prefixo do grupo quando existir, senão usa o padrão.
 */
const resolveCommandPrefix = async (isGroupMessage, remoteJid, groupConfig = null) => {
  if (!isGroupMessage) return DEFAULT_COMMAND_PREFIX;
  const config = groupConfig || (await groupConfigStore.getGroupConfig(remoteJid));
  if (!config || typeof config.commandPrefix !== 'string') {
    return DEFAULT_COMMAND_PREFIX;
  }
  const prefix = config.commandPrefix.trim();
  return prefix || DEFAULT_COMMAND_PREFIX;
};

const resolveBotIdentityCandidates = (sockUser = {}) => {
  const candidates = new Set();
  const addCandidate = (value) => {
    const normalized = normalizeJid(String(value || '').trim());
    if (!normalized) return;
    candidates.add(normalized);
  };

  addCandidate(sockUser?.id);
  addCandidate(sockUser?.jid);
  addCandidate(sockUser?.lid);
  addCandidate(resolveBotJid(sockUser?.id));

  return Array.from(candidates);
};

const formatRemainingMinutesLabel = (remainingMs) => {
  const safeMs = Math.max(0, Number(remainingMs) || 0);
  const remainingMinutes = Math.ceil(safeMs / (60 * 1000));
  return Math.max(1, remainingMinutes);
};

const formatStickerFocusRuleLabel = ({ messageAllowanceCount, messageCooldownMinutes }) => {
  const allowanceCount = Math.max(1, Math.floor(Number(messageAllowanceCount) || 1));
  const cooldownMinutes = Math.max(1, Math.floor(Number(messageCooldownMinutes) || 1));
  const messageLabel = allowanceCount === 1 ? 'mensagem' : 'mensagens';
  return `${allowanceCount} ${messageLabel} a cada ${cooldownMinutes} min`;
};

/**
 * Executa um comando com tratamento de erro.
 * Captura erros síncronos e promessas rejeitadas.
 */
const runCommand = (label, handler) => {
  try {
    return Promise.resolve(handler())
      .then(() => ({ ok: true }))
      .catch((error) => {
        logger.error(`Erro ao executar comando ${label}:`, error?.message);
        return { ok: false, error };
      });
  } catch (error) {
    logger.error(`Erro ao executar comando ${label}:`, error?.message);
    return Promise.resolve({ ok: false, error });
  }
};

const normalizeMessageKind = (mediaEntries, extractedText) => {
  if (Array.isArray(mediaEntries) && mediaEntries.length > 0) {
    const primaryType =
      String(mediaEntries[0]?.mediaType || '')
        .trim()
        .toLowerCase() || 'media';
    return primaryType.slice(0, 48);
  }

  const safeText = String(extractedText || '').trim();
  if (!safeText || safeText === 'Mensagem vazia') return 'empty';
  if (safeText.startsWith('[') && safeText.endsWith(']')) {
    return safeText.slice(1, -1).trim().toLowerCase().replace(/\s+/g, '_').slice(0, 48);
  }
  return 'text';
};

const normalizeAnalysisErrorCode = (error) =>
  String(error?.code || error?.name || 'processing_error')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .slice(0, 96) || 'processing_error';

const buildCommandErrorHelpText = async ({ command, commandRoute, commandPrefix, isGroupMessage, isSenderAdmin, isSenderOwner }) => {
  const normalizedCommand = String(command || '')
    .trim()
    .toLowerCase();
  if (!normalizedCommand) return '';

  if (commandRoute === 'unknown') {
    return '';
  }

  try {
    const helpResult = await explicarComandoGlobal(normalizedCommand, {
      commandPrefix,
      isGroupMessage,
      isSenderAdmin,
      isSenderOwner,
    });
    return String(helpResult?.text || '').trim();
  } catch (error) {
    logger.warn('Falha ao gerar ajuda IA para erro de comando.', {
      action: 'command_error_ai_help_failed',
      command: normalizedCommand,
      commandRoute,
      error: error?.message,
    });
    return '';
  }
};

const persistMessageAnalysisEvent = (payload) => {
  if (!MESSAGE_ANALYTICS_ENABLED) return;
  void createMessageAnalysisEvent(payload).catch((error) => {
    if (error?.code === 'ER_NO_SUCH_TABLE') {
      if (messageAnalyticsTableMissingLogged) return;
      messageAnalyticsTableMissingLogged = true;
      logger.warn('Tabela de analytics de mensagens ainda não existe. Execute a migracao 20260301_0028.', {
        action: 'message_analysis_table_missing',
      });
      return;
    }

    logger.warn('Falha ao persistir analytics de mensagem.', {
      action: 'message_analysis_insert_failed',
      error: error?.message,
    });
  });
};

const buildSiteLoginUrlForUser = (canonicalUserId) => buildWhatsAppGoogleLoginUrl({ userId: canonicalUserId }) || SITE_LOGIN_URL;

const ensureUserHasGoogleWebLoginForCommand = async ({ sock, messageInfo, senderJid, remoteJid, expirationMessage, commandPrefix, canonicalUserId = '', knownHasGoogleLogin } = {}) => {
  const isGroupMessage = isGroupJid(remoteJid);
  const normalizedCanonicalUserId = String(canonicalUserId || '').trim();
  const resolvedCanonicalUserId = normalizedCanonicalUserId || (await resolveCanonicalSenderJidFromMessage({ messageInfo, senderJid }));
  const hasKnownGoogleLogin = typeof knownHasGoogleLogin === 'boolean';
  let linked = Boolean(knownHasGoogleLogin ? knownHasGoogleLogin : false);

  if (!hasKnownGoogleLogin) {
    try {
      linked = await isWhatsAppUserLinkedToGoogleWebAccount({
        ownerJid: resolvedCanonicalUserId || senderJid,
      });
    } catch (error) {
      logger.warn('Falha ao validar vínculo Google Web para comando do WhatsApp. Comando liberado por fallback.', {
        action: 'whatsapp_command_google_link_check_failed',
        error: error?.message,
      });
      return {
        allowed: true,
        canonicalUserId: resolvedCanonicalUserId,
        loginUrl: '',
      };
    }
  }

  if (linked) {
    return {
      allowed: true,
      canonicalUserId: resolvedCanonicalUserId,
      loginUrl: '',
    };
  }

  const loginUrl = isGroupMessage ? SITE_GROUP_LOGIN_URL : buildSiteLoginUrlForUser(resolvedCanonicalUserId || senderJid);
  const loginMessage = isGroupMessage ? '🔐 *Login necessário*\n\n' + 'Para usar os comandos do bot, você precisa estar logado com sua conta *Google*.\n\n' + 'Acesse o link abaixo para entrar:\n' + `${loginUrl}\n\n` + '⚠️ Por segurança, recomendamos abrir o link no privado.' : '🔐 *Login necessário*\n\n' + 'Para usar os comandos do bot, faça login com sua conta *Google* no link abaixo:\n\n' + `${loginUrl}\n\n` + '✅ Após entrar, volte aqui e envie o comando novamente\n' + `(ex.: *${commandPrefix}menu*).`;

  await sendReply(sock, remoteJid, messageInfo, expirationMessage, {
    text: loginMessage,
  });

  return {
    allowed: false,
    canonicalUserId: resolvedCanonicalUserId,
    loginUrl,
  };
};

const mergeAnalysisMetadata = (analysisPayload, metadataPatch = {}) => {
  if (!metadataPatch || typeof metadataPatch !== 'object') return;
  analysisPayload.metadata = {
    ...analysisPayload.metadata,
    ...metadataPatch,
  };
};

const stopMessagePipeline = (ctx, processingResult = '', metadataPatch = null) => {
  if (processingResult) {
    ctx.analysisPayload.processingResult = processingResult;
  }
  if (metadataPatch) {
    mergeAnalysisMetadata(ctx.analysisPayload, metadataPatch);
  }
  ctx.pipelineStopped = true;
  return { stop: true };
};

const ensureGroupConfigForContext = async (ctx) => {
  if (!ctx.isGroupMessage) return null;
  if (ctx.groupConfigLoaded) return ctx.groupConfig;
  ctx.groupConfigLoaded = true;
  ctx.groupConfig = await groupConfigStore.getGroupConfig(ctx.remoteJid);
  return ctx.groupConfig;
};

const ensureCommandPrefixForContext = async (ctx) => {
  if (!ctx.isGroupMessage) {
    ctx.commandPrefix = DEFAULT_COMMAND_PREFIX;
  } else {
    const activeGroupConfig = await ensureGroupConfigForContext(ctx);
    ctx.commandPrefix = await resolveCommandPrefix(true, ctx.remoteJid, activeGroupConfig);
  }
  ctx.analysisPayload.commandPrefix = ctx.commandPrefix;
  return ctx.commandPrefix;
};

const resolveCanonicalSenderJidForContext = async (ctx) => {
  if (!ctx.memo.canonicalSenderJidPromise) {
    ctx.memo.canonicalSenderJidPromise = resolveCanonicalSenderJidFromMessage({
      messageInfo: ctx.messageInfo,
      senderJid: ctx.senderJid,
    });
  }
  return ctx.memo.canonicalSenderJidPromise;
};

const resolveSenderAdminForContext = async (ctx, { mode = 'identity' } = {}) => {
  if (!ctx.isGroupMessage) return false;

  const normalizedMode =
    String(mode || '')
      .trim()
      .toLowerCase() === 'jid'
      ? 'jid'
      : 'identity';
  const memoKey = normalizedMode === 'jid' ? 'senderAdminByJidPromise' : 'senderAdminByIdentityPromise';
  if (!ctx.memo[memoKey]) {
    const adminTarget = normalizedMode === 'jid' ? ctx.senderJid : ctx.senderIdentity;
    ctx.memo[memoKey] = isUserAdmin(ctx.remoteJid, adminTarget);
  }
  return ctx.memo[memoKey];
};

const resolveSenderOwnerForContext = async (ctx) => {
  if (!ctx.memo.senderOwnerPromise) {
    ctx.memo.senderOwnerPromise = isAdminSenderAsync(ctx.senderIdentity);
  }
  return ctx.memo.senderOwnerPromise;
};

const resolveHasGoogleLoginForContext = async (ctx) => {
  if (ctx.isMessageFromBot || !WHATSAPP_COMMAND_REQUIRES_GOOGLE_LOGIN) {
    return undefined;
  }

  if (!ctx.memo.hasGoogleLoginPromise) {
    ctx.memo.hasGoogleLoginPromise = (async () => {
      const canonicalSenderJid = await resolveCanonicalSenderJidForContext(ctx);
      if (!canonicalSenderJid) return undefined;
      return isWhatsAppUserLinkedToGoogleWebAccount({
        ownerJid: canonicalSenderJid,
      });
    })();
  }
  return ctx.memo.hasGoogleLoginPromise;
};

const createMessagePipelineContext = async ({ messageInfo, upsertType, isNotifyUpsert, sock }) => {
  const key = messageInfo?.key || {};
  const remoteJid = key?.remoteJid;
  if (!remoteJid) return null;

  const isGroupMessage = isGroupJid(remoteJid);
  const extractedText = extractMessageContent(messageInfo);
  const { senderJid, senderIdentity, addressingMode } = await resolveSenderContext({
    messageInfo,
    isGroupMessage,
    remoteJid,
  });

  const senderName = messageInfo?.pushName;
  const expirationMessage = getExpiration(messageInfo);
  const botJidCandidates = resolveBotIdentityCandidates(sock?.user || {});
  const botJid = botJidCandidates[0] || null;
  const isMessageFromBot = Boolean(key?.fromMe) || botJidCandidates.some((candidate) => isSameJidUser(senderJid, candidate));
  const mediaEntries = detectAllMediaTypes(messageInfo?.message, false);
  const mediaTypes = mediaEntries
    .map((entry) =>
      String(entry?.mediaType || '')
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean)
    .slice(0, 10);

  const analysisPayload = {
    messageId: key?.id || null,
    chatId: remoteJid || null,
    senderId: senderJid || null,
    senderName,
    upsertType,
    source: MESSAGE_ANALYTICS_SOURCE,
    isGroup: isGroupMessage,
    isFromBot: isMessageFromBot,
    isCommand: false,
    commandName: null,
    commandArgsCount: 0,
    commandKnown: null,
    commandPrefix: DEFAULT_COMMAND_PREFIX,
    messageKind: normalizeMessageKind(mediaEntries, extractedText),
    hasMedia: mediaEntries.length > 0,
    mediaCount: mediaEntries.length,
    textLength: String(extractedText || '').length,
    processingResult: 'processed',
    errorCode: null,
    metadata: {
      media_types: mediaTypes,
      start_login_trigger: isStartLoginTrigger(extractedText),
      upsert_type: upsertType,
      is_notify_upsert: isNotifyUpsert,
      is_history_append: upsertType === 'append',
      addressing_mode: addressingMode || null,
      participant_alt: key?.participantAlt || null,
      remote_jid_alt: key?.remoteJidAlt || null,
    },
  };

  return {
    sock,
    messageInfo,
    key,
    remoteJid,
    isGroupMessage,
    extractedText,
    senderJid,
    senderIdentity,
    senderName,
    expirationMessage,
    botJidCandidates,
    botJid,
    isMessageFromBot,
    commandPrefix: DEFAULT_COMMAND_PREFIX,
    groupConfig: null,
    groupConfigLoaded: false,
    mediaEntries,
    upsertType,
    isNotifyUpsert,
    isCommandMessage: false,
    hasCommandPrefix: false,
    analysisPayload,
    pipelineStopped: false,
    memo: Object.create(null),
  };
};

const { touchSenderLastSeenMiddleware, ignoreUnprocessableMessageMiddleware, applyGroupPolicyMiddleware, resolveCaptchaMiddleware, handleStartLoginTriggerMiddleware, detectCommandIntentMiddleware, applyStickerFocusMiddleware } = createPreProcessingMiddlewares({
  executeQuery,
  TABLES,
  isStatusJid,
  stopMessagePipeline,
  handleAntiLink,
  ensureCommandPrefixForContext,
  resolveCaptchaByMessage,
  maybeHandleStartLoginMessage,
  mergeAnalysisMetadata,
  ensureGroupConfigForContext,
  resolveStickerFocusState,
  resolveStickerFocusMessageClassification,
  resolveSenderAdminForContext,
  isUserAdmin,
  canSendMessageInStickerFocus,
  registerMessageUsageInStickerFocus,
  shouldSendStickerFocusWarning,
  sendReply,
  formatStickerFocusRuleLabel,
  formatRemainingMinutesLabel,
  logger,
});

const routeConversationMiddleware = createConversationMiddleware({
  logger,
  resolveSenderAdminForContext,
  resolveSenderOwnerForContext,
  resolveHasGoogleLoginForContext,
  isUserAdmin,
  isAdminSenderAsync,
  resolveCanonicalSenderJidForContext,
  isWhatsAppUserLinkedToGoogleWebAccount,
  WHATSAPP_COMMAND_REQUIRES_GOOGLE_LOGIN,
  ensureUserHasGoogleWebLoginForCommand,
  executeMessageCommandRoute,
  isAdminCommand,
  runCommand,
  sendReply,
  routeConversationMessage,
  stopMessagePipeline,
  conversationAutoReplyEnabled: CONVERSATIONAL_AUTO_REPLY_ENABLED,
});

const executeCommandMiddleware = createCommandMiddleware({
  isAdminCommand,
  isKnownNonAdminCommand,
  isDuplicateCommandExecution,
  markCommandExecution,
  MESSAGE_COMMAND_DEDUPE_TTL_MS,
  stopMessagePipeline,
  WHATSAPP_COMMAND_REQUIRES_GOOGLE_LOGIN,
  resolveCanonicalSenderJidForContext,
  ensureUserHasGoogleWebLoginForCommand,
  SITE_LOGIN_URL,
  COMMAND_REACT_EMOJI,
  sendAndStore,
  executeMessageCommandRoute,
  runCommand,
  sendReply,
  registerGlobalHelpCommandExecution,
  logger,
  normalizeAnalysisErrorCode,
  resolveSenderAdminForContext,
  isUserAdmin,
  buildCommandErrorHelpText,
  mergeAnalysisMetadata,
});

const runPostProcessingMiddleware = createPostProcessingMiddleware({
  runCommand,
  maybeCaptureIncomingSticker,
  extractSupportedStickerMediaDetails,
  ensureGroupConfigForContext,
  mergeAnalysisMetadata,
  processSticker,
  normalizeAnalysisErrorCode,
});

const MESSAGE_PIPELINE_MIDDLEWARES = [touchSenderLastSeenMiddleware, ignoreUnprocessableMessageMiddleware, applyGroupPolicyMiddleware, resolveCaptchaMiddleware, handleStartLoginTriggerMiddleware, detectCommandIntentMiddleware, applyStickerFocusMiddleware, routeConversationMiddleware, executeCommandMiddleware, runPostProcessingMiddleware];

const runMessagePipeline = async (ctx) => {
  for (const middleware of MESSAGE_PIPELINE_MIDDLEWARES) {
    if (ctx.pipelineStopped) break;
    const result = await middleware(ctx);
    if (result?.stop) break;
  }
};

/**
 * Lida com atualizações do WhatsApp, sejam mensagens ou eventos genéricos.
 *
 * @param {Object} update - Objeto contendo a atualização do WhatsApp.
 */
export const handleMessagesThroughPipeline = async (update, sock) => {
  if (update.messages && Array.isArray(update.messages)) {
    try {
      const upsertType = update?.type || null;
      const isNotifyUpsert = upsertType === 'notify';

      for (const messageInfo of update.messages) {
        const context = await createMessagePipelineContext({
          messageInfo,
          upsertType,
          isNotifyUpsert,
          sock,
        });
        if (!context) continue;

        try {
          await runMessagePipeline(context);
        } catch (messageError) {
          context.analysisPayload.processingResult = 'error';
          context.analysisPayload.errorCode = normalizeAnalysisErrorCode(messageError);
          logger.error('Erro ao processar mensagem individual:', {
            error: messageError?.message,
            messageId: context.key?.id || null,
            remoteJid: context.remoteJid,
          });
        } finally {
          persistMessageAnalysisEvent(context.analysisPayload);
        }
      }
    } catch (error) {
      logger.error('Erro ao processar mensagens:', error?.message);
    }
  } else {
    logger.info('🔄 Processando evento recebido:', {
      eventType: update?.type || 'unknown',
      eventData: update,
    });
  }
};

export const handleMessages = handleMessagesThroughPipeline;
