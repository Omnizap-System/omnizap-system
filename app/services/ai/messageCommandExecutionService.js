import { handleMenuCommand } from '../../modules/menuModule/menus.js';
import { resolveMenuCommandName } from '../../modules/menuModule/menuConfigRuntime.js';
import { handleAdminCommand } from '../../modules/adminModule/groupCommandHandlers.js';
import { buildGlobalUnknownCommandSuggestion } from './globalModuleAiHelpService.js';
import { processSticker } from '../../modules/stickerModule/stickerCommand.js';
import { resolveStickerCommandName } from '../../modules/stickerModule/stickerConfigRuntime.js';
import { processBlinkingTextSticker, processTextSticker } from '../../modules/stickerModule/stickerTextCommand.js';
import { handlePlayCommand, handlePlayVidCommand } from '../../modules/playModule/playCommand.js';
import { resolvePlayCommandName } from '../../modules/playModule/playConfigRuntime.js';
import { handleRankingCommand } from '../../modules/statsModule/rankingCommand.js';
import { handleGlobalRankingCommand } from '../../modules/statsModule/globalRankingCommand.js';
import { resolveStatsCommandName } from '../../modules/statsModule/statsConfigRuntime.js';
import { handlePingCommand } from '../../modules/systemMetricsModule/pingCommand.js';
import { resolveSystemMetricsCommandName } from '../../modules/systemMetricsModule/systemMetricsConfigRuntime.js';
import { handleCatCommand, handleCatImageCommand, handleCatPromptCommand } from '../../modules/aiModule/catCommand.js';
import { resolveAiCommandName } from '../../modules/aiModule/aiConfigRuntime.js';
import { handleQuoteCommand } from '../../modules/quoteModule/quoteCommand.js';
import { resolveQuoteCommandName } from '../../modules/quoteModule/quoteConfigRuntime.js';
import { handleStickerConvertCommand } from '../../modules/stickerModule/stickerConvertCommand.js';
import { handleWaifuPicsCommand, getWaifuPicsUsageText } from '../../modules/waifuPicsModule/waifuPicsCommand.js';
import { resolveWaifuPicsCommandName } from '../../modules/waifuPicsModule/waifuPicsConfigRuntime.js';
import { handlePackCommand } from '../../modules/stickerPackModule/stickerPackCommandHandlers.js';
import { resolveStickerPackCommandName } from '../../modules/stickerPackModule/stickerPackConfigRuntime.js';
import { handleUserCommand } from '../../modules/userModule/userCommand.js';
import { resolveUserCommandName } from '../../modules/userModule/userConfigRuntime.js';
import { handleDiceCommand } from '../../modules/gameModule/diceCommand.js';
import { resolveGameCommandName } from '../../modules/gameModule/gameConfigRuntime.js';
import { handleTikTokCommand } from '../../modules/tiktokModule/tiktokCommand.js';
import { resolveTikTokCommandName } from '../../modules/tiktokModule/tiktokConfigRuntime.js';
import { handleRpgPokemonCommand } from '../../modules/rpgPokemonModule/rpgPokemonCommand.js';
import { resolveRpgPokemonCommandName } from '../../modules/rpgPokemonModule/rpgPokemonConfigRuntime.js';
import logger from '#logger';

const normalizeCommand = (value) =>
  String(value || '')
    .trim()
    .toLowerCase();

const NON_ADMIN_COMMAND_RESOLVERS = [resolveMenuCommandName, resolveStickerCommandName, resolveStickerPackCommandName, resolvePlayCommandName, resolveTikTokCommandName, resolveAiCommandName, resolveQuoteCommandName, resolveWaifuPicsCommandName, resolveStatsCommandName, resolveSystemMetricsCommandName, resolveGameCommandName, resolveUserCommandName, resolveRpgPokemonCommandName];

const LEGACY_NON_ADMIN_ROUTE_BY_CANONICAL = {
  ia: 'cat',
  iaimagem: 'catimg',
  pergunteia: 'catprompt',
  tocar: 'play',
  tocarvideo: 'playvid',
  citar: 'quote',
  classificacao: 'ranking',
  classificacaoglobal: 'rankingglobal',
  figurinha: 'sticker',
  paraimagem: 'toimg',
  figurinhatexto: 'stickertext',
  figurinhatextobranco: 'stickertextwhite',
  figurinhatextopisca: 'stickertextblink',
  pacote: 'pack',
  statusbot: 'ping',
  baixartiktok: 'tiktok',
  perfil: 'user',
  waifu: 'wp',
  waifunsfw: 'wpnsfw',
  waifuajuda: 'wppicshelp',
  pokemon: 'rpg',
};

export const resolveNonAdminCommandName = (command) => {
  const normalized = normalizeCommand(command);
  if (!normalized) return null;

  for (const resolver of NON_ADMIN_COMMAND_RESOLVERS) {
    const canonical = resolver(normalized);
    if (canonical) return canonical;
  }

  return null;
};

export const isKnownNonAdminCommand = (command) => Boolean(resolveNonAdminCommandName(command));

export const executeMessageCommandRoute = async ({ command, args = [], text = '', isAdminCommandRoute = false, sock, remoteJid, messageInfo, expirationMessage, senderJid, senderName, senderIdentity, botJid, isGroupMessage, commandPrefix = '/', runCommand, sendReply } = {}) => {
  if (typeof runCommand !== 'function') {
    throw new Error('executeMessageCommandRoute: runCommand e obrigatorio');
  }
  if (typeof sendReply !== 'function') {
    throw new Error('executeMessageCommandRoute: sendReply e obrigatorio');
  }

  const normalizedCommand = normalizeCommand(command);
  const canonicalNonAdminCommand = resolveNonAdminCommandName(normalizedCommand);
  const resolvedCommand = canonicalNonAdminCommand || normalizedCommand;
  const routeCommand = LEGACY_NON_ADMIN_ROUTE_BY_CANONICAL[resolvedCommand] || resolvedCommand;
  const safeArgs = Array.isArray(args) ? args : [];
  const safeText = String(text || '');

  let commandResult;
  let commandRoute = resolvedCommand || 'unknown';

  switch (routeCommand) {
    case 'menu':
      commandResult = await runCommand('menu', () => handleMenuCommand(sock, remoteJid, messageInfo, expirationMessage, senderName, commandPrefix, safeArgs));
      break;
    case 'sticker':
      commandResult = await runCommand('sticker', () => processSticker(sock, messageInfo, senderJid, remoteJid, expirationMessage, senderName, safeArgs.join(' '), { commandPrefix }));
      break;
    case 'pack':
      commandResult = await runCommand('pack', () =>
        handlePackCommand({
          sock,
          remoteJid,
          messageInfo,
          expirationMessage,
          senderJid,
          senderName,
          text: safeText,
          commandPrefix,
        }),
      );
      break;
    case 'toimg':
      commandResult = await runCommand('toimg', () =>
        handleStickerConvertCommand({
          sock,
          remoteJid,
          messageInfo,
          expirationMessage,
          senderJid,
          commandPrefix,
        }),
      );
      break;
    case 'play':
      commandResult = await runCommand('play', () => handlePlayCommand(sock, remoteJid, messageInfo, expirationMessage, safeText, commandPrefix));
      break;
    case 'playvid':
      commandResult = await runCommand('playvid', () => handlePlayVidCommand(sock, remoteJid, messageInfo, expirationMessage, safeText, commandPrefix));
      break;
    case 'tiktok':
      commandResult = await runCommand('tiktok', () =>
        handleTikTokCommand({
          sock,
          remoteJid,
          messageInfo,
          expirationMessage,
          text: safeText,
          commandPrefix,
        }),
      );
      break;
    case 'cat':
      commandResult = await runCommand('cat', () =>
        handleCatCommand({
          sock,
          remoteJid,
          messageInfo,
          expirationMessage,
          senderJid,
          text: safeText,
          commandPrefix,
        }),
      );
      break;
    case 'catimg':
      commandResult = await runCommand('catimg', () =>
        handleCatImageCommand({
          sock,
          remoteJid,
          messageInfo,
          expirationMessage,
          senderJid,
          text: safeText,
          commandPrefix,
        }),
      );
      break;
    case 'catprompt':
      commandResult = await runCommand('catprompt', () =>
        handleCatPromptCommand({
          sock,
          remoteJid,
          messageInfo,
          expirationMessage,
          senderJid,
          text: safeText,
          commandPrefix,
        }),
      );
      break;
    case 'quote':
      commandResult = await runCommand('quote', () =>
        handleQuoteCommand({
          sock,
          remoteJid,
          messageInfo,
          expirationMessage,
          senderJid,
          senderName,
          text: safeText,
          commandPrefix,
        }),
      );
      break;
    case 'wp':
      commandResult = await runCommand('waifupics', () =>
        handleWaifuPicsCommand({
          sock,
          remoteJid,
          messageInfo,
          expirationMessage,
          senderJid,
          text: safeText,
          type: 'sfw',
          commandPrefix,
        }),
      );
      break;
    case 'wpnsfw':
      commandResult = await runCommand('waifupicsnsfw', () =>
        handleWaifuPicsCommand({
          sock,
          remoteJid,
          messageInfo,
          expirationMessage,
          senderJid,
          text: safeText,
          type: 'nsfw',
          commandPrefix,
        }),
      );
      break;
    case 'wppicshelp':
      commandResult = await runCommand('wppicshelp', () =>
        sendReply(sock, remoteJid, messageInfo, expirationMessage, {
          text: getWaifuPicsUsageText(commandPrefix),
        }),
      );
      break;
    case 'stickertext':
      commandResult = await runCommand('stickertext', () =>
        processTextSticker({
          sock,
          messageInfo,
          remoteJid,
          senderJid,
          senderName,
          text: safeText,
          extraText: 'PackZoeira',
          expirationMessage,
          color: 'black',
          commandPrefix,
          commandName: 'stickertext',
        }),
      );
      break;
    case 'stickertextwhite':
      commandResult = await runCommand('stickertextwhite', () =>
        processTextSticker({
          sock,
          messageInfo,
          remoteJid,
          senderJid,
          senderName,
          text: safeText,
          extraText: 'PackZoeira',
          expirationMessage,
          color: 'white',
          commandPrefix,
          commandName: 'stickertextwhite',
        }),
      );
      break;
    case 'stickertextblink':
      commandResult = await runCommand('stickertextblink', () =>
        processBlinkingTextSticker({
          sock,
          messageInfo,
          remoteJid,
          senderJid,
          senderName,
          text: safeText,
          extraText: 'PackZoeira',
          expirationMessage,
          color: 'white',
          commandPrefix,
          commandName: 'stickertextblink',
        }),
      );
      break;
    case 'ranking':
      commandResult = await runCommand('ranking', () =>
        handleRankingCommand({
          sock,
          remoteJid,
          messageInfo,
          expirationMessage,
          isGroupMessage,
        }),
      );
      break;
    case 'rankingglobal':
      commandResult = await runCommand('rankingglobal', () =>
        handleGlobalRankingCommand({
          sock,
          remoteJid,
          messageInfo,
          expirationMessage,
          isGroupMessage,
        }),
      );
      break;
    case 'ping':
      commandResult = await runCommand('ping', () => handlePingCommand({ sock, remoteJid, messageInfo, expirationMessage }));
      break;
    case 'dado':
      commandResult = await runCommand('dado', () =>
        handleDiceCommand({
          sock,
          remoteJid,
          messageInfo,
          expirationMessage,
          args: safeArgs,
          commandPrefix,
        }),
      );
      break;
    case 'user':
      commandResult = await runCommand('user', () =>
        handleUserCommand({
          sock,
          remoteJid,
          messageInfo,
          expirationMessage,
          senderJid,
          senderIdentity,
          args: safeArgs,
          isGroupMessage,
          commandPrefix,
        }),
      );
      break;
    case 'rpg':
      commandResult = await runCommand('rpg', () =>
        handleRpgPokemonCommand({
          sock,
          remoteJid,
          messageInfo,
          expirationMessage,
          senderJid,
          senderIdentity,
          args: safeArgs,
          commandPrefix,
        }),
      );
      break;
    default: {
      if (isAdminCommandRoute) {
        commandRoute = 'admin';
        commandResult = await runCommand('admin', () =>
          handleAdminCommand({
            command: normalizedCommand,
            args: safeArgs,
            text: safeText,
            sock,
            messageInfo,
            remoteJid,
            senderJid,
            botJid,
            isGroupMessage,
            expirationMessage,
            commandPrefix,
          }),
        );
        break;
      }

      commandRoute = 'unknown';
      logger.info(`Comando desconhecido recebido: ${normalizedCommand}`);
      const globalSuggestion = buildGlobalUnknownCommandSuggestion(normalizedCommand, {
        commandPrefix,
      });
      commandResult = await runCommand('unknown', () =>
        sendReply(sock, remoteJid, messageInfo, expirationMessage, {
          text: globalSuggestion ? `❌ *Comando não reconhecido*\n\nO comando *${normalizedCommand}* não está configurado ou ainda não existe.\n\n${globalSuggestion}\n\nℹ️ *Dica:*  \nDigite *${commandPrefix}menu* para ver a lista geral de comandos.\n\n🚧 *Fase Beta*  \nO omnizap ainda está em desenvolvimento e novos comandos estão sendo adicionados constantemente.` : `❌ *Comando não reconhecido*\n\nO comando *${normalizedCommand}* não está configurado ou ainda não existe.\n\nℹ️ *Dica:*  \nDigite *${commandPrefix}menu* para ver a lista de comandos disponíveis.\n\n🚧 *Fase Beta*  \nO omnizap ainda está em desenvolvimento e novos comandos estão sendo adicionados constantemente.`,
        }),
      );
      break;
    }
  }

  return {
    commandRoute,
    commandResult,
  };
};
