export const createCommandMiddleware = ({ isAdminCommand, isKnownNonAdminCommand, isDuplicateCommandExecution, markCommandExecution, MESSAGE_COMMAND_DEDUPE_TTL_MS, stopMessagePipeline, WHATSAPP_COMMAND_REQUIRES_GOOGLE_LOGIN, resolveCanonicalSenderJidForContext, ensureUserHasGoogleWebLoginForCommand, SITE_LOGIN_URL, COMMAND_REACT_EMOJI, sendAndStore, executeMessageCommandRoute, runCommand, sendReply, registerGlobalHelpCommandExecution, logger, normalizeAnalysisErrorCode, resolveSenderAdminForContext, isUserAdmin, buildCommandErrorHelpText, mergeAnalysisMetadata }) => {
  return async (ctx) => {
    if (!ctx.isCommandMessage) return null;

    const commandBody = ctx.extractedText.substring(ctx.commandPrefix.length);
    const match = commandBody.match(/^(\S+)([\s\S]*)$/);
    const command = match ? match[1].toLowerCase() : '';
    const rawArgs = match && match[2] !== undefined ? match[2].trim() : '';
    const args = rawArgs ? rawArgs.split(/\s+/) : [];
    const text = match && match[2] !== undefined ? match[2] : '';
    const isAdminCommandRoute = isAdminCommand(command);
    const isKnownCommand = isKnownNonAdminCommand(command) || isAdminCommandRoute;

    ctx.analysisPayload.commandName = command || null;
    ctx.analysisPayload.commandArgsCount = args.length;
    ctx.analysisPayload.commandKnown = isKnownCommand;

    if (isDuplicateCommandExecution(ctx.remoteJid, ctx.key?.id)) {
      return stopMessagePipeline(ctx, 'duplicate_command_ignored', {
        dedupe_ttl_ms: MESSAGE_COMMAND_DEDUPE_TTL_MS,
      });
    }
    markCommandExecution(ctx.remoteJid, ctx.key?.id);

    if (!ctx.isMessageFromBot && WHATSAPP_COMMAND_REQUIRES_GOOGLE_LOGIN) {
      const canonicalSenderJid = await resolveCanonicalSenderJidForContext(ctx);
      const authCheck = await ensureUserHasGoogleWebLoginForCommand({
        sock: ctx.sock,
        messageInfo: ctx.messageInfo,
        senderJid: ctx.senderJid,
        remoteJid: ctx.remoteJid,
        expirationMessage: ctx.expirationMessage,
        commandPrefix: ctx.commandPrefix,
        canonicalUserId: canonicalSenderJid,
      });

      if (!authCheck.allowed) {
        return stopMessagePipeline(ctx, 'auth_required', {
          auth_required_for_command: command || null,
          auth_login_url: authCheck.loginUrl || SITE_LOGIN_URL,
        });
      }
    }

    if (COMMAND_REACT_EMOJI?.trim() && ctx?.key) {
      sendAndStore(ctx.sock, ctx.remoteJid, {
        react: {
          text: COMMAND_REACT_EMOJI,
          key: ctx.key,
        },
      }).catch((error) => {
        logger.warn('Falha ao enviar reação de comando', {
          error: error?.message,
          jid: ctx.remoteJid,
          messageId: ctx.key?.id,
        });
      });
    }

    const execution = await executeMessageCommandRoute({
      command,
      args,
      text,
      isAdminCommandRoute,
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
    const commandResult = execution?.commandResult || { ok: false };
    const commandRoute = execution?.commandRoute || 'unknown';
    if (commandRoute === 'unknown') {
      ctx.analysisPayload.processingResult = 'unknown_command';
    }

    mergeAnalysisMetadata(ctx.analysisPayload, {
      command_route: commandRoute,
    });

    if (ctx.analysisPayload.processingResult === 'processed') {
      ctx.analysisPayload.processingResult = commandResult.ok ? 'command_executed' : 'command_error';
    }

    if (commandResult.ok && commandRoute !== 'unknown') {
      try {
        await registerGlobalHelpCommandExecution({
          chatId: ctx.remoteJid,
          userId: ctx.senderJid,
          isGroupMessage: ctx.isGroupMessage,
          executedCommand: command,
        });
      } catch (error) {
        logger.warn('Falha ao registrar feedback de sugestao global.', {
          action: 'global_help_feedback_register_failed',
          command,
          commandRoute,
          remoteJid: ctx.remoteJid,
          senderJid: ctx.senderJid,
          error: error?.message,
        });
      }
    }

    if (!commandResult.ok) {
      ctx.analysisPayload.errorCode = normalizeAnalysisErrorCode(commandResult.error);
      let senderIsAdminForHelp = false;
      if (ctx.isGroupMessage) {
        try {
          senderIsAdminForHelp = typeof resolveSenderAdminForContext === 'function' ? await resolveSenderAdminForContext(ctx, { mode: 'identity' }) : await isUserAdmin(ctx.remoteJid, ctx.senderIdentity);
        } catch (error) {
          logger.warn('Falha ao resolver permissao de admin para ajuda de comando.', {
            action: 'command_error_help_admin_check_failed',
            command,
            remoteJid: ctx.remoteJid,
            senderJid: ctx.senderJid,
            error: error?.message,
          });
        }
      }

      const commandErrorHelpText = await buildCommandErrorHelpText({
        command,
        commandRoute,
        commandPrefix: ctx.commandPrefix,
        isGroupMessage: ctx.isGroupMessage,
        isSenderAdmin: senderIsAdminForHelp,
      });

      const fallbackErrorText = commandErrorHelpText ? `❌ Houve um erro ao processar *${ctx.commandPrefix}${command}*.\n\n${commandErrorHelpText}` : `❌ Houve um erro ao processar *${ctx.commandPrefix}${command}*.\n\nTente novamente ou use *${ctx.commandPrefix}menu* para validar o formato de uso.`;

      await runCommand('command-error-help', () =>
        sendReply(ctx.sock, ctx.remoteJid, ctx.messageInfo, ctx.expirationMessage, {
          text: fallbackErrorText,
        }),
      );
    }

    return null;
  };
};
