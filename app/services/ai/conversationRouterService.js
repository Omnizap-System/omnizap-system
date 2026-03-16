import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import logger from '#logger';
import { isSameJidUser } from '../../config/index.js';
import { responderPerguntaGlobal } from './globalModuleAiHelpService.js';
import { appendConversationSessionMessage, getConversationSession, setConversationSessionIntent } from '../../store/conversationSessionStore.js';

const parseEnvBool = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
};

const parseEnvInt = (value, fallback, min, max) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
};

const ROUTER_ENABLED = parseEnvBool(process.env.CONVERSATIONAL_ROUTER_ENABLED, true);
const PRIVATE_ENABLED = parseEnvBool(process.env.CONVERSATIONAL_PRIVATE_ENABLED, true);
const GROUP_ENABLED = parseEnvBool(process.env.CONVERSATIONAL_GROUP_ENABLED, true);
const GROUP_COOLDOWN_MS = parseEnvInt(process.env.CONVERSATIONAL_GROUP_COOLDOWN_MS, 90_000, 10_000, 30 * 60 * 1000);
const SESSION_TTL_MS = parseEnvInt(process.env.CONVERSATIONAL_SESSION_TTL_MS, 15 * 60 * 1000, 60_000, 12 * 60 * 60 * 1000);
const SESSION_HISTORY_LIMIT = parseEnvInt(process.env.CONVERSATIONAL_SESSION_HISTORY_LIMIT, 8, 2, 20);

const groupCooldownCache = new Map();
const routerMetrics = {
  intent_detected: 0,
  suggestion_sent: 0,
  group_reply_sent: 0,
  private_reply_sent: 0,
  fallback_used: 0,
  cooldown_skip: 0,
};

const normalizeText = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');

const BOT_STYLE_JID_PATTERN = /@bot$/i;

const resolveJidUserPart = (jid) =>
  String(jid || '')
    .trim()
    .toLowerCase()
    .split('@')[0]
    .split(':')[0]
    .trim();

const isBotStyleJid = (jid) => BOT_STYLE_JID_PATTERN.test(String(jid || '').trim());

const isSameJidUserLoose = (jidA, jidB) => {
  const safeA = String(jidA || '').trim();
  const safeB = String(jidB || '').trim();
  if (!safeA || !safeB) return false;

  try {
    if (isSameJidUser(safeA, safeB)) return true;
  } catch {
    // Ignora erro de normalizacao e usa fallback por user part.
  }

  const userA = resolveJidUserPart(safeA);
  const userB = resolveJidUserPart(safeB);
  if (!userA || !userB) return false;
  return userA === userB;
};

const resolveBotIdentityCandidates = ({ botJid, botJidCandidates }) => {
  const candidates = new Set();
  const addCandidate = (value) => {
    const safeValue = String(value || '').trim();
    if (!safeValue) return;
    candidates.add(safeValue);
  };

  addCandidate(botJid);
  if (Array.isArray(botJidCandidates)) {
    for (const candidate of botJidCandidates) {
      addCandidate(candidate);
    }
  }

  return Array.from(candidates);
};

const isLikelyFollowUp = (text) => /^(e|tambem|tamb[eé]m|isso|como|explica|detalha|detalhe|funciona|e em|e no|e na)\b/i.test(String(text || '').trim());

const hasExplicitQuestionIntent = (text) => {
  const normalized = normalizeText(text);
  if (!normalized) return false;

  const hasQuestionMark = String(text || '').includes('?');
  const asksCapability = /\b(comando|comandos|ajuda|pode|consegue|faz|sabe|funciona|tem|usar|menu)\b/.test(normalized);
  const addressesBot = /\b(bot|omnizap|voce|vc)\b/.test(normalized);
  const hasAskPattern = /\b(qual comando|me ajuda|me explique|como usar|o que voce faz|o que o bot faz)\b/.test(normalized);

  return hasAskPattern || ((hasQuestionMark || asksCapability) && (addressesBot || asksCapability));
};

const BOT_NAME_PATTERN = /\bomni\s*-?\s*zap\b|\bomnizap+\b|\bomnzap\b/i;
const BOT_CALL_WORD_PATTERN = /\b(bot|ajuda|help|comando|comandos|menu|faz|sabe|funciona|como|usar|usa|consegue|pode)\b/i;
const BOT_KEYWORD_ONLY_PATTERN = /^(bot\s*)?(omni\s*-?\s*zap|omnizap+|omnzap)(\s*bot)?$/i;

const hasBotKeywordTrigger = (text) => {
  const normalized = normalizeText(text);
  if (!normalized) return false;

  const hasBotName = BOT_NAME_PATTERN.test(normalized);
  if (!hasBotName) return false;
  if (BOT_CALL_WORD_PATTERN.test(normalized)) return true;

  const tokens = normalized.split(/\s+/).filter(Boolean);
  return tokens.length <= 3;
};

const pruneGroupCooldown = (nowMs = __timeNowMs()) => {
  for (const [key, expiresAt] of groupCooldownCache.entries()) {
    if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) {
      groupCooldownCache.delete(key);
    }
  }
};

const incrementMetric = (metricKey) => {
  routerMetrics[metricKey] = Number(routerMetrics[metricKey] || 0) + 1;
};

const collectContextInfos = (rootNodes) => {
  const contextInfos = [];
  const queue = (Array.isArray(rootNodes) ? rootNodes : [rootNodes]).filter((node) => node && typeof node === 'object');
  const visited = new Set();

  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== 'object') continue;
    if (visited.has(node)) continue;
    visited.add(node);

    if (node.contextInfo && typeof node.contextInfo === 'object') {
      contextInfos.push(node.contextInfo);
    }
    if (node.messageContextInfo && typeof node.messageContextInfo === 'object') {
      contextInfos.push(node.messageContextInfo);
    }

    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') {
        queue.push(value);
      }
    }
  }

  return contextInfos;
};

const resolveMessageInteractionContext = ({ messageInfo, botJid, botJidCandidates = [] }) => {
  const contextInfos = collectContextInfos([messageInfo?.message || {}, messageInfo?.messageContextInfo || {}]);
  const botIdentityCandidates = resolveBotIdentityCandidates({ botJid, botJidCandidates });
  const mentioned = [];
  const replyParticipants = [];
  let repliedToOwnQuotedMessage = false;

  for (const contextInfo of contextInfos) {
    const mentionedJids = Array.isArray(contextInfo?.mentionedJid) ? contextInfo.mentionedJid : [];
    mentioned.push(...mentionedJids);

    const participants = [contextInfo?.participant, contextInfo?.participantAlt, contextInfo?.quotedMessageKey?.participant, contextInfo?.quotedMessageKey?.participantAlt, contextInfo?.remoteJid, contextInfo?.stanzaId ? contextInfo?.participant : null].filter(Boolean);
    replyParticipants.push(...participants);

    if (contextInfo?.quotedMessageKey?.fromMe === true || contextInfo?.quotedMessage?.key?.fromMe === true) {
      repliedToOwnQuotedMessage = true;
    }
  }

  const mentionsBot = mentioned.some((jid) => {
    if (isBotStyleJid(jid)) return true;
    return botIdentityCandidates.some((candidate) => isSameJidUserLoose(jid, candidate));
  });
  const repliedToBotParticipant = replyParticipants.some((jid) => {
    if (isBotStyleJid(jid)) return true;
    return botIdentityCandidates.some((candidate) => isSameJidUserLoose(jid, candidate));
  });
  const isReplyToBot = repliedToBotParticipant || repliedToOwnQuotedMessage;

  return {
    mentionsBot,
    isReplyToBot,
    mentionedCount: mentioned.length,
  };
};

const buildGroupCooldownKey = ({ chatId, senderJid }) => {
  const safeChatId = String(chatId || '').trim();
  const safeSender = String(senderJid || '').trim();
  if (!safeChatId || !safeSender) return '';
  return `${safeChatId}:${safeSender}`;
};

const shouldSkipForGroupCooldown = ({ chatId, senderJid }) => {
  const key = buildGroupCooldownKey({ chatId, senderJid });
  if (!key) return false;

  pruneGroupCooldown();
  const nowMs = __timeNowMs();
  const expiresAt = groupCooldownCache.get(key) || 0;
  if (expiresAt > nowMs) return true;
  return false;
};

const markGroupCooldown = ({ chatId, senderJid }) => {
  const key = buildGroupCooldownKey({ chatId, senderJid });
  if (!key) return;
  pruneGroupCooldown();
  groupCooldownCache.set(key, __timeNowMs() + GROUP_COOLDOWN_MS);
};

const buildIntentFromAnswer = (answer) => ({
  moduleKey: answer?.moduleKey || null,
  commandName: answer?.commandName || null,
  intentType: answer?.intentType || null,
  source: answer?.source || null,
  suggestions: Array.isArray(answer?.suggestions) ? answer.suggestions.slice(0, 5) : [],
});

const buildScopeContext = ({ isGroupMessage, remoteJid, senderJid }) => ({
  scope: isGroupMessage ? 'group' : 'private',
  chatId: remoteJid,
  userId: senderJid,
});

const isPlaceholderText = (value) => {
  const text = String(value || '').trim();
  if (!text || text === 'Mensagem vazia') return true;
  if (text.startsWith('[') && text.endsWith(']')) return true;
  return false;
};

const canHandleGroupConversation = ({ extractedText, mediaEntries }) => {
  const text = String(extractedText || '').trim();
  if (!text || text === 'Mensagem vazia') return false;
  if (text.startsWith('[') && text.endsWith(']')) return false;
  if (Array.isArray(mediaEntries) && mediaEntries.length > 0) return false;
  return true;
};

const resolveGroupPromptFromMessage = ({ extractedText, triggerKind, commandPrefix = '/' }) => {
  const text = String(extractedText || '').trim();
  if (!isPlaceholderText(text)) {
    if (triggerKind === 'bot_keyword' && BOT_KEYWORD_ONLY_PATTERN.test(normalizeText(text))) {
      return `O que voce consegue fazer neste grupo? Me sugira comandos uteis com ${commandPrefix}menu.`;
    }
    return text;
  }

  if (['reply_to_bot', 'mention_bot', 'bot_keyword'].includes(String(triggerKind || '').trim())) {
    return `Me explique o que voce consegue fazer neste grupo e sugira comandos com ${commandPrefix}menu.`;
  }

  return '';
};

const resolvePrivatePromptFromMessage = ({ extractedText, mediaEntries, commandPrefix = '/' }) => {
  const text = String(extractedText || '').trim();
  if (!isPlaceholderText(text)) {
    return {
      prompt: text,
      triggerKind: 'private_text',
      originalText: text,
      mediaTypes: [],
    };
  }

  const mediaTypes = (Array.isArray(mediaEntries) ? mediaEntries : [])
    .map((entry) =>
      String(entry?.mediaType || '')
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);

  if (mediaTypes.includes('image') || mediaTypes.includes('video')) {
    return {
      prompt: `Quais comandos posso usar com imagem ou video no privado? Exemplo com ${commandPrefix}sticker.`,
      triggerKind: 'private_media_image_video',
      originalText: text || '[media:image_video]',
      mediaTypes,
    };
  }
  if (mediaTypes.includes('audio')) {
    return {
      prompt: `Quais comandos aceitam audio? Me mostre opcoes praticas.`,
      triggerKind: 'private_media_audio',
      originalText: text || '[media:audio]',
      mediaTypes,
    };
  }
  if (mediaTypes.includes('sticker')) {
    return {
      prompt: `Como posso converter ou organizar sticker? Me mostre comandos uteis.`,
      triggerKind: 'private_media_sticker',
      originalText: text || '[media:sticker]',
      mediaTypes,
    };
  }

  return {
    prompt: `O que o bot faz? Me sugira comandos para eu comecar agora.`,
    triggerKind: 'private_generic_prompt',
    originalText: text || '[private:sem_texto_util]',
    mediaTypes,
  };
};

export const routeConversationMessage = async ({ messageInfo, extractedText, isCommandMessage, mediaEntries, isGroupMessage, remoteJid, senderJid, botJid, botJidCandidates = [], commandPrefix = '/', toolCommandExecutor = null, resolveToolSecurityContext = null } = {}) => {
  if (!ROUTER_ENABLED) return { handled: false, reason: 'router_disabled' };
  if (isCommandMessage) return { handled: false, reason: 'command_message' };

  const text = String(extractedText || '').trim();

  if (isGroupMessage) {
    if (!GROUP_ENABLED) return { handled: false, reason: 'group_disabled' };
    const interaction = resolveMessageInteractionContext({
      messageInfo,
      botJid,
      botJidCandidates,
    });
    const explicitQuestion = hasExplicitQuestionIntent(text);
    const hasKeywordTrigger = hasBotKeywordTrigger(text);
    const triggerKind = interaction.isReplyToBot ? 'reply_to_bot' : interaction.mentionsBot ? 'mention_bot' : hasKeywordTrigger ? 'bot_keyword' : explicitQuestion ? 'explicit_question' : null;

    const hasDirectBotInteraction = interaction.isReplyToBot || interaction.mentionsBot;
    if (!canHandleGroupConversation({ extractedText, mediaEntries }) && !hasDirectBotInteraction) {
      return { handled: false, reason: 'group_not_eligible' };
    }
    if (!triggerKind) {
      return { handled: false, reason: 'group_no_trigger' };
    }

    const groupPrompt = resolveGroupPromptFromMessage({
      extractedText,
      triggerKind,
      commandPrefix,
    });
    if (!normalizeText(groupPrompt)) return { handled: false, reason: 'group_empty_text' };

    const shouldBypassCooldown = triggerKind === 'mention_bot';
    if (!shouldBypassCooldown && shouldSkipForGroupCooldown({ chatId: remoteJid, senderJid })) {
      incrementMetric('cooldown_skip');
      return { handled: false, reason: 'group_cooldown' };
    }

    const answer = await responderPerguntaGlobal(groupPrompt, {
      commandPrefix,
      isGroupMessage: true,
      remoteJid,
      senderJid,
      toolCommandExecutor,
      resolveToolSecurityContext,
    });
    if (!answer) return { handled: false, reason: 'empty_answer' };

    const suppressReply = answer?.suppressReply === true;
    const answerText = String(answer?.text || '').trim();
    if (!answerText && !suppressReply) return { handled: false, reason: 'empty_answer' };

    incrementMetric('intent_detected');
    incrementMetric('group_reply_sent');
    if (answer.intentType === 'fallback') {
      incrementMetric('fallback_used');
    } else {
      incrementMetric('suggestion_sent');
    }

    markGroupCooldown({ chatId: remoteJid, senderJid });
    setConversationSessionIntent({
      chatId: remoteJid,
      userId: senderJid,
      scope: 'group',
      intent: buildIntentFromAnswer(answer),
      ttlMs: SESSION_TTL_MS,
    });

    return {
      handled: true,
      text: suppressReply ? '' : answerText,
      reason: 'group_conversation',
      metadata: {
        trigger_kind: triggerKind,
        intent_type: answer.intentType || null,
        module_key: answer.moduleKey || null,
        command_name: answer.commandName || null,
        suppress_reply: suppressReply,
      },
    };
  }

  if (!PRIVATE_ENABLED) return { handled: false, reason: 'private_disabled' };

  const privatePrompt = resolvePrivatePromptFromMessage({
    extractedText,
    mediaEntries,
    commandPrefix,
  });

  const scopeContext = buildScopeContext({ isGroupMessage, remoteJid, senderJid });
  const previousSession = getConversationSession({
    ...scopeContext,
    ttlMs: SESSION_TTL_MS,
  });
  const previousIntent = previousSession?.lastIntent || null;
  const forcedCommandName = privatePrompt.triggerKind === 'private_text' && isLikelyFollowUp(privatePrompt.prompt) && previousIntent?.commandName ? previousIntent.commandName : null;

  let answer = null;
  try {
    answer = await responderPerguntaGlobal(privatePrompt.prompt, {
      commandPrefix,
      isGroupMessage: false,
      previousCommandName: previousIntent?.commandName || null,
      forceCommandName: forcedCommandName,
      remoteJid,
      senderJid,
      toolCommandExecutor,
      resolveToolSecurityContext,
    });
  } catch (error) {
    logger.warn('Falha ao gerar resposta conversacional privada.', {
      action: 'private_conversation_answer_failed',
      remoteJid,
      senderJid,
      error: error?.message,
    });
  }

  const fallbackText = `Recebi sua mensagem. Para manter o foco do sistema, posso te orientar em comandos do bot.\n\n` + `Use ${commandPrefix}menu para ver as opcoes ou me diga o que voce quer fazer (ex.: sticker, play, ranking, cat).`;
  const suppressReply = answer?.suppressReply === true;
  const explicitAnswerText = String(answer?.text || '').trim();
  const answerText = suppressReply ? explicitAnswerText : explicitAnswerText || fallbackText;

  appendConversationSessionMessage({
    ...scopeContext,
    role: 'user',
    text: privatePrompt.originalText,
    ttlMs: SESSION_TTL_MS,
    historyLimit: SESSION_HISTORY_LIMIT,
  });
  if (answerText) {
    appendConversationSessionMessage({
      ...scopeContext,
      role: 'assistant',
      text: answerText,
      ttlMs: SESSION_TTL_MS,
      historyLimit: SESSION_HISTORY_LIMIT,
      metadata: {
        intentType: answer?.intentType || null,
        moduleKey: answer?.moduleKey || null,
        commandName: answer?.commandName || null,
        triggerKind: privatePrompt.triggerKind,
      },
    });
  }
  setConversationSessionIntent({
    ...scopeContext,
    intent: buildIntentFromAnswer(answer),
    ttlMs: SESSION_TTL_MS,
  });

  incrementMetric('intent_detected');
  incrementMetric('private_reply_sent');
  if (answer?.intentType === 'fallback') {
    incrementMetric('fallback_used');
  } else {
    incrementMetric('suggestion_sent');
  }

  return {
    handled: true,
    text: answerText,
    reason: 'private_conversation',
    metadata: {
      trigger_kind: forcedCommandName ? 'private_followup' : privatePrompt.triggerKind,
      intent_type: answer?.intentType || null,
      module_key: answer?.moduleKey || null,
      command_name: answer?.commandName || null,
      suppress_reply: suppressReply,
    },
  };
};

export const getConversationRouterMetrics = () => ({
  ...routerMetrics,
  group_cooldown_entries: groupCooldownCache.size,
});

export const resetConversationRouterMetricsForTests = () => {
  for (const key of Object.keys(routerMetrics)) {
    routerMetrics[key] = 0;
  }
  groupCooldownCache.clear();
};

export const isConversationRouterEnabled = () => ROUTER_ENABLED;

export const getConversationRouterConfig = () => ({
  enabled: ROUTER_ENABLED,
  privateEnabled: PRIVATE_ENABLED,
  groupEnabled: GROUP_ENABLED,
  groupCooldownMs: GROUP_COOLDOWN_MS,
  sessionTtlMs: SESSION_TTL_MS,
  sessionHistoryLimit: SESSION_HISTORY_LIMIT,
});
