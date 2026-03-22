export const createConversationMiddleware = ({ logger, resolveSenderAdminForContext, resolveSenderOwnerForContext, resolveHasGoogleLoginForContext, isUserAdmin, isAdminSenderAsync, resolveCanonicalSenderJidForContext, isWhatsAppUserLinkedToGoogleWebAccount, WHATSAPP_COMMAND_REQUIRES_GOOGLE_LOGIN, ensureUserHasGoogleWebLoginForCommand, executeMessageCommandRoute, isAdminCommand, runCommand, sendReply, routeConversationMessage, stopMessagePipeline, conversationAutoReplyEnabled = true }) => {
  const resolveToolSecurityContextForConversation = async (ctx) => {
    if (ctx.memo.toolSecurityContext) return ctx.memo.toolSecurityContext;

    let isSenderAdmin = false;
    if (ctx.isGroupMessage) {
      try {
        isSenderAdmin = typeof resolveSenderAdminForContext === 'function' ? await resolveSenderAdminForContext(ctx, { mode: 'identity' }) : await isUserAdmin(ctx.remoteJid, ctx.senderIdentity);
      } catch (error) {
        logger.warn('Falha ao resolver permissao admin para tool execution.', {
          action: 'tool_security_admin_check_failed',
          remoteJid: ctx.remoteJid,
          senderJid: ctx.senderJid,
          error: error?.message,
        });
      }
    }

    let isSenderOwner = false;
    try {
      isSenderOwner = typeof resolveSenderOwnerForContext === 'function' ? await resolveSenderOwnerForContext(ctx) : await isAdminSenderAsync(ctx.senderIdentity);
    } catch (error) {
      logger.warn('Falha ao resolver admin principal para tool execution.', {
        action: 'tool_security_owner_check_failed',
        remoteJid: ctx.remoteJid,
        senderJid: ctx.senderJid,
        error: error?.message,
      });
    }

    let hasGoogleLogin;
    if (!ctx.isMessageFromBot && WHATSAPP_COMMAND_REQUIRES_GOOGLE_LOGIN) {
      try {
        hasGoogleLogin = typeof resolveHasGoogleLoginForContext === 'function' ? await resolveHasGoogleLoginForContext(ctx) : undefined;
        if (hasGoogleLogin === undefined) {
          const canonicalSenderJid = await resolveCanonicalSenderJidForContext(ctx);
          if (canonicalSenderJid) {
            hasGoogleLogin = await isWhatsAppUserLinkedToGoogleWebAccount({
              ownerJid: canonicalSenderJid,
            });
          }
        }
      } catch (error) {
        logger.warn('Falha ao resolver estado de login para tool execution.', {
          action: 'tool_security_google_login_check_failed',
          remoteJid: ctx.remoteJid,
          senderJid: ctx.senderJid,
          error: error?.message,
        });
      }
    }

    ctx.memo.toolSecurityContext = {
      isGroupMessage: ctx.isGroupMessage,
      isSenderAdmin,
      isSenderOwner,
      hasGoogleLogin,
    };
    return ctx.memo.toolSecurityContext;
  };

  const executeToolCommandFromConversation = async (ctx, { commandName, args = [], text = '' } = {}) => {
    const normalizedCommand = String(commandName || '')
      .trim()
      .toLowerCase();
    if (!normalizedCommand) {
      return {
        ok: false,
        alreadyResponded: false,
        text: 'Comando invalido na tool call.',
      };
    }

    if (!ctx.isMessageFromBot && WHATSAPP_COMMAND_REQUIRES_GOOGLE_LOGIN) {
      let knownHasGoogleLogin;
      if (typeof ctx.memo.toolSecurityContext?.hasGoogleLogin === 'boolean') {
        knownHasGoogleLogin = ctx.memo.toolSecurityContext.hasGoogleLogin;
      } else if (typeof resolveHasGoogleLoginForContext === 'function') {
        try {
          knownHasGoogleLogin = await resolveHasGoogleLoginForContext(ctx);
        } catch {
          knownHasGoogleLogin = undefined;
        }
      }

      const authCheck = await ensureUserHasGoogleWebLoginForCommand({
        sock: ctx.sock,
        messageInfo: ctx.messageInfo,
        senderJid: ctx.senderJid,
        remoteJid: ctx.remoteJid,
        expirationMessage: ctx.expirationMessage,
        commandPrefix: ctx.commandPrefix,
        knownHasGoogleLogin,
      });
      if (!authCheck.allowed) {
        return {
          ok: false,
          alreadyResponded: true,
          text: '',
          errorCode: 'auth_required',
        };
      }
    }

    const commandExecution = await executeMessageCommandRoute({
      command: normalizedCommand,
      args: Array.isArray(args) ? args : [],
      text: String(text || ''),
      isAdminCommandRoute: isAdminCommand(normalizedCommand),
      sock: ctx.sock,
      remoteJid: ctx.remoteJid,
      messageInfo: ctx.messageInfo,
      expirationMessage: ctx.expirationMessage,
      senderJid: ctx.senderJid,
      senderName: ctx.senderName,
      senderIdentity: ctx.senderIdentity,
      botJid: ctx.botJid,
      isGroupMessage: ctx.isGroupMessage,
      commandPrefix: ctx.commandPrefix,
      runCommand,
      sendReply,
    });

    const commandRoute = commandExecution?.commandRoute || 'unknown';
    const commandResult = commandExecution?.commandResult || { ok: false };
    return {
      ok: commandResult.ok && commandRoute !== 'unknown',
      commandRoute,
      alreadyResponded: commandResult.ok || commandRoute === 'unknown',
      text: '',
      error: commandResult?.error || null,
    };
  };

  return async (ctx) => {
    if (!conversationAutoReplyEnabled) return null;
    if (ctx.isCommandMessage || ctx.isMessageFromBot || !ctx.isNotifyUpsert) return null;

    try {
      const conversationResult = await routeConversationMessage({
        messageInfo: ctx.messageInfo,
        extractedText: ctx.extractedText,
        isCommandMessage: ctx.isCommandMessage,
        mediaEntries: ctx.mediaEntries,
        isGroupMessage: ctx.isGroupMessage,
        remoteJid: ctx.remoteJid,
        senderJid: ctx.senderJid,
        botJid: ctx.botJid,
        botJidCandidates: ctx.botJidCandidates,
        commandPrefix: ctx.commandPrefix,
        toolCommandExecutor: (payload) => executeToolCommandFromConversation(ctx, payload),
        resolveToolSecurityContext: () => resolveToolSecurityContextForConversation(ctx),
      });

      if (!conversationResult?.handled) return null;

      if (conversationResult?.text) {
        await sendReply(ctx.sock, ctx.remoteJid, ctx.messageInfo, ctx.expirationMessage, {
          text: conversationResult.text,
        });
      }

      return stopMessagePipeline(ctx, 'conversation_reply', {
        conversation_router: true,
        conversation_reason: conversationResult.reason || null,
        conversation_trigger_kind: conversationResult?.metadata?.trigger_kind || null,
        conversation_intent_type: conversationResult?.metadata?.intent_type || null,
        conversation_module_key: conversationResult?.metadata?.module_key || null,
        conversation_command_name: conversationResult?.metadata?.command_name || null,
        conversation_suppress_reply: Boolean(conversationResult?.metadata?.suppress_reply),
      });
    } catch (error) {
      logger.warn('Falha ao processar rota conversacional global.', {
        action: 'conversation_router_failed',
        remoteJid: ctx.remoteJid,
        senderJid: ctx.senderJid,
        isGroupMessage: ctx.isGroupMessage,
        error: error?.message,
      });
    }

    return null;
  };
};
