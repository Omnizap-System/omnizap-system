export const createPreProcessingMiddlewares = ({ executeQuery, TABLES, isStatusJid, stopMessagePipeline, handleAntiLink, ensureCommandPrefixForContext, resolveCaptchaByMessage, maybeHandleStartLoginMessage, mergeAnalysisMetadata, ensureGroupConfigForContext, resolveStickerFocusState, resolveStickerFocusMessageClassification, resolveSenderAdminForContext, isUserAdmin, canSendMessageInStickerFocus, registerMessageUsageInStickerFocus, shouldSendStickerFocusWarning, sendReply, formatStickerFocusRuleLabel, formatRemainingMinutesLabel, logger }) => {
  const touchSenderLastSeenMiddleware = async (ctx) => {
    if (!ctx.senderJid || isStatusJid(ctx.remoteJid)) return;

    void executeQuery(`UPDATE ${TABLES.RPG_PLAYER} SET updated_at = CURRENT_TIMESTAMP WHERE jid = ?`, [ctx.senderJid]).catch(() => {});
    void executeQuery(`UPDATE web_google_user SET last_seen_at = CURRENT_TIMESTAMP WHERE owner_jid = ?`, [ctx.senderJid]).catch(() => {});
  };

  const ignoreUnprocessableMessageMiddleware = async (ctx) => {
    const isStatusBroadcast = ctx.remoteJid === 'status@broadcast';
    const isStubMessage = typeof ctx.messageInfo?.messageStubType === 'number';
    const isProtocolMessage = Boolean(ctx.messageInfo?.message?.protocolMessage);
    const isMissingMessage = !ctx.messageInfo?.message;

    if (!isStatusBroadcast && !isStubMessage && !isProtocolMessage && !isMissingMessage) {
      return null;
    }

    return stopMessagePipeline(ctx, 'ignored_unprocessable', {
      ignored_reason: isStatusBroadcast ? 'status_broadcast' : isStubMessage ? 'stub_message' : isProtocolMessage ? 'protocol_message' : 'missing_message_node',
    });
  };

  const applyGroupPolicyMiddleware = async (ctx) => {
    if (!ctx.isGroupMessage) return null;

    const shouldSkip = await handleAntiLink({
      sock: ctx.sock,
      messageInfo: ctx.messageInfo,
      extractedText: ctx.extractedText,
      remoteJid: ctx.remoteJid,
      senderJid: ctx.senderJid,
      senderIdentity: ctx.senderIdentity,
      botJid: ctx.botJid,
    });
    if (shouldSkip) {
      return stopMessagePipeline(ctx, 'blocked_antilink', {
        blocked_by: 'anti_link',
      });
    }

    await ensureCommandPrefixForContext(ctx);
    return null;
  };

  const resolveCaptchaMiddleware = async (ctx) => {
    if (!ctx.isGroupMessage || ctx.isMessageFromBot) return;

    await resolveCaptchaByMessage({
      groupId: ctx.remoteJid,
      senderJid: ctx.senderJid,
      senderIdentity: ctx.senderIdentity,
      messageKey: ctx.key,
      messageInfo: ctx.messageInfo,
      extractedText: ctx.extractedText,
    });
  };

  const handleStartLoginTriggerMiddleware = async (ctx) => {
    if (!ctx.isNotifyUpsert) return null;

    const handledStartLogin = await maybeHandleStartLoginMessage({
      sock: ctx.sock,
      messageInfo: ctx.messageInfo,
      extractedText: ctx.extractedText,
      senderName: ctx.senderName,
      senderJid: ctx.senderJid,
      remoteJid: ctx.remoteJid,
      expirationMessage: ctx.expirationMessage,
      isMessageFromBot: ctx.isMessageFromBot,
      isGroupMessage: ctx.isGroupMessage,
    });

    if (!handledStartLogin) return null;
    return stopMessagePipeline(ctx, 'handled_start_login', {
      flow: 'whatsapp_google_login',
    });
  };

  const detectCommandIntentMiddleware = async (ctx) => {
    ctx.hasCommandPrefix = ctx.extractedText.startsWith(ctx.commandPrefix);
    ctx.isCommandMessage = ctx.hasCommandPrefix && ctx.isNotifyUpsert;

    ctx.analysisPayload.isCommand = ctx.isCommandMessage;
    ctx.analysisPayload.commandPrefix = ctx.commandPrefix;

    if (ctx.hasCommandPrefix && !ctx.isNotifyUpsert) {
      mergeAnalysisMetadata(ctx.analysisPayload, {
        command_suppressed_reason: 'non_notify_upsert',
      });
    }
  };

  const applyStickerFocusMiddleware = async (ctx) => {
    if (!ctx.isGroupMessage || ctx.isCommandMessage || ctx.isMessageFromBot) return null;

    const activeGroupConfig = await ensureGroupConfigForContext(ctx);
    const stickerFocusState = resolveStickerFocusState(activeGroupConfig);
    if (!stickerFocusState.enabled) return null;

    const messageClassification = resolveStickerFocusMessageClassification({
      messageInfo: ctx.messageInfo,
      extractedText: ctx.extractedText,
      mediaEntries: ctx.mediaEntries,
    });
    if (!messageClassification.isThrottleCandidate) return null;

    const senderIsAdmin = typeof resolveSenderAdminForContext === 'function' ? await resolveSenderAdminForContext(ctx, { mode: 'jid' }) : await isUserAdmin(ctx.remoteJid, ctx.senderJid);
    if (senderIsAdmin || stickerFocusState.isChatWindowOpen) return null;

    const messageGate = canSendMessageInStickerFocus({
      groupId: ctx.remoteJid,
      senderJid: ctx.senderJid,
      messageCooldownMs: stickerFocusState.messageCooldownMs,
      messageAllowanceCount: stickerFocusState.messageAllowanceCount,
    });

    if (!messageGate.allowed) {
      ctx.analysisPayload.processingResult = 'blocked_sticker_focus_message';
      mergeAnalysisMetadata(ctx.analysisPayload, {
        blocked_by: 'sticker_focus_mode',
        sticker_focus_message_type: messageClassification.messageType,
        sticker_focus_message_allowance_count: stickerFocusState.messageAllowanceCount,
        sticker_focus_message_cooldown_minutes: stickerFocusState.messageCooldownMinutes,
        sticker_focus_remaining_minutes: formatRemainingMinutesLabel(messageGate.remainingMs),
        sticker_focus_alert_only: true,
      });

      if (shouldSendStickerFocusWarning({ groupId: ctx.remoteJid, senderJid: ctx.senderJid })) {
        try {
          await sendReply(ctx.sock, ctx.remoteJid, ctx.messageInfo, ctx.expirationMessage, {
            text: '🖼️ *Modo Sticker ativo!*\n\n' + 'Este chat está focado em *stickers automáticos*.\n' + '👉 Envie apenas *imagens* ou *vídeos* para gerar stickers,\n' + '👉 Ou compartilhe *stickers* normalmente.\n\n' + '⏳ *Texto e áudio estão temporariamente limitados*.\n' + `Janela atual: *${formatStickerFocusRuleLabel(stickerFocusState)}*\n` + `Tente novamente em ~${formatRemainingMinutesLabel(messageGate.remainingMs)}.\n\n` + `💡 Um admin pode liberar com: *${ctx.commandPrefix}chatwindow on*`,
          });
        } catch (error) {
          logger.warn('Falha ao enviar aviso de sticker focus.', {
            action: 'sticker_focus_warning_failed',
            groupId: ctx.remoteJid,
            senderJid: ctx.senderJid,
            error: error?.message,
          });
        }
      }

      return stopMessagePipeline(ctx);
    }

    registerMessageUsageInStickerFocus({
      groupId: ctx.remoteJid,
      senderJid: ctx.senderJid,
      messageCooldownMs: stickerFocusState.messageCooldownMs,
      messageAllowanceCount: stickerFocusState.messageAllowanceCount,
    });

    return null;
  };

  return {
    touchSenderLastSeenMiddleware,
    ignoreUnprocessableMessageMiddleware,
    applyGroupPolicyMiddleware,
    resolveCaptchaMiddleware,
    handleStartLoginTriggerMiddleware,
    detectCommandIntentMiddleware,
    applyStickerFocusMiddleware,
  };
};
