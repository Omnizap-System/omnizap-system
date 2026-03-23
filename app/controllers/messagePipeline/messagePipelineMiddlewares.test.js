import test from 'node:test';
import assert from 'node:assert/strict';

import { createPreProcessingMiddlewares } from './preProcessingMiddlewares.js';
import { createConversationMiddleware } from './conversationMiddleware.js';
import { createCommandMiddleware } from './commandMiddleware.js';
import { createPostProcessingMiddleware } from './postProcessingMiddleware.js';

const createBaseContext = (overrides = {}) => ({
  sock: {},
  messageInfo: { message: { conversation: 'oi' }, key: { id: 'msg-1' } },
  key: { id: 'msg-1' },
  remoteJid: '120363111111111111@g.us',
  isGroupMessage: true,
  extractedText: '/menu',
  senderJid: '5511999999999@s.whatsapp.net',
  senderIdentity: '5511999999999@s.whatsapp.net',
  senderName: 'Tester',
  expirationMessage: 0,
  botJid: '5511888888888@s.whatsapp.net',
  botJidCandidates: ['5511888888888@s.whatsapp.net'],
  isMessageFromBot: false,
  commandPrefix: '/',
  groupConfig: null,
  groupConfigLoaded: false,
  mediaEntries: [],
  upsertType: 'notify',
  isNotifyUpsert: true,
  sessionId: 'session-default',
  ownerSessionId: null,
  isCommandMessage: false,
  hasCommandPrefix: false,
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
  pipelineStopped: false,
  memo: Object.create(null),
  ...overrides,
});

const createStopSpy = () => {
  const calls = [];
  const stopMessagePipeline = (ctx, processingResult = '', metadataPatch = null) => {
    calls.push({ ctx, processingResult, metadataPatch });
    if (processingResult) {
      ctx.analysisPayload.processingResult = processingResult;
    }
    if (metadataPatch) {
      ctx.analysisPayload.metadata = {
        ...ctx.analysisPayload.metadata,
        ...metadataPatch,
      };
    }
    ctx.pipelineStopped = true;
    return { stop: true };
  };

  return { stopMessagePipeline, calls };
};

test('pre-processing ignora mensagem nao processavel', async () => {
  const stopSpy = createStopSpy();
  const middlewares = createPreProcessingMiddlewares({
    executeQuery: async () => [],
    TABLES: { RPG_PLAYER: 'rpg_player' },
    isStatusJid: () => false,
    stopMessagePipeline: stopSpy.stopMessagePipeline,
    handleAntiLink: async () => false,
    ensureCommandPrefixForContext: async () => '/',
    resolveCaptchaByMessage: async () => {},
    maybeHandleStartLoginMessage: async () => false,
    mergeAnalysisMetadata: () => {},
    ensureGroupConfigForContext: async () => ({}),
    resolveStickerFocusState: () => ({ enabled: false }),
    resolveStickerFocusMessageClassification: () => ({ isThrottleCandidate: false }),
    isUserAdmin: async () => false,
    canSendMessageInStickerFocus: () => ({ allowed: true, remainingMs: 0 }),
    registerMessageUsageInStickerFocus: () => {},
    shouldSendStickerFocusWarning: () => false,
    sendReply: async () => {},
    formatStickerFocusRuleLabel: () => '',
    formatRemainingMinutesLabel: () => 1,
    logger: { warn: () => {} },
  });

  const ctx = createBaseContext({ remoteJid: 'status@broadcast' });
  const result = await middlewares.ignoreUnprocessableMessageMiddleware(ctx);

  assert.deepEqual(result, { stop: true });
  assert.equal(stopSpy.calls.length, 1);
  assert.equal(stopSpy.calls[0].processingResult, 'ignored_unprocessable');
  assert.equal(ctx.analysisPayload.metadata.ignored_reason, 'status_broadcast');
});

test('pre-processing bloqueia por anti-link', async () => {
  const stopSpy = createStopSpy();
  let prefixResolved = false;

  const middlewares = createPreProcessingMiddlewares({
    executeQuery: async () => [],
    TABLES: { RPG_PLAYER: 'rpg_player' },
    isStatusJid: () => false,
    stopMessagePipeline: stopSpy.stopMessagePipeline,
    handleAntiLink: async () => true,
    ensureCommandPrefixForContext: async () => {
      prefixResolved = true;
      return '/';
    },
    resolveCaptchaByMessage: async () => {},
    maybeHandleStartLoginMessage: async () => false,
    mergeAnalysisMetadata: () => {},
    ensureGroupConfigForContext: async () => ({}),
    resolveStickerFocusState: () => ({ enabled: false }),
    resolveStickerFocusMessageClassification: () => ({ isThrottleCandidate: false }),
    isUserAdmin: async () => false,
    canSendMessageInStickerFocus: () => ({ allowed: true, remainingMs: 0 }),
    registerMessageUsageInStickerFocus: () => {},
    shouldSendStickerFocusWarning: () => false,
    sendReply: async () => {},
    formatStickerFocusRuleLabel: () => '',
    formatRemainingMinutesLabel: () => 1,
    logger: { warn: () => {} },
  });

  const result = await middlewares.applyGroupPolicyMiddleware(createBaseContext());

  assert.deepEqual(result, { stop: true });
  assert.equal(stopSpy.calls[0].processingResult, 'blocked_antilink');
  assert.equal(prefixResolved, false);
});

test('pre-processing trata trigger de iniciar login', async () => {
  const stopSpy = createStopSpy();
  const middlewares = createPreProcessingMiddlewares({
    executeQuery: async () => [],
    TABLES: { RPG_PLAYER: 'rpg_player' },
    isStatusJid: () => false,
    stopMessagePipeline: stopSpy.stopMessagePipeline,
    handleAntiLink: async () => false,
    ensureCommandPrefixForContext: async () => '/',
    resolveCaptchaByMessage: async () => {},
    maybeHandleStartLoginMessage: async () => true,
    mergeAnalysisMetadata: () => {},
    ensureGroupConfigForContext: async () => ({}),
    resolveStickerFocusState: () => ({ enabled: false }),
    resolveStickerFocusMessageClassification: () => ({ isThrottleCandidate: false }),
    isUserAdmin: async () => false,
    canSendMessageInStickerFocus: () => ({ allowed: true, remainingMs: 0 }),
    registerMessageUsageInStickerFocus: () => {},
    shouldSendStickerFocusWarning: () => false,
    sendReply: async () => {},
    formatStickerFocusRuleLabel: () => '',
    formatRemainingMinutesLabel: () => 1,
    logger: { warn: () => {} },
  });

  const result = await middlewares.handleStartLoginTriggerMiddleware(createBaseContext());

  assert.deepEqual(result, { stop: true });
  assert.equal(stopSpy.calls[0].processingResult, 'handled_start_login');
  assert.equal(stopSpy.calls[0].metadataPatch.flow, 'whatsapp_google_login');
});

test('pre-processing owner gate bloqueia sessao nao-owner em modo enforce', async () => {
  const stopSpy = createStopSpy();

  const middlewares = createPreProcessingMiddlewares({
    executeQuery: async () => [],
    TABLES: { RPG_PLAYER: 'rpg_player' },
    isStatusJid: () => false,
    stopMessagePipeline: stopSpy.stopMessagePipeline,
    handleAntiLink: async () => false,
    ensureCommandPrefixForContext: async () => '/',
    resolveCaptchaByMessage: async () => {},
    maybeHandleStartLoginMessage: async () => false,
    mergeAnalysisMetadata: (analysisPayload, patch) => {
      analysisPayload.metadata = {
        ...(analysisPayload.metadata || {}),
        ...(patch || {}),
      };
    },
    ensureGroupConfigForContext: async () => ({}),
    resolveStickerFocusState: () => ({ enabled: false }),
    resolveStickerFocusMessageClassification: () => ({ isThrottleCandidate: false }),
    resolveGroupOwnerForContext: async (ctx) => {
      ctx.ownerSessionId = 'session-owner';
      return { ownerSessionId: 'session-owner' };
    },
    ownerEnforcementMode: 'enforce',
    primarySessionId: 'session-primary',
    isUserAdmin: async () => false,
    canSendMessageInStickerFocus: () => ({ allowed: true, remainingMs: 0 }),
    registerMessageUsageInStickerFocus: () => {},
    shouldSendStickerFocusWarning: () => false,
    sendReply: async () => {},
    formatStickerFocusRuleLabel: () => '',
    formatRemainingMinutesLabel: () => 1,
    logger: { warn: () => {}, info: () => {} },
  });

  const ctx = createBaseContext({
    sessionId: 'session-worker',
    isGroupMessage: true,
    remoteJid: '120363111111111111@g.us',
  });
  const result = await middlewares.enforceGroupOwnerMiddleware(ctx);

  assert.deepEqual(result, { stop: true });
  assert.equal(stopSpy.calls.length, 1);
  assert.equal(stopSpy.calls[0].processingResult, 'blocked_group_owner_enforcement');
  assert.equal(ctx.analysisPayload.metadata.owner_enforcement_result, 'blocked_non_owner');
  assert.equal(ctx.analysisPayload.metadata.owner_session_id, 'session-owner');
});

test('pre-processing owner gate apenas loga em modo shadow para sessao nao-owner', async () => {
  const stopSpy = createStopSpy();
  const infoLogs = [];

  const middlewares = createPreProcessingMiddlewares({
    executeQuery: async () => [],
    TABLES: { RPG_PLAYER: 'rpg_player' },
    isStatusJid: () => false,
    stopMessagePipeline: stopSpy.stopMessagePipeline,
    handleAntiLink: async () => false,
    ensureCommandPrefixForContext: async () => '/',
    resolveCaptchaByMessage: async () => {},
    maybeHandleStartLoginMessage: async () => false,
    mergeAnalysisMetadata: (analysisPayload, patch) => {
      analysisPayload.metadata = {
        ...(analysisPayload.metadata || {}),
        ...(patch || {}),
      };
    },
    ensureGroupConfigForContext: async () => ({}),
    resolveStickerFocusState: () => ({ enabled: false }),
    resolveStickerFocusMessageClassification: () => ({ isThrottleCandidate: false }),
    resolveGroupOwnerForContext: async (ctx) => {
      ctx.ownerSessionId = 'session-owner';
      return { ownerSessionId: 'session-owner' };
    },
    ownerEnforcementMode: 'shadow',
    primarySessionId: 'session-primary',
    isUserAdmin: async () => false,
    canSendMessageInStickerFocus: () => ({ allowed: true, remainingMs: 0 }),
    registerMessageUsageInStickerFocus: () => {},
    shouldSendStickerFocusWarning: () => false,
    sendReply: async () => {},
    formatStickerFocusRuleLabel: () => '',
    formatRemainingMinutesLabel: () => 1,
    logger: { warn: () => {}, info: (msg, payload) => infoLogs.push({ msg, payload }) },
  });

  const ctx = createBaseContext({
    sessionId: 'session-worker',
    isGroupMessage: true,
  });
  const result = await middlewares.enforceGroupOwnerMiddleware(ctx);

  assert.equal(result, null);
  assert.equal(stopSpy.calls.length, 0);
  assert.equal(ctx.pipelineStopped, false);
  assert.equal(ctx.analysisPayload.metadata.owner_enforcement_result, 'shadow_non_owner');
  assert.equal(infoLogs.length, 1);
});

test('conversation middleware responde e interrompe pipeline', async () => {
  const stopSpy = createStopSpy();
  const replies = [];

  const middleware = createConversationMiddleware({
    logger: { warn: () => {} },
    isUserAdmin: async () => false,
    isAdminSenderAsync: async () => false,
    resolveCanonicalSenderJidForContext: async () => '5511999999999@s.whatsapp.net',
    isWhatsAppUserLinkedToGoogleWebAccount: async () => true,
    WHATSAPP_COMMAND_REQUIRES_GOOGLE_LOGIN: true,
    ensureUserHasGoogleWebLoginForCommand: async () => ({ allowed: true }),
    executeMessageCommandRoute: async () => ({ commandRoute: 'menu', commandResult: { ok: true } }),
    isAdminCommand: () => false,
    runCommand: async () => ({ ok: true }),
    sendReply: async (...args) => {
      replies.push(args);
    },
    routeConversationMessage: async () => ({
      handled: true,
      text: 'Resposta IA',
      reason: 'intent_match',
      metadata: {
        trigger_kind: 'mention',
        intent_type: 'help',
        module_key: 'global',
        command_name: 'menu',
        suppress_reply: false,
      },
    }),
    stopMessagePipeline: stopSpy.stopMessagePipeline,
  });

  const result = await middleware(createBaseContext({ isCommandMessage: false, isNotifyUpsert: true, isMessageFromBot: false }));

  assert.deepEqual(result, { stop: true });
  assert.equal(replies.length, 1);
  assert.equal(stopSpy.calls.length, 1);
  assert.equal(stopSpy.calls[0].processingResult, 'conversation_reply');
});

test('conversation middleware resolve hasGoogleLogin=true quando usuario esta vinculado', async () => {
  const googleLinkCalls = [];
  let capturedToolSecurity = null;

  const middleware = createConversationMiddleware({
    logger: { warn: () => {} },
    isUserAdmin: async () => false,
    isAdminSenderAsync: async () => false,
    resolveCanonicalSenderJidForContext: async () => '5511999999999@s.whatsapp.net',
    isWhatsAppUserLinkedToGoogleWebAccount: async (payload) => {
      googleLinkCalls.push(payload);
      return true;
    },
    WHATSAPP_COMMAND_REQUIRES_GOOGLE_LOGIN: true,
    ensureUserHasGoogleWebLoginForCommand: async () => ({ allowed: true }),
    executeMessageCommandRoute: async () => ({ commandRoute: 'menu', commandResult: { ok: true } }),
    isAdminCommand: () => false,
    runCommand: async () => ({ ok: true }),
    sendReply: async () => {},
    routeConversationMessage: async ({ resolveToolSecurityContext }) => {
      capturedToolSecurity = await resolveToolSecurityContext();
      return { handled: false };
    },
    stopMessagePipeline: () => ({ stop: true }),
  });

  const result = await middleware(createBaseContext({ isCommandMessage: false, isNotifyUpsert: true, isMessageFromBot: false }));

  assert.equal(result, null);
  assert.deepEqual(googleLinkCalls, [{ ownerJid: '5511999999999@s.whatsapp.net' }]);
  assert.equal(capturedToolSecurity?.hasGoogleLogin, true);
});

test('conversation middleware resolve hasGoogleLogin=false quando usuario nao esta vinculado', async () => {
  const googleLinkCalls = [];
  let capturedToolSecurity = null;

  const middleware = createConversationMiddleware({
    logger: { warn: () => {} },
    isUserAdmin: async () => false,
    isAdminSenderAsync: async () => false,
    resolveCanonicalSenderJidForContext: async () => '5511999999999@s.whatsapp.net',
    isWhatsAppUserLinkedToGoogleWebAccount: async (payload) => {
      googleLinkCalls.push(payload);
      return false;
    },
    WHATSAPP_COMMAND_REQUIRES_GOOGLE_LOGIN: true,
    ensureUserHasGoogleWebLoginForCommand: async () => ({ allowed: true }),
    executeMessageCommandRoute: async () => ({ commandRoute: 'menu', commandResult: { ok: true } }),
    isAdminCommand: () => false,
    runCommand: async () => ({ ok: true }),
    sendReply: async () => {},
    routeConversationMessage: async ({ resolveToolSecurityContext }) => {
      capturedToolSecurity = await resolveToolSecurityContext();
      return { handled: false };
    },
    stopMessagePipeline: () => ({ stop: true }),
  });

  const result = await middleware(createBaseContext({ isCommandMessage: false, isNotifyUpsert: true, isMessageFromBot: false }));

  assert.equal(result, null);
  assert.deepEqual(googleLinkCalls, [{ ownerJid: '5511999999999@s.whatsapp.net' }]);
  assert.equal(capturedToolSecurity?.hasGoogleLogin, false);
});

test('conversation middleware mantem hasGoogleLogin indefinido quando consulta de vinculo falha', async () => {
  const warnCalls = [];
  const googleLinkCalls = [];
  let capturedToolSecurity = null;

  const middleware = createConversationMiddleware({
    logger: {
      warn: (...args) => {
        warnCalls.push(args);
      },
    },
    isUserAdmin: async () => false,
    isAdminSenderAsync: async () => false,
    resolveCanonicalSenderJidForContext: async () => '5511999999999@s.whatsapp.net',
    isWhatsAppUserLinkedToGoogleWebAccount: async (payload) => {
      googleLinkCalls.push(payload);
      throw new Error('lookup failed');
    },
    WHATSAPP_COMMAND_REQUIRES_GOOGLE_LOGIN: true,
    ensureUserHasGoogleWebLoginForCommand: async () => ({ allowed: true }),
    executeMessageCommandRoute: async () => ({ commandRoute: 'menu', commandResult: { ok: true } }),
    isAdminCommand: () => false,
    runCommand: async () => ({ ok: true }),
    sendReply: async () => {},
    routeConversationMessage: async ({ resolveToolSecurityContext }) => {
      capturedToolSecurity = await resolveToolSecurityContext();
      return { handled: false };
    },
    stopMessagePipeline: () => ({ stop: true }),
  });

  const result = await middleware(createBaseContext({ isCommandMessage: false, isNotifyUpsert: true, isMessageFromBot: false }));

  assert.equal(result, null);
  assert.deepEqual(googleLinkCalls, [{ ownerJid: '5511999999999@s.whatsapp.net' }]);
  assert.equal(capturedToolSecurity?.hasGoogleLogin, undefined);
  assert.equal(warnCalls.length, 1);
  assert.equal(warnCalls[0][1]?.action, 'tool_security_google_login_check_failed');
});

test('conversation middleware reaproveita contexto de seguranca e evita lookup de login google duplicado', async () => {
  let resolveHasGoogleLoginCalls = 0;
  let ensureAuthCalls = 0;
  let knownHasGoogleLoginInEnsure;
  let toolSecurityReadCount = 0;

  const middleware = createConversationMiddleware({
    logger: { warn: () => {} },
    resolveSenderAdminForContext: async () => false,
    resolveSenderOwnerForContext: async () => false,
    resolveHasGoogleLoginForContext: async () => {
      resolveHasGoogleLoginCalls += 1;
      return false;
    },
    isUserAdmin: async () => false,
    isAdminSenderAsync: async () => false,
    resolveCanonicalSenderJidForContext: async () => '5511999999999@s.whatsapp.net',
    isWhatsAppUserLinkedToGoogleWebAccount: async () => {
      throw new Error('fallback should not be used');
    },
    WHATSAPP_COMMAND_REQUIRES_GOOGLE_LOGIN: true,
    ensureUserHasGoogleWebLoginForCommand: async ({ knownHasGoogleLogin }) => {
      ensureAuthCalls += 1;
      knownHasGoogleLoginInEnsure = knownHasGoogleLogin;
      return { allowed: true };
    },
    executeMessageCommandRoute: async () => ({ commandRoute: 'menu', commandResult: { ok: true } }),
    isAdminCommand: () => false,
    runCommand: async () => ({ ok: true }),
    sendReply: async () => {},
    routeConversationMessage: async ({ resolveToolSecurityContext, toolCommandExecutor }) => {
      await resolveToolSecurityContext();
      toolSecurityReadCount += 1;
      await resolveToolSecurityContext();
      toolSecurityReadCount += 1;
      await toolCommandExecutor({ commandName: 'menu', args: [], text: '' });
      return { handled: false };
    },
    stopMessagePipeline: () => ({ stop: true }),
  });

  const result = await middleware(createBaseContext({ isCommandMessage: false, isNotifyUpsert: true, isMessageFromBot: false }));

  assert.equal(result, null);
  assert.equal(toolSecurityReadCount, 2);
  assert.equal(resolveHasGoogleLoginCalls, 1);
  assert.equal(ensureAuthCalls, 1);
  assert.equal(knownHasGoogleLoginInEnsure, false);
});

test('command middleware ignora comando duplicado', async () => {
  const stopSpy = createStopSpy();
  let markCalled = false;

  const middleware = createCommandMiddleware({
    isAdminCommand: () => false,
    isKnownNonAdminCommand: () => true,
    isDuplicateCommandExecution: () => true,
    markCommandExecution: () => {
      markCalled = true;
    },
    MESSAGE_COMMAND_DEDUPE_TTL_MS: 120000,
    stopMessagePipeline: stopSpy.stopMessagePipeline,
    WHATSAPP_COMMAND_REQUIRES_GOOGLE_LOGIN: true,
    resolveCanonicalSenderJidForContext: async () => '5511999999999@s.whatsapp.net',
    ensureUserHasGoogleWebLoginForCommand: async () => ({ allowed: true }),
    SITE_LOGIN_URL: 'https://example.com/login',
    COMMAND_REACT_EMOJI: '🤖',
    sendAndStore: async () => {},
    executeMessageCommandRoute: async () => ({ commandRoute: 'menu', commandResult: { ok: true } }),
    runCommand: async () => ({ ok: true }),
    sendReply: async () => {},
    registerGlobalHelpCommandExecution: async () => {},
    logger: { warn: () => {} },
    normalizeAnalysisErrorCode: () => 'normalized_error',
    isUserAdmin: async () => false,
    buildCommandErrorHelpText: async () => '',
    mergeAnalysisMetadata: () => {},
  });

  const ctx = createBaseContext({ isCommandMessage: true, extractedText: '/menu' });
  const result = await middleware(ctx);

  assert.deepEqual(result, { stop: true });
  assert.equal(markCalled, false);
  assert.equal(stopSpy.calls[0].processingResult, 'duplicate_command_ignored');
});

test('command middleware bloqueia comando sem autenticacao google', async () => {
  const stopSpy = createStopSpy();

  const middleware = createCommandMiddleware({
    isAdminCommand: () => false,
    isKnownNonAdminCommand: () => true,
    isDuplicateCommandExecution: () => false,
    markCommandExecution: () => {},
    MESSAGE_COMMAND_DEDUPE_TTL_MS: 120000,
    stopMessagePipeline: stopSpy.stopMessagePipeline,
    WHATSAPP_COMMAND_REQUIRES_GOOGLE_LOGIN: true,
    resolveCanonicalSenderJidForContext: async () => '5511999999999@s.whatsapp.net',
    ensureUserHasGoogleWebLoginForCommand: async () => ({ allowed: false, loginUrl: 'https://example.com/login' }),
    SITE_LOGIN_URL: 'https://example.com/login-fallback',
    COMMAND_REACT_EMOJI: '🤖',
    sendAndStore: async () => {},
    executeMessageCommandRoute: async () => ({ commandRoute: 'menu', commandResult: { ok: true } }),
    runCommand: async () => ({ ok: true }),
    sendReply: async () => {},
    registerGlobalHelpCommandExecution: async () => {},
    logger: { warn: () => {} },
    normalizeAnalysisErrorCode: () => 'normalized_error',
    isUserAdmin: async () => false,
    buildCommandErrorHelpText: async () => '',
    mergeAnalysisMetadata: () => {},
  });

  const result = await middleware(createBaseContext({ isCommandMessage: true, extractedText: '/menu' }));

  assert.deepEqual(result, { stop: true });
  assert.equal(stopSpy.calls[0].processingResult, 'auth_required');
  assert.equal(stopSpy.calls[0].metadataPatch.auth_required_for_command, 'menu');
  assert.equal(stopSpy.calls[0].metadataPatch.auth_login_url, 'https://example.com/login');
});

test('command middleware marca erro e envia ajuda quando comando falha', async () => {
  const sentReplies = [];
  const runLabels = [];

  const middleware = createCommandMiddleware({
    isAdminCommand: () => false,
    isKnownNonAdminCommand: () => true,
    isDuplicateCommandExecution: () => false,
    markCommandExecution: () => {},
    MESSAGE_COMMAND_DEDUPE_TTL_MS: 120000,
    stopMessagePipeline: () => ({ stop: true }),
    WHATSAPP_COMMAND_REQUIRES_GOOGLE_LOGIN: false,
    resolveCanonicalSenderJidForContext: async () => '5511999999999@s.whatsapp.net',
    ensureUserHasGoogleWebLoginForCommand: async () => ({ allowed: true }),
    SITE_LOGIN_URL: 'https://example.com/login',
    COMMAND_REACT_EMOJI: '',
    sendAndStore: async () => {},
    executeMessageCommandRoute: async () => ({
      commandRoute: 'menu',
      commandResult: { ok: false, error: { code: 'test_error' } },
    }),
    runCommand: async (label, handler) => {
      runLabels.push(label);
      await handler();
      return { ok: true };
    },
    sendReply: async (...args) => {
      sentReplies.push(args);
    },
    registerGlobalHelpCommandExecution: async () => {},
    logger: { warn: () => {} },
    normalizeAnalysisErrorCode: () => 'test_error_code',
    isUserAdmin: async () => false,
    buildCommandErrorHelpText: async () => 'Use /menu para ajuda.',
    mergeAnalysisMetadata: (analysis, patch) => {
      analysis.metadata = { ...analysis.metadata, ...patch };
    },
  });

  const ctx = createBaseContext({ isCommandMessage: true, extractedText: '/menu' });
  await middleware(ctx);

  assert.equal(ctx.analysisPayload.processingResult, 'command_error');
  assert.equal(ctx.analysisPayload.errorCode, 'test_error_code');
  assert.deepEqual(runLabels, ['command-error-help']);
  assert.equal(sentReplies.length, 1);
});

test('post-processing aciona autosticker quando midia suportada', async () => {
  const runLabels = [];

  const middleware = createPostProcessingMiddleware({
    runCommand: async (label, handler) => {
      runLabels.push(label);
      await handler();
      return { ok: true };
    },
    maybeCaptureIncomingSticker: async () => {},
    extractSupportedStickerMediaDetails: () => ({ mediaType: 'image' }),
    ensureGroupConfigForContext: async () => ({ autoStickerEnabled: true }),
    mergeAnalysisMetadata: (analysis, patch) => {
      analysis.metadata = { ...analysis.metadata, ...patch };
    },
    processSticker: async () => {},
    normalizeAnalysisErrorCode: () => 'sticker_error',
  });

  const ctx = createBaseContext({
    isGroupMessage: true,
    isCommandMessage: false,
    isMessageFromBot: false,
    analysisPayload: {
      processingResult: 'processed',
      errorCode: null,
      metadata: {},
    },
  });

  await middleware(ctx);

  assert.deepEqual(runLabels, ['pack-capture', 'autosticker']);
  assert.equal(ctx.analysisPayload.processingResult, 'autosticker_triggered');
  assert.equal(ctx.analysisPayload.metadata.auto_sticker_media_type, 'image');
});
