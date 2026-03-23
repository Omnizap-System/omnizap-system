import test from 'node:test';
import assert from 'node:assert/strict';

import { createPreProcessingMiddlewares } from './messagePipeline/preProcessingMiddlewares.js';
import { createCommandMiddleware } from './messagePipeline/commandMiddleware.js';

const createContext = (overrides = {}) => ({
  sock: {},
  messageInfo: { key: { id: 'msg-1' }, message: { conversation: '/menu' } },
  key: { id: 'msg-1' },
  remoteJid: '120363111111111111@g.us',
  isGroupMessage: true,
  extractedText: '/menu',
  senderJid: '5511999999999@s.whatsapp.net',
  senderIdentity: '5511999999999@s.whatsapp.net',
  senderName: 'Tester',
  expirationMessage: 0,
  botJid: '5511888888888@s.whatsapp.net',
  isMessageFromBot: false,
  commandPrefix: '/',
  mediaEntries: [],
  upsertType: 'notify',
  isNotifyUpsert: true,
  sessionId: 'session-a',
  ownerSessionId: null,
  isCommandMessage: false,
  hasCommandPrefix: false,
  pipelineStopped: false,
  analysisPayload: {
    processingResult: 'processed',
    errorCode: null,
    metadata: {},
    isCommand: false,
    commandPrefix: '/',
    commandName: null,
    commandArgsCount: 0,
    commandKnown: null,
  },
  ...overrides,
});

const createStopMessagePipeline =
  () =>
  (ctx, processingResult = '', metadataPatch = null) => {
    if (processingResult) {
      ctx.analysisPayload.processingResult = processingResult;
    }
    if (metadataPatch) {
      ctx.analysisPayload.metadata = {
        ...(ctx.analysisPayload.metadata || {}),
        ...(metadataPatch || {}),
      };
    }
    ctx.pipelineStopped = true;
    return { stop: true };
  };

const mergeAnalysisMetadata = (analysisPayload, patch) => {
  analysisPayload.metadata = {
    ...(analysisPayload.metadata || {}),
    ...(patch || {}),
  };
};

const createSharedCommandDedupe = () => {
  const cache = new Map();
  return {
    isDuplicateCommandExecution: (chatId, messageId) => cache.has(`${chatId}:${messageId}`),
    markCommandExecution: (chatId, messageId) => {
      cache.set(`${chatId}:${messageId}`, true);
    },
  };
};

const createCommandMiddlewareForTest = ({ executeRouteSpy, dedupe }) =>
  createCommandMiddleware({
    isAdminCommand: () => false,
    isKnownNonAdminCommand: () => true,
    isDuplicateCommandExecution: dedupe.isDuplicateCommandExecution,
    markCommandExecution: dedupe.markCommandExecution,
    MESSAGE_COMMAND_DEDUPE_TTL_MS: 120_000,
    stopMessagePipeline: createStopMessagePipeline(),
    WHATSAPP_COMMAND_REQUIRES_GOOGLE_LOGIN: false,
    resolveCanonicalSenderJidForContext: async () => '5511999999999@s.whatsapp.net',
    ensureUserHasGoogleWebLoginForCommand: async () => ({ allowed: true }),
    SITE_LOGIN_URL: 'https://omnizap.shop/login',
    COMMAND_REACT_EMOJI: '',
    sendAndStore: async () => {},
    executeMessageCommandRoute: async (payload) => {
      executeRouteSpy.push(payload);
      return {
        commandRoute: payload.command || 'menu',
        commandResult: { ok: true },
      };
    },
    runCommand: async (_label, handler) => {
      try {
        await handler();
        return { ok: true };
      } catch (error) {
        return { ok: false, error };
      }
    },
    sendReply: async () => {},
    registerGlobalHelpCommandExecution: async () => {},
    logger: { warn: () => {} },
    normalizeAnalysisErrorCode: () => 'processing_error',
    resolveSenderAdminForContext: async () => false,
    isUserAdmin: async () => false,
    buildCommandErrorHelpText: async () => '',
    mergeAnalysisMetadata,
  });

test('messageProcessingPipeline: com owner enforcement ativo, apenas owner executa comando no grupo', async () => {
  const pre = createPreProcessingMiddlewares({
    executeQuery: async () => [],
    TABLES: { RPG_PLAYER: 'rpg_player' },
    isStatusJid: () => false,
    stopMessagePipeline: createStopMessagePipeline(),
    handleAntiLink: async () => false,
    ensureCommandPrefixForContext: async () => '/',
    resolveCaptchaByMessage: async () => {},
    maybeHandleStartLoginMessage: async () => false,
    mergeAnalysisMetadata,
    ensureGroupConfigForContext: async () => ({}),
    resolveStickerFocusState: () => ({ enabled: false }),
    resolveStickerFocusMessageClassification: () => ({ isThrottleCandidate: false }),
    resolveGroupOwnerForContext: async (ctx) => {
      ctx.ownerSessionId = 'session-a';
      return { ownerSessionId: 'session-a', assignmentVersion: 7 };
    },
    ownerEnforcementMode: 'enforce',
    primarySessionId: 'session-a',
    resolveSenderAdminForContext: async () => false,
    isUserAdmin: async () => false,
    canSendMessageInStickerFocus: () => ({ allowed: true, remainingMs: 0 }),
    registerMessageUsageInStickerFocus: () => {},
    shouldSendStickerFocusWarning: () => false,
    sendReply: async () => {},
    formatStickerFocusRuleLabel: () => '',
    formatRemainingMinutesLabel: () => 1,
    logger: { warn: () => {}, info: () => {} },
  });

  const executeRouteSpy = [];
  const dedupe = createSharedCommandDedupe();
  const commandMiddleware = createCommandMiddlewareForTest({ executeRouteSpy, dedupe });

  const ownerCtx = createContext({
    sessionId: 'session-a',
    key: { id: 'msg-shared' },
    messageInfo: { key: { id: 'msg-shared' }, message: { conversation: '/menu' } },
  });
  const nonOwnerCtx = createContext({
    sessionId: 'session-b',
    key: { id: 'msg-shared' },
    messageInfo: { key: { id: 'msg-shared' }, message: { conversation: '/menu' } },
  });

  await pre.enforceGroupOwnerMiddleware(ownerCtx);
  await pre.detectCommandIntentMiddleware(ownerCtx);
  await commandMiddleware(ownerCtx);

  const blockedResult = await pre.enforceGroupOwnerMiddleware(nonOwnerCtx);
  assert.deepEqual(blockedResult, { stop: true });
  await pre.detectCommandIntentMiddleware(nonOwnerCtx);
  if (!nonOwnerCtx.pipelineStopped) {
    await commandMiddleware(nonOwnerCtx);
  }

  assert.equal(executeRouteSpy.length, 1);
  assert.equal(ownerCtx.analysisPayload.processingResult, 'command_executed');
  assert.equal(nonOwnerCtx.analysisPayload.processingResult, 'blocked_group_owner_enforcement');
});

test('messageProcessingPipeline: dedupe de comando por chat+message impede execução dupla em duas sessões', async () => {
  const executeRouteSpy = [];
  const dedupe = createSharedCommandDedupe();
  const commandMiddleware = createCommandMiddlewareForTest({ executeRouteSpy, dedupe });

  const firstCtx = createContext({
    sessionId: 'session-a',
    isCommandMessage: true,
    hasCommandPrefix: true,
    key: { id: 'dup-msg-1' },
    messageInfo: { key: { id: 'dup-msg-1' }, message: { conversation: '/menu' } },
  });
  const secondCtx = createContext({
    sessionId: 'session-b',
    isCommandMessage: true,
    hasCommandPrefix: true,
    key: { id: 'dup-msg-1' },
    messageInfo: { key: { id: 'dup-msg-1' }, message: { conversation: '/menu' } },
  });

  await commandMiddleware(firstCtx);
  await commandMiddleware(secondCtx);

  assert.equal(executeRouteSpy.length, 1);
  assert.equal(firstCtx.analysisPayload.processingResult, 'command_executed');
  assert.equal(secondCtx.analysisPayload.processingResult, 'duplicate_command_ignored');
});
