import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import { handleMenuAdmCommand } from '../menuModule/menus.js';
import { downloadMediaMessage, getJidServer, isLidJid, isSameJidUser, isWhatsAppJid, LID_USER_JID_SERVERS, normalizeJid, WHATSAPP_USER_JID_SERVERS } from '../../config/index.js';
import { isUserAdmin, createGroup, acceptGroupInvite, getGroupInfo, getGroupRequestParticipantsList, updateGroupAddMode, updateGroupSettings, updateGroupParticipants, leaveGroup, getGroupInviteCode, revokeGroupInviteCode, getGroupInfoFromInvite, updateGroupRequestParticipants, updateGroupSubject, updateGroupDescription, toggleEphemeral } from '../../config/index.js';
import groupConfigStore from '../../store/groupConfigStore.js';
import premiumUserStore from '../../store/premiumUserStore.js';
import logger from '#logger';
import { KNOWN_NETWORKS, purgeRecentMessagesForSenderCandidates } from '../../utils/antiLink/antiLinkModule.js';
import { getNewsStatusForGroup, startNewsBroadcastForGroup, stopNewsBroadcastForGroup } from '../../services/messaging/newsBroadcastService.js';
import { sendAndStore } from '../../services/messaging/messagePersistenceService.js';
import { clearCaptchasForGroup } from '../../services/messaging/captchaService.js';
import { getAdminJid, isAdminSenderAsync } from '../../config/index.js';
import { extractUserIdInfo, resolveUserId } from '../../config/index.js';
import { DEFAULT_STICKER_FOCUS_CHAT_WINDOW_MINUTES, DEFAULT_STICKER_FOCUS_MESSAGE_ALLOWANCE, DEFAULT_STICKER_FOCUS_MESSAGE_COOLDOWN_MINUTES, MAX_STICKER_FOCUS_CHAT_WINDOW_MINUTES, MAX_STICKER_FOCUS_MESSAGE_ALLOWANCE, MAX_STICKER_FOCUS_MESSAGE_COOLDOWN_MINUTES, MIN_STICKER_FOCUS_CHAT_WINDOW_MINUTES, MIN_STICKER_FOCUS_MESSAGE_ALLOWANCE, MIN_STICKER_FOCUS_MESSAGE_COOLDOWN_MINUTES, clampStickerFocusChatWindowMinutes, clampStickerFocusMessageAllowance, clampStickerFocusMessageCooldownMinutes, resolveStickerFocusState } from '../../services/sticker/stickerFocusService.js';
import { getAdminTextConfig, getAdminUsageText, isAdminCommandName, resolveAdminCommandName } from './adminConfigRuntime.js';
import { explicarComando, gerarFaqAutomatica, responderPergunta, startAdminAiHelpScheduler } from './adminAiHelpService.js';
import { addGroupWarning, clearGroupWarnings, countGroupWarnings, listGroupWarnings } from './groupWarningRepository.js';
const OWNER_JID = getAdminJid();
const DEFAULT_COMMAND_PREFIX = process.env.COMMAND_PREFIX || '/';
const ADMIN_TEXTS = getAdminTextConfig();
const GROUP_ONLY_COMMAND_MESSAGE = ADMIN_TEXTS.group_only_command_message;
const NO_PERMISSION_COMMAND_MESSAGE = ADMIN_TEXTS.no_permission_command_message;
const OWNER_ONLY_COMMAND_MESSAGE = ADMIN_TEXTS.owner_only_command_message;
const USER_JID_SERVERS = new Set([...WHATSAPP_USER_JID_SERVERS, ...LID_USER_JID_SERVERS]);
const MAX_WARN_REASON_CHARS = 500;
const WARNINGS_LIST_PREVIEW_LIMIT = 8;
const DEFAULT_WARN_AUTO_BAN_THRESHOLD = 3;
const MIN_WARN_AUTO_BAN_THRESHOLD = 1;
const MAX_WARN_AUTO_BAN_THRESHOLD = 50;
const normalizePhoneDigits = (value) => String(value || '').replace(/\D+/g, '');

const LEGACY_ADMIN_ROUTE_BY_CANONICAL = {
  menuadmin: 'menuadm',
  autofigurinha: 'autosticker',
  modofigurinha: 'stickermode',
  janelachat: 'chatwindow',
  limitefigurinha: 'stickermsglimit',
  novogrupo: 'newgroup',
  adicionar: 'add',
  banir: 'ban',
  promover: 'up',
  rebaixar: 'down',
  assunto: 'setsubject',
  descricao: 'setdesc',
  configgrupo: 'setgroup',
  sair: 'leave',
  convite: 'invite',
  revogarconvite: 'revoke',
  entrar: 'join',
  infoconvite: 'infofrominvite',
  metadados: 'metadata',
  solicitacoes: 'requests',
  atualizarsolicitacoes: 'updaterequests',
  autosolicitacoes: 'autorequests',
  temporarias: 'temp',
  modoadicao: 'addmode',
  prefixo: 'prefix',
  boasvindas: 'welcome',
  despedida: 'farewell',
};
startAdminAiHelpScheduler();

const normalizeParticipantJid = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const normalized = normalizeJid(raw);
  if (normalized) {
    const server = getJidServer(normalized);
    if (USER_JID_SERVERS.has(server || '')) return normalized;
  }

  const digits = normalizePhoneDigits(raw);
  if (digits.length >= 10 && digits.length <= 15) {
    const phoneJid = normalizeJid(`${digits}@s.whatsapp.net`);
    if (phoneJid) return phoneJid;
  }

  return '';
};

const dedupeParticipantJids = (values = []) => {
  const deduped = [];
  for (const value of values) {
    const normalized = normalizeParticipantJid(value);
    if (!normalized) continue;
    if (deduped.some((entry) => isSameJidUser(entry, normalized) || entry === normalized)) continue;
    deduped.push(normalized);
  }
  return deduped;
};

const containsParticipantJid = (participants = [], targetJid = '') => {
  const normalizedTarget = normalizeParticipantJid(targetJid);
  if (!normalizedTarget) return false;
  return participants.some((participantJid) => {
    const normalizedParticipant = normalizeParticipantJid(participantJid);
    if (!normalizedParticipant) return false;
    return isSameJidUser(normalizedParticipant, normalizedTarget) || normalizedParticipant === normalizedTarget;
  });
};

const getParticipantJids = (messageInfo, args) => {
  const mentionedJids = messageInfo.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
  if (mentionedJids.length > 0) {
    return dedupeParticipantJids(mentionedJids);
  }
  const repliedTo = messageInfo.message?.extendedTextMessage?.contextInfo?.participant;
  if (repliedTo && args.length === 0) {
    return dedupeParticipantJids([repliedTo]);
  }
  return dedupeParticipantJids(args);
};

const normalizeWarnReason = (value) =>
  String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_WARN_REASON_CHARS);

const formatUserMentionToken = (jid) => {
  const userPart = String(jid || '')
    .split('@')[0]
    .trim();
  return userPart ? `@${userPart}` : '@usuario';
};

const formatWarnTimestamp = (value) => {
  if (!value) return 'data desconhecida';
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) return String(value);
  return new Date(parsed).toLocaleString('pt-BR');
};

const resolveSingleTargetFromMessage = (messageInfo, args = []) => {
  const safeArgs = Array.isArray(args) ? args.map((value) => String(value || '').trim()).filter(Boolean) : [];
  const contextInfo = messageInfo?.message?.extendedTextMessage?.contextInfo || {};
  const mentionedJids = dedupeParticipantJids(contextInfo?.mentionedJid || []);

  if (mentionedJids.length > 1) {
    return {
      targetJid: '',
      remainingArgs: safeArgs,
      multipleTargets: true,
    };
  }

  if (mentionedJids.length === 1) {
    const targetJid = mentionedJids[0];
    const remainingArgs = [...safeArgs];

    while (remainingArgs.length > 0) {
      const token = String(remainingArgs[0] || '').trim();
      if (!token) {
        remainingArgs.shift();
        continue;
      }

      const normalizedToken = normalizeParticipantJid(token);
      if (normalizedToken && (normalizedToken === targetJid || isSameJidUser(normalizedToken, targetJid))) {
        remainingArgs.shift();
        continue;
      }
      if (token.startsWith('@')) {
        remainingArgs.shift();
        continue;
      }
      break;
    }

    return {
      targetJid,
      remainingArgs,
      multipleTargets: false,
    };
  }

  const firstArgTarget = normalizeParticipantJid(safeArgs[0] || '');
  if (firstArgTarget) {
    return {
      targetJid: firstArgTarget,
      remainingArgs: safeArgs.slice(1),
      multipleTargets: false,
    };
  }

  const repliedTo = dedupeParticipantJids([contextInfo?.participant || '']);
  if (repliedTo.length === 1) {
    return {
      targetJid: repliedTo[0],
      remainingArgs: safeArgs,
      multipleTargets: false,
    };
  }

  return {
    targetJid: '',
    remainingArgs: safeArgs,
    multipleTargets: false,
  };
};

const resolvePremiumTargetJid = async (targetJid) => {
  const normalizedTarget = normalizeParticipantJid(targetJid);
  if (!normalizedTarget) return '';
  if (isWhatsAppJid(normalizedTarget)) return normalizedTarget;
  if (!isLidJid(normalizedTarget)) return normalizedTarget;

  const senderInfo = extractUserIdInfo({
    lid: normalizedTarget,
    participant: normalizedTarget,
    jid: normalizedTarget,
  });

  try {
    const resolved = await resolveUserId(senderInfo);
    const normalizedResolved = normalizeParticipantJid(resolved);
    if (normalizedResolved && isWhatsAppJid(normalizedResolved)) {
      return normalizedResolved;
    }
  } catch (error) {
    logger.warn('Falha ao resolver participante premium via lidMapService.', {
      action: 'premium_target_resolve_failed',
      targetJid: normalizedTarget,
      error: error?.message,
    });
  }

  return normalizedTarget;
};

const resolvePremiumTargetJids = async (targets = []) => {
  const resolvedTargets = await Promise.all((targets || []).map((target) => resolvePremiumTargetJid(target)));
  return dedupeParticipantJids(resolvedTargets);
};

const parsePositiveInteger = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const normalized = Math.floor(numeric);
  if (normalized <= 0) return null;
  return normalized;
};

const clampWarnAutoBanThreshold = (value) => {
  const parsed = parsePositiveInteger(value);
  if (!parsed) return DEFAULT_WARN_AUTO_BAN_THRESHOLD;
  return Math.max(MIN_WARN_AUTO_BAN_THRESHOLD, Math.min(MAX_WARN_AUTO_BAN_THRESHOLD, parsed));
};

const formatStickerFocusRule = ({ messageAllowanceCount, messageCooldownMinutes }) => {
  const allowanceCount = Math.max(1, Math.floor(Number(messageAllowanceCount) || 1));
  const cooldownMinutes = Math.max(1, Math.floor(Number(messageCooldownMinutes) || 1));
  const messageLabel = allowanceCount === 1 ? 'mensagem' : 'mensagens';
  return `${allowanceCount} ${messageLabel} a cada ${cooldownMinutes} min`;
};

const buildStickerFocusStatusText = ({ state, commandPrefix }) => {
  const remainingMinutes = state.isChatWindowOpen ? Math.max(1, Math.ceil(state.chatWindowRemainingMs / (60 * 1000))) : 0;
  const chatWindowStatus = state.isChatWindowOpen ? `aberta (restam ~${remainingMinutes} min)` : 'fechada';

  return ['🖼️ *Status do modo Sticker*', '', `Modo sticker: *${state.enabled ? 'ativado' : 'desativado'}*`, `Janela de chat: *${chatWindowStatus}*`, `Regra fora da janela: *${formatStickerFocusRule(state)}*`, '', `Comandos:`, `${commandPrefix}stickermode <on|off|status>`, `${commandPrefix}chatwindow <on|off|status> [minutos]`, `${commandPrefix}stickermsglimit <minutos|status|reset>`].join('\n');
};

const formatListForMessage = (items = [], emptyLabel = 'nenhum') => {
  const safeItems = Array.isArray(items) ? items.map((item) => String(item || '').trim()).filter(Boolean) : [];
  return safeItems.length ? safeItems.join(', ') : emptyLabel;
};

const parseFilterValues = (values = []) => {
  const rawText = Array.isArray(values) ? values.join(' ') : String(values || '');
  if (!rawText.trim()) return [];
  const normalized = rawText
    .split(/[\s,]+/)
    .map((value) =>
      String(value || '')
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);
  return Array.from(new Set(normalized)).sort((left, right) => left.localeCompare(right));
};

const normalizeStringList = (value) => {
  const source = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return source
    .map((entry) =>
      String(entry || '')
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);
};

const normalizeNewsFilterState = (groupConfig = {}) => {
  const nested = groupConfig?.newsFilters && typeof groupConfig.newsFilters === 'object' ? groupConfig.newsFilters : {};
  const sourceIds = Array.from(new Set([...normalizeStringList(groupConfig.newsSources), ...normalizeStringList(groupConfig.newsSourceIds), ...normalizeStringList(nested.sources), ...normalizeStringList(nested.sourceIds)])).sort((left, right) => left.localeCompare(right));
  const franchiseSlugs = Array.from(new Set([...normalizeStringList(groupConfig.newsFranchises), ...normalizeStringList(groupConfig.newsFranchiseSlugs), ...normalizeStringList(nested.franchises), ...normalizeStringList(nested.franchiseSlugs)])).sort((left, right) => left.localeCompare(right));
  const entitySlugs = Array.from(new Set([...normalizeStringList(groupConfig.newsEntities), ...normalizeStringList(groupConfig.newsEntitySlugs), ...normalizeStringList(groupConfig.newsTags), ...normalizeStringList(nested.entities), ...normalizeStringList(nested.entitySlugs), ...normalizeStringList(nested.tags)])).sort((left, right) => left.localeCompare(right));
  const onlyTrending = Boolean(groupConfig.newsOnlyTrending || nested.onlyTrending);

  return {
    sourceIds,
    franchiseSlugs,
    entitySlugs,
    onlyTrending,
  };
};

const buildNewsFilterConfigPatch = (groupConfig, nextState) => {
  const nested = groupConfig?.newsFilters && typeof groupConfig.newsFilters === 'object' ? groupConfig.newsFilters : {};
  const safeSources = Array.isArray(nextState?.sourceIds) ? nextState.sourceIds : [];
  const safeFranchises = Array.isArray(nextState?.franchiseSlugs) ? nextState.franchiseSlugs : [];
  const safeEntities = Array.isArray(nextState?.entitySlugs) ? nextState.entitySlugs : [];
  const safeOnlyTrending = Boolean(nextState?.onlyTrending);

  return {
    newsSourceIds: safeSources,
    newsSources: safeSources,
    newsFranchiseSlugs: safeFranchises,
    newsFranchises: safeFranchises,
    newsEntitySlugs: safeEntities,
    newsEntities: safeEntities,
    newsTags: safeEntities,
    newsOnlyTrending: safeOnlyTrending,
    newsFilters: {
      ...nested,
      sourceIds: safeSources,
      sources: safeSources,
      franchiseSlugs: safeFranchises,
      franchises: safeFranchises,
      entitySlugs: safeEntities,
      entities: safeEntities,
      tags: safeEntities,
      onlyTrending: safeOnlyTrending,
    },
  };
};

const formatDateTimeLabel = (value) => {
  if (!value) return 'nunca';
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) return String(value);
  return new Date(parsed).toLocaleString('pt-BR');
};

const buildGroupAuditText = ({ config, stickerState, newsStatus, commandPrefix }) => {
  const prefix = String(config?.commandPrefix || '').trim() || DEFAULT_COMMAND_PREFIX;
  const newsFilters = normalizeNewsFilterState(config);
  const stickerWindowText = stickerState.isChatWindowOpen ? `aberta (~${Math.max(1, Math.ceil(stickerState.chatWindowRemainingMs / (60 * 1000)))} min restantes)` : 'fechada';

  return ['🧾 *Auditoria do Grupo*', '', `Prefixo: *${prefix}*`, `NSFW: *${config?.nsfwEnabled ? 'ativado' : 'desativado'}*`, `AutoSticker: *${config?.autoStickerEnabled ? 'ativado' : 'desativado'}*`, `Modo Sticker: *${stickerState.enabled ? 'ativado' : 'desativado'}*`, `Janela de chat: *${stickerWindowText}*`, `Regra de texto: *${formatStickerFocusRule(stickerState)}*`, `Captcha: *${config?.captchaEnabled ? 'ativado' : 'desativado'}*`, `Auto-aprovação de solicitações: *${config?.autoApproveRequestsEnabled ? 'ativada' : 'desativada'}*`, `Antilink: *${config?.antilinkEnabled ? 'ativado' : 'desativado'}*`, `Antilink redes permitidas: ${formatListForMessage(config?.antilinkAllowedNetworks || [])}`, `Antilink domínios permitidos: ${formatListForMessage(config?.antilinkAllowedDomains || [])}`, `Notícias: *${newsStatus?.enabled ? 'ativado' : 'desativado'}*`, `Notícias enviadas: *${Number(newsStatus?.sentCount || 0)}*`, `Último envio de notícias: *${formatDateTimeLabel(newsStatus?.lastSentAt)}*`, `Filtro notícias [source]: ${formatListForMessage(newsFilters.sourceIds)}`, `Filtro notícias [franchise]: ${formatListForMessage(newsFilters.franchiseSlugs)}`, `Filtro notícias [tag/entity]: ${formatListForMessage(newsFilters.entitySlugs)}`, `Filtro notícias [somente em alta]: *${newsFilters.onlyTrending ? 'sim' : 'não'}*`, `Boas-vindas: *${config?.welcomeMessageEnabled ? 'ativadas' : 'desativadas'}*`, `Despedida: *${config?.farewellMessageEnabled ? 'ativadas' : 'desativadas'}*`, '', `Dica: use *${commandPrefix}noticiasfiltro status* para ver os filtros em detalhe.`].join('\n');
};

export const isAdminCommand = (command) => isAdminCommandName(command);

export async function handleAdminCommand({ command, args, text, sock, messageInfo, remoteJid, senderJid, botJid, isGroupMessage, expirationMessage, commandPrefix = DEFAULT_COMMAND_PREFIX }) {
  const normalizedCommand = resolveAdminCommandName(command);
  if (!normalizedCommand) {
    return false;
  }
  const routeCommand = LEGACY_ADMIN_ROUTE_BY_CANONICAL[normalizedCommand] || normalizedCommand;
  const senderIdentity = {
    jid: senderJid || null,
    participant: messageInfo?.key?.participant || null,
    participantAlt: messageInfo?.key?.participantAlt || null,
    remoteJidAlt: messageInfo?.key?.remoteJidAlt || null,
  };

  switch (routeCommand) {
    case 'menuadm': {
      if (!isGroupMessage) {
        await sendAndStore(sock, remoteJid, { text: GROUP_ONLY_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }
      if (!(await isUserAdmin(remoteJid, senderIdentity))) {
        await sendAndStore(sock, remoteJid, { text: NO_PERMISSION_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }
      const subAction = String(args?.[0] || '')
        .trim()
        .toLowerCase();
      const isOwner = Boolean(OWNER_JID && (await isAdminSenderAsync(senderIdentity)));

      if (!subAction) {
        await handleMenuAdmCommand(sock, remoteJid, messageInfo, expirationMessage, commandPrefix, []);
        break;
      }

      if (subAction === 'ajuda' || subAction === 'help') {
        const targetCommand = String(args?.[1] || '')
          .trim()
          .toLowerCase();
        if (!targetCommand) {
          await sendAndStore(
            sock,
            remoteJid,
            {
              text: getAdminUsageText('menuadm', { commandPrefix, variant: 'help' }),
            },
            { quoted: messageInfo, ephemeralExpiration: expirationMessage },
          );
          break;
        }

        const explanation = await explicarComando(targetCommand, {
          commandPrefix,
          isGroupMessage,
          isSenderAdmin: true,
          isSenderOwner: isOwner,
        });
        await sendAndStore(sock, remoteJid, { text: explanation.text }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }

      if (subAction === 'faq') {
        const faqResult = await gerarFaqAutomatica({
          commandPrefix,
          force: true,
          reason: 'menuadm_faq',
        });
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: faqResult?.text || 'Nao foi possivel gerar a FAQ agora.',
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }

      if (subAction === 'perguntar' || subAction === 'ask' || subAction === 'pergunta') {
        const question = args.slice(1).join(' ').trim();
        if (!question) {
          await sendAndStore(
            sock,
            remoteJid,
            {
              text: getAdminUsageText('menuadm', { commandPrefix, variant: 'ask' }),
            },
            { quoted: messageInfo, ephemeralExpiration: expirationMessage },
          );
          break;
        }

        const answer = await responderPergunta(question, {
          commandPrefix,
          isGroupMessage,
          isSenderAdmin: true,
          isSenderOwner: isOwner,
        });
        await sendAndStore(sock, remoteJid, { text: answer.text }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }

      await handleMenuAdmCommand(sock, remoteJid, messageInfo, expirationMessage, commandPrefix, args);
      break;
    }

    case 'premium': {
      if (!OWNER_JID || !(await isAdminSenderAsync(senderIdentity))) {
        await sendAndStore(sock, remoteJid, { text: OWNER_ONLY_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }

      const action = args[0]?.toLowerCase();
      const actionArgs = args.slice(1);
      if (!action || !['add', 'remove', 'list'].includes(action)) {
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: getAdminUsageText('premium', { commandPrefix, variant: 'invalid_action' }),
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }

      if (action === 'list') {
        const premiumUsers = await premiumUserStore.getPremiumUsers();
        const listText = premiumUsers.length > 0 ? premiumUsers.map((jid) => `• ${jid}`).join('\n') : 'Nenhum usuário premium cadastrado.';
        await sendAndStore(sock, remoteJid, { text: `⭐ *Lista de usuários premium*\n\n${listText}` }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }

      const participants = await resolvePremiumTargetJids(getParticipantJids(messageInfo, actionArgs));
      if (participants.length === 0) {
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: getAdminUsageText('premium', { commandPrefix, variant: 'missing_targets' }),
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }

      if (action === 'add') {
        const updated = await premiumUserStore.addPremiumUsers(participants);
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: `✅ Usuários adicionados à lista premium com sucesso.\nTotal atual de usuários premium: ${updated.length}`,
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
      } else {
        const updated = await premiumUserStore.removePremiumUsers(participants);
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: `✅ Usuários removidos da lista premium com sucesso.\nTotal atual de usuários premium: ${updated.length}`,
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
      }
      break;
    }

    case 'nsfw': {
      if (!isGroupMessage) {
        await sendAndStore(sock, remoteJid, { text: GROUP_ONLY_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }
      if (!(await isUserAdmin(remoteJid, senderIdentity))) {
        await sendAndStore(sock, remoteJid, { text: NO_PERMISSION_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }

      const action = args[0]?.toLowerCase();
      if (!action || !['on', 'off', 'status'].includes(action)) {
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: getAdminUsageText('nsfw', { commandPrefix }),
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }

      if (action === 'status') {
        const config = await groupConfigStore.getGroupConfig(remoteJid);
        const enabled = Boolean(config.nsfwEnabled);
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: `🔞 Status do conteúdo NSFW neste grupo: *${enabled ? 'ativado' : 'desativado'}*.`,
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }

      const enabled = action === 'on';
      await groupConfigStore.updateGroupConfig(remoteJid, { nsfwEnabled: enabled });
      await sendAndStore(
        sock,
        remoteJid,
        {
          text: `🔞 Configuração NSFW atualizada: *${enabled ? 'ativado' : 'desativado'}* para este grupo.`,
        },
        { quoted: messageInfo, ephemeralExpiration: expirationMessage },
      );
      break;
    }

    case 'autosticker': {
      if (!isGroupMessage) {
        await sendAndStore(sock, remoteJid, { text: GROUP_ONLY_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }
      if (!(await isUserAdmin(remoteJid, senderIdentity))) {
        await sendAndStore(sock, remoteJid, { text: NO_PERMISSION_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }

      const action = args[0]?.toLowerCase();
      if (!action || !['on', 'off', 'status'].includes(action)) {
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: getAdminUsageText('autosticker', { commandPrefix }),
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }

      if (action === 'status') {
        const config = await groupConfigStore.getGroupConfig(remoteJid);
        const enabled = Boolean(config.autoStickerEnabled);
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: `🖼️ Status do AutoSticker neste grupo: *${enabled ? 'ativado' : 'desativado'}*.\n` + 'Quando ativo, imagens e vídeos enviados serão convertidos automaticamente em figurinha.',
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }

      const enabled = action === 'on';
      await groupConfigStore.updateGroupConfig(remoteJid, { autoStickerEnabled: enabled });
      await sendAndStore(
        sock,
        remoteJid,
        {
          text: enabled ? '✅ AutoSticker ativado neste grupo.\nEnvie uma imagem ou vídeo para conversão automática em figurinha.' : '🛑 AutoSticker desativado neste grupo.',
        },
        { quoted: messageInfo, ephemeralExpiration: expirationMessage },
      );
      break;
    }

    case 'stickermode': {
      if (!isGroupMessage) {
        await sendAndStore(sock, remoteJid, { text: GROUP_ONLY_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }
      if (!(await isUserAdmin(remoteJid, senderIdentity))) {
        await sendAndStore(sock, remoteJid, { text: NO_PERMISSION_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }

      const action = args[0]?.toLowerCase();
      if (!action || !['on', 'off', 'status'].includes(action)) {
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: getAdminUsageText('stickermode', { commandPrefix }),
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }

      if (action === 'status') {
        const config = await groupConfigStore.getGroupConfig(remoteJid);
        const state = resolveStickerFocusState(config);
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: buildStickerFocusStatusText({ state, commandPrefix }),
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }

      const enabled = action === 'on';
      await groupConfigStore.updateGroupConfig(remoteJid, {
        stickerFocusEnabled: enabled,
      });

      if (enabled) {
        const config = await groupConfigStore.getGroupConfig(remoteJid);
        const state = resolveStickerFocusState(config);
        const enabledText = ['✅ Modo sticker ativado neste grupo.', `Fora da janela de chat, cada usuário pode enviar *${formatStickerFocusRule(state)}*.`, `Use *${commandPrefix}chatwindow on* para abrir conversa livre temporária.`].join('\n');
        await sendAndStore(sock, remoteJid, { text: enabledText }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
      } else {
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: '🛑 Modo sticker desativado neste grupo.\nMensagens de texto voltaram ao comportamento normal.',
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
      }

      break;
    }

    case 'chatwindow': {
      if (!isGroupMessage) {
        await sendAndStore(sock, remoteJid, { text: GROUP_ONLY_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }
      if (!(await isUserAdmin(remoteJid, senderIdentity))) {
        await sendAndStore(sock, remoteJid, { text: NO_PERMISSION_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }

      const action = args[0]?.toLowerCase();
      if (!action || !['on', 'off', 'status'].includes(action)) {
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: getAdminUsageText('chatwindow', { commandPrefix }),
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }

      if (action === 'status') {
        const config = await groupConfigStore.getGroupConfig(remoteJid);
        const state = resolveStickerFocusState(config);
        const remainingMinutes = state.isChatWindowOpen ? Math.max(1, Math.ceil(state.chatWindowRemainingMs / (60 * 1000))) : 0;
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: `💬 Janela de chat está *${state.isChatWindowOpen ? 'aberta' : 'fechada'}*.` + (state.isChatWindowOpen ? `\nTempo restante: ~${remainingMinutes} min.` : '') + `\nModo sticker: *${state.enabled ? 'ativado' : 'desativado'}*.`,
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }

      if (action === 'off') {
        await groupConfigStore.updateGroupConfig(remoteJid, {
          stickerFocusChatWindowUntilMs: null,
        });
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: '🛑 Janela de chat encerrada. O grupo voltou para o fluxo normal do modo sticker.',
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }

      const rawMinutes = args[1];
      let minutes = DEFAULT_STICKER_FOCUS_CHAT_WINDOW_MINUTES;
      if (rawMinutes !== undefined) {
        const parsed = parsePositiveInteger(rawMinutes);
        if (!parsed) {
          await sendAndStore(
            sock,
            remoteJid,
            {
              text: `Informe minutos válidos entre ${MIN_STICKER_FOCUS_CHAT_WINDOW_MINUTES} e ${MAX_STICKER_FOCUS_CHAT_WINDOW_MINUTES}.`,
            },
            { quoted: messageInfo, ephemeralExpiration: expirationMessage },
          );
          break;
        }
        if (parsed < MIN_STICKER_FOCUS_CHAT_WINDOW_MINUTES || parsed > MAX_STICKER_FOCUS_CHAT_WINDOW_MINUTES) {
          await sendAndStore(
            sock,
            remoteJid,
            {
              text: `Tempo fora da faixa permitida. Use entre ${MIN_STICKER_FOCUS_CHAT_WINDOW_MINUTES} e ${MAX_STICKER_FOCUS_CHAT_WINDOW_MINUTES} minutos.`,
            },
            { quoted: messageInfo, ephemeralExpiration: expirationMessage },
          );
          break;
        }
        minutes = clampStickerFocusChatWindowMinutes(parsed, DEFAULT_STICKER_FOCUS_CHAT_WINDOW_MINUTES);
      }

      const untilMs = __timeNowMs() + minutes * 60 * 1000;
      await groupConfigStore.updateGroupConfig(remoteJid, {
        stickerFocusChatWindowUntilMs: untilMs,
      });

      const config = await groupConfigStore.getGroupConfig(remoteJid);
      const state = resolveStickerFocusState(config);
      const openText = [`✅ Janela de chat aberta por *${minutes} min*.`, 'Durante esse período, mensagens ficam liberadas para todos.', `Modo sticker: *${state.enabled ? 'ativado' : 'desativado'}*.`].join('\n');
      await sendAndStore(sock, remoteJid, { text: openText }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
      break;
    }

    case 'stickermsglimit': {
      if (!isGroupMessage) {
        await sendAndStore(sock, remoteJid, { text: GROUP_ONLY_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }
      if (!(await isUserAdmin(remoteJid, senderIdentity))) {
        await sendAndStore(sock, remoteJid, { text: NO_PERMISSION_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }

      const rawValue = args[0];
      const normalized = String(rawValue || '')
        .trim()
        .toLowerCase();

      if (!normalized || normalized === 'status') {
        const config = await groupConfigStore.getGroupConfig(remoteJid);
        const state = resolveStickerFocusState(config);
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: `🧩 Regra atual por usuário fora da janela: *${formatStickerFocusRule(state)}*.` + `\nModo sticker: *${state.enabled ? 'ativado' : 'desativado'}*.` + `\nUse *${commandPrefix}stickermsglimit <minutos>* para alterar a janela.`,
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }

      if (['reset', 'default', 'padrao', 'padrão'].includes(normalized)) {
        await groupConfigStore.updateGroupConfig(remoteJid, {
          stickerFocusMessageCooldownMinutes: DEFAULT_STICKER_FOCUS_MESSAGE_COOLDOWN_MINUTES,
          stickerFocusTextCooldownMinutes: DEFAULT_STICKER_FOCUS_MESSAGE_COOLDOWN_MINUTES,
        });
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: `✅ Intervalo restaurado para o padrão: *${DEFAULT_STICKER_FOCUS_MESSAGE_COOLDOWN_MINUTES} min*.`,
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }

      const parsed = parsePositiveInteger(rawValue);
      if (!parsed) {
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: getAdminUsageText('stickermsglimit', { commandPrefix }),
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }

      if (parsed < MIN_STICKER_FOCUS_MESSAGE_COOLDOWN_MINUTES || parsed > MAX_STICKER_FOCUS_MESSAGE_COOLDOWN_MINUTES) {
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: `Informe um valor entre ${MIN_STICKER_FOCUS_MESSAGE_COOLDOWN_MINUTES} e ${MAX_STICKER_FOCUS_MESSAGE_COOLDOWN_MINUTES} minutos.`,
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }

      const minutes = clampStickerFocusMessageCooldownMinutes(parsed, DEFAULT_STICKER_FOCUS_MESSAGE_COOLDOWN_MINUTES);
      await groupConfigStore.updateGroupConfig(remoteJid, {
        stickerFocusMessageCooldownMinutes: minutes,
        stickerFocusTextCooldownMinutes: minutes,
      });

      await sendAndStore(
        sock,
        remoteJid,
        {
          text: `✅ Intervalo de mensagem por usuário atualizado para *${minutes} min* no modo sticker.`,
        },
        { quoted: messageInfo, ephemeralExpiration: expirationMessage },
      );
      break;
    }

    case 'stickerallowance': {
      if (!isGroupMessage) {
        await sendAndStore(sock, remoteJid, { text: GROUP_ONLY_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }
      if (!(await isUserAdmin(remoteJid, senderIdentity))) {
        await sendAndStore(sock, remoteJid, { text: NO_PERMISSION_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }

      const rawValue = args[0];
      const normalized = String(rawValue || '')
        .trim()
        .toLowerCase();

      if (!normalized || normalized === 'status') {
        const config = await groupConfigStore.getGroupConfig(remoteJid);
        const state = resolveStickerFocusState(config);
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: `📏 Limite atual de mensagens por usuário no modo sticker: *${state.messageAllowanceCount}*.` + `\nRegra vigente: *${formatStickerFocusRule(state)}*.` + `\nUse *${commandPrefix}stickerallowance <quantidade>* para alterar.`,
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }

      if (['reset', 'default', 'padrao', 'padrão'].includes(normalized)) {
        await groupConfigStore.updateGroupConfig(remoteJid, {
          stickerFocusMessageAllowance: DEFAULT_STICKER_FOCUS_MESSAGE_ALLOWANCE,
          stickerFocusMessageAllowanceCount: DEFAULT_STICKER_FOCUS_MESSAGE_ALLOWANCE,
        });
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: `✅ Limite restaurado para o padrão: *${DEFAULT_STICKER_FOCUS_MESSAGE_ALLOWANCE}* mensagem(ns) por janela.`,
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }

      const parsed = parsePositiveInteger(rawValue);
      if (!parsed) {
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: getAdminUsageText('stickerallowance', { commandPrefix }),
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }

      if (parsed < MIN_STICKER_FOCUS_MESSAGE_ALLOWANCE || parsed > MAX_STICKER_FOCUS_MESSAGE_ALLOWANCE) {
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: `Informe uma quantidade entre ${MIN_STICKER_FOCUS_MESSAGE_ALLOWANCE} e ${MAX_STICKER_FOCUS_MESSAGE_ALLOWANCE}.`,
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }

      const allowance = clampStickerFocusMessageAllowance(parsed, DEFAULT_STICKER_FOCUS_MESSAGE_ALLOWANCE);
      await groupConfigStore.updateGroupConfig(remoteJid, {
        stickerFocusMessageAllowance: allowance,
        stickerFocusMessageAllowanceCount: allowance,
      });

      await sendAndStore(
        sock,
        remoteJid,
        {
          text: `✅ Limite de mensagens por usuário atualizado para *${allowance}* no modo sticker.`,
        },
        { quoted: messageInfo, ephemeralExpiration: expirationMessage },
      );
      break;
    }

    case 'newgroup': {
      if (args.length < 2) {
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: getAdminUsageText('newgroup', { commandPrefix }),
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }
      const title = args[0];
      const participants = args.slice(1);
      try {
        const group = await createGroup(sock, title, participants);
        await sendAndStore(sock, remoteJid, { text: `O grupo "${group.subject}" foi criado com sucesso.` }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
      } catch (error) {
        await sendAndStore(sock, remoteJid, { text: `Não foi possível criar o grupo. Detalhes: ${error.message}` }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
      }
      break;
    }

    case 'add': {
      if (!isGroupMessage) {
        await sendAndStore(sock, remoteJid, { text: GROUP_ONLY_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }
      if (!(await isUserAdmin(remoteJid, senderIdentity))) {
        await sendAndStore(sock, remoteJid, { text: NO_PERMISSION_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }

      const participants = getParticipantJids(messageInfo, args);
      if (participants.length === 0) {
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: getAdminUsageText('add', { commandPrefix, variant: 'missing_targets' }),
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }
      try {
        await updateGroupParticipants(sock, remoteJid, participants, 'add');
        await sendAndStore(sock, remoteJid, { text: 'Participantes adicionados com sucesso.' }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
      } catch (error) {
        await sendAndStore(sock, remoteJid, { text: `Não foi possível adicionar participantes. Detalhes: ${error.message}` }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
      }
      break;
    }

    case 'ban': {
      if (!isGroupMessage) {
        await sendAndStore(sock, remoteJid, { text: GROUP_ONLY_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }
      if (!(await isUserAdmin(remoteJid, senderIdentity))) {
        await sendAndStore(sock, remoteJid, { text: NO_PERMISSION_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }

      const participants = getParticipantJids(messageInfo, args);
      if (participants.length === 0) {
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: getAdminUsageText('ban', { commandPrefix, variant: 'missing_targets' }),
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }
      if (containsParticipantJid(participants, botJid)) {
        await sendAndStore(sock, remoteJid, { text: 'Operação cancelada: o bot não pode remover a própria conta.' }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }
      try {
        await updateGroupParticipants(sock, remoteJid, participants, 'remove');

        let deletedRecentMessages = 0;
        let failedRecentDeletes = 0;
        let requestedRecentDeletes = 0;
        for (const participant of participants) {
          const cleanupResult = await purgeRecentMessagesForSenderCandidates({
            sock,
            remoteJid,
            senderCandidates: [participant],
          });
          deletedRecentMessages += Number(cleanupResult?.deleted || 0);
          failedRecentDeletes += Number(cleanupResult?.failed || 0);
          requestedRecentDeletes += Number(cleanupResult?.requested || 0);
        }

        const successText = deletedRecentMessages > 0 ? `Participantes removidos com sucesso.\n🧹 ${deletedRecentMessages} mensagem(ns) recentes apagadas.` : 'Participantes removidos com sucesso.';
        await sendAndStore(sock, remoteJid, { text: successText }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });

        logger.info('Comando ban executado com limpeza de mensagens recentes.', {
          action: 'admin_ban_with_recent_cleanup',
          groupId: remoteJid,
          participants,
          deletedRecentMessages,
          failedRecentDeletes,
          requestedRecentDeletes,
        });

        const repliedTo = messageInfo.message?.extendedTextMessage?.contextInfo;
        if (repliedTo && containsParticipantJid(participants, repliedTo.participant)) {
          await sendAndStore(sock, remoteJid, {
            delete: messageInfo.message?.extendedTextMessage?.contextInfo?.key,
          });
        }
      } catch (error) {
        await sendAndStore(sock, remoteJid, { text: `Não foi possível remover participantes. Detalhes: ${error.message}` }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
      }
      break;
    }

    case 'warn': {
      if (!isGroupMessage) {
        await sendAndStore(sock, remoteJid, { text: GROUP_ONLY_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }
      if (!(await isUserAdmin(remoteJid, senderIdentity))) {
        await sendAndStore(sock, remoteJid, { text: NO_PERMISSION_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }

      const { targetJid, remainingArgs, multipleTargets } = resolveSingleTargetFromMessage(messageInfo, args);
      if (multipleTargets || !targetJid) {
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: getAdminUsageText('warn', { commandPrefix, variant: 'missing_targets' }),
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }

      const reason = normalizeWarnReason(remainingArgs.join(' '));
      const targetMention = formatUserMentionToken(targetJid);

      try {
        await addGroupWarning({
          groupId: remoteJid,
          participantJid: targetJid,
          warnedByJid: senderJid,
          reason: reason || null,
        });

        const totalWarnings = await countGroupWarnings({
          groupId: remoteJid,
          participantJid: targetJid,
        });

        const groupConfig = await groupConfigStore.getGroupConfig(remoteJid);
        const warnAutoBanThreshold = clampWarnAutoBanThreshold(groupConfig?.warnAutoBanThreshold);
        const shouldAutoBan = totalWarnings >= warnAutoBanThreshold && !containsParticipantJid([targetJid], botJid);
        let autoBanSucceeded = false;
        let autoBanError = '';

        if (shouldAutoBan) {
          try {
            await updateGroupParticipants(sock, remoteJid, [targetJid], 'remove');
            autoBanSucceeded = true;
          } catch (error) {
            autoBanError = error?.message || 'falha desconhecida';
            logger.warn('Falha ao aplicar auto-ban por limite de advertências.', {
              action: 'admin_warn_auto_ban_failed',
              groupId: remoteJid,
              targetJid,
              warnAutoBanThreshold,
              totalWarnings,
              error: autoBanError,
            });
          }
        }

        const replyLines = [`⚠️ Advertência registrada para ${targetMention}.`, `Motivo: ${reason || 'não informado'}`, `Total de advertências neste grupo: *${totalWarnings}*.`, `Auto-ban configurado para: *${warnAutoBanThreshold}* advertência(s).`];
        if (autoBanSucceeded) {
          replyLines.push(`🚫 Limite atingido: ${targetMention} foi removido(a) automaticamente do grupo.`);
        } else if (autoBanError) {
          replyLines.push(`⚠️ Limite atingido, mas não consegui remover automaticamente: ${autoBanError}`);
        }

        await sendAndStore(
          sock,
          remoteJid,
          {
            text: replyLines.join('\n'),
            mentions: [targetJid],
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
      } catch (error) {
        logger.warn('Falha ao registrar advertência no grupo.', {
          action: 'admin_warn_failed',
          groupId: remoteJid,
          senderJid,
          targetJid,
          error: error?.message,
        });
        await sendAndStore(sock, remoteJid, { text: `Não foi possível registrar a advertência. Detalhes: ${error.message}` }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
      }
      break;
    }

    case 'warnings': {
      if (!isGroupMessage) {
        await sendAndStore(sock, remoteJid, { text: GROUP_ONLY_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }
      if (!(await isUserAdmin(remoteJid, senderIdentity))) {
        await sendAndStore(sock, remoteJid, { text: NO_PERMISSION_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }

      const { targetJid, multipleTargets } = resolveSingleTargetFromMessage(messageInfo, args);
      if (multipleTargets || !targetJid) {
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: getAdminUsageText('warnings', { commandPrefix, variant: 'missing_targets' }),
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }

      const targetMention = formatUserMentionToken(targetJid);

      try {
        const [totalWarnings, warningRows] = await Promise.all([
          countGroupWarnings({
            groupId: remoteJid,
            participantJid: targetJid,
          }),
          listGroupWarnings({
            groupId: remoteJid,
            participantJid: targetJid,
            limit: WARNINGS_LIST_PREVIEW_LIMIT,
          }),
        ]);

        if (totalWarnings <= 0) {
          await sendAndStore(
            sock,
            remoteJid,
            {
              text: `✅ ${targetMention} não possui advertências registradas neste grupo.`,
              mentions: [targetJid],
            },
            { quoted: messageInfo, ephemeralExpiration: expirationMessage },
          );
          break;
        }

        const historyLines = (warningRows || []).map((warningRow, index) => `${index + 1}. ${formatWarnTimestamp(warningRow?.createdAt)} - ${warningRow?.reason || 'Sem motivo informado'}`);
        if (totalWarnings > historyLines.length) {
          historyLines.push(`... e mais ${totalWarnings - historyLines.length} advertência(s).`);
        }

        await sendAndStore(
          sock,
          remoteJid,
          {
            text: [`📋 Histórico de advertências de ${targetMention}`, `Total neste grupo: *${totalWarnings}*`, '', ...historyLines].join('\n'),
            mentions: [targetJid],
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
      } catch (error) {
        logger.warn('Falha ao consultar histórico de advertências no grupo.', {
          action: 'admin_warnings_failed',
          groupId: remoteJid,
          senderJid,
          targetJid,
          error: error?.message,
        });
        await sendAndStore(sock, remoteJid, { text: `Não foi possível consultar as advertências. Detalhes: ${error.message}` }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
      }
      break;
    }

    case 'clearwarn': {
      if (!isGroupMessage) {
        await sendAndStore(sock, remoteJid, { text: GROUP_ONLY_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }
      if (!(await isUserAdmin(remoteJid, senderIdentity))) {
        await sendAndStore(sock, remoteJid, { text: NO_PERMISSION_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }

      const { targetJid, remainingArgs, multipleTargets } = resolveSingleTargetFromMessage(messageInfo, args);
      if (multipleTargets || !targetJid) {
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: getAdminUsageText('clearwarn', { commandPrefix, variant: 'missing_targets' }),
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }

      const rawScope = String(remainingArgs?.[0] || '')
        .trim()
        .toLowerCase();
      const clearAll = rawScope === 'all';
      const amountToClear = !rawScope || clearAll ? 1 : parsePositiveInteger(rawScope);

      if (!clearAll && rawScope && !amountToClear) {
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: getAdminUsageText('clearwarn', { commandPrefix, variant: 'invalid_amount' }),
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }

      try {
        const clearResult = await clearGroupWarnings({
          groupId: remoteJid,
          participantJid: targetJid,
          clearAll,
          limit: amountToClear || 1,
        });

        const targetMention = formatUserMentionToken(targetJid);
        if (clearResult.removedCount <= 0) {
          await sendAndStore(
            sock,
            remoteJid,
            {
              text: `ℹ️ ${targetMention} não possui advertências para remover neste grupo.`,
              mentions: [targetJid],
            },
            { quoted: messageInfo, ephemeralExpiration: expirationMessage },
          );
          break;
        }

        const removedLabel = clearAll ? `todas as advertências (${clearResult.removedCount})` : `${clearResult.removedCount} advertência(s)`;
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: `🧹 Limpeza concluída para ${targetMention}: removi *${removedLabel}*.\nAdvertências restantes neste grupo: *${clearResult.remainingCount}*.`,
            mentions: [targetJid],
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
      } catch (error) {
        logger.warn('Falha ao limpar advertências no grupo.', {
          action: 'admin_clearwarn_failed',
          groupId: remoteJid,
          senderJid,
          targetJid,
          clearAll,
          error: error?.message,
        });
        await sendAndStore(sock, remoteJid, { text: `Não foi possível limpar advertências. Detalhes: ${error.message}` }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
      }
      break;
    }

    case 'warnlimit': {
      if (!isGroupMessage) {
        await sendAndStore(sock, remoteJid, { text: GROUP_ONLY_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }
      if (!(await isUserAdmin(remoteJid, senderIdentity))) {
        await sendAndStore(sock, remoteJid, { text: NO_PERMISSION_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }

      const action = String(args?.[0] || '')
        .trim()
        .toLowerCase();
      const groupConfig = await groupConfigStore.getGroupConfig(remoteJid);
      const currentThreshold = clampWarnAutoBanThreshold(groupConfig?.warnAutoBanThreshold);

      if (!action || action === 'status') {
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: `⚖️ Limite atual de auto-ban por advertências: *${currentThreshold}*.\nUse ${commandPrefix}warnlimit <qtd> para atualizar ou ${commandPrefix}warnlimit reset para voltar ao padrão.`,
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }

      if (action === 'reset') {
        await groupConfigStore.updateGroupConfig(remoteJid, { warnAutoBanThreshold: null });
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: `✅ Limite de auto-ban resetado para o padrão: *${DEFAULT_WARN_AUTO_BAN_THRESHOLD}* advertência(s).`,
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }

      const parsedThreshold = parsePositiveInteger(action);
      if (!parsedThreshold) {
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: getAdminUsageText('warnlimit', { commandPrefix, variant: 'invalid_value' }),
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }

      const nextThreshold = Math.max(MIN_WARN_AUTO_BAN_THRESHOLD, Math.min(MAX_WARN_AUTO_BAN_THRESHOLD, parsedThreshold));
      await groupConfigStore.updateGroupConfig(remoteJid, { warnAutoBanThreshold: nextThreshold });
      await sendAndStore(
        sock,
        remoteJid,
        {
          text: `✅ Limite de auto-ban atualizado para *${nextThreshold}* advertência(s).`,
        },
        { quoted: messageInfo, ephemeralExpiration: expirationMessage },
      );
      break;
    }

    case 'up': {
      if (!isGroupMessage) {
        await sendAndStore(sock, remoteJid, { text: GROUP_ONLY_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }
      if (!(await isUserAdmin(remoteJid, senderIdentity))) {
        await sendAndStore(sock, remoteJid, { text: NO_PERMISSION_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }

      const participants = getParticipantJids(messageInfo, args);
      if (participants.length === 0) {
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: getAdminUsageText('up', { commandPrefix, variant: 'missing_targets' }),
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }
      if (containsParticipantJid(participants, botJid)) {
        await sendAndStore(sock, remoteJid, { text: 'Operação cancelada: o bot não pode promover a própria conta.' }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }
      try {
        await updateGroupParticipants(sock, remoteJid, participants, 'promote');
        await sendAndStore(sock, remoteJid, { text: 'Participantes promovidos a administradores com sucesso.' }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
      } catch (error) {
        await sendAndStore(sock, remoteJid, { text: `Não foi possível promover participantes. Detalhes: ${error.message}` }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
      }
      break;
    }

    case 'down': {
      if (!isGroupMessage) {
        await sendAndStore(sock, remoteJid, { text: GROUP_ONLY_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }
      if (!(await isUserAdmin(remoteJid, senderIdentity))) {
        await sendAndStore(sock, remoteJid, { text: NO_PERMISSION_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }

      const participants = getParticipantJids(messageInfo, args);
      if (participants.length === 0) {
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: getAdminUsageText('down', { commandPrefix, variant: 'missing_targets' }),
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }
      if (containsParticipantJid(participants, botJid)) {
        await sendAndStore(sock, remoteJid, { text: 'Operação cancelada: o bot não pode rebaixar a própria conta.' }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }
      try {
        await updateGroupParticipants(sock, remoteJid, participants, 'demote');
        await sendAndStore(sock, remoteJid, { text: 'Administradores rebaixados para participantes com sucesso.' }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
      } catch (error) {
        await sendAndStore(sock, remoteJid, { text: `Não foi possível rebaixar administradores. Detalhes: ${error.message}` }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
      }
      break;
    }

    case 'setsubject': {
      if (!isGroupMessage) {
        await sendAndStore(sock, remoteJid, { text: GROUP_ONLY_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }
      if (!(await isUserAdmin(remoteJid, senderIdentity))) {
        await sendAndStore(sock, remoteJid, { text: NO_PERMISSION_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }

      if (args.length < 1) {
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: getAdminUsageText('setsubject', { commandPrefix }),
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }
      const newSubject = args.join(' ');
      try {
        await updateGroupSubject(sock, remoteJid, newSubject);
        await sendAndStore(sock, remoteJid, { text: `O assunto do grupo foi atualizado para "${newSubject}" com sucesso.` }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
      } catch (error) {
        await sendAndStore(sock, remoteJid, { text: `Não foi possível alterar o assunto do grupo. Detalhes: ${error.message}` }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
      }
      break;
    }

    case 'setdesc': {
      if (!isGroupMessage) {
        await sendAndStore(sock, remoteJid, { text: GROUP_ONLY_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }
      if (!(await isUserAdmin(remoteJid, senderIdentity))) {
        await sendAndStore(sock, remoteJid, { text: NO_PERMISSION_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }

      if (args.length < 1) {
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: getAdminUsageText('setdesc', { commandPrefix }),
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }
      const newDescription = args.join(' ');
      try {
        await updateGroupDescription(sock, remoteJid, newDescription);
        await sendAndStore(sock, remoteJid, { text: 'Descrição do grupo atualizada com sucesso.' }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
      } catch (error) {
        await sendAndStore(sock, remoteJid, { text: `Não foi possível alterar a descrição do grupo. Detalhes: ${error.message}` }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
      }
      break;
    }

    case 'setgroup': {
      if (!isGroupMessage) {
        await sendAndStore(sock, remoteJid, { text: GROUP_ONLY_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }
      if (!(await isUserAdmin(remoteJid, senderIdentity))) {
        await sendAndStore(sock, remoteJid, { text: NO_PERMISSION_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }

      if (args.length < 1 || !['announcement', 'not_announcement', 'locked', 'unlocked'].includes(args[0])) {
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: getAdminUsageText('setgroup', { commandPrefix }),
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }
      const setting = args[0];
      try {
        await updateGroupSettings(sock, remoteJid, setting);
        await sendAndStore(sock, remoteJid, { text: `Configuração do grupo atualizada com sucesso para: "${setting}".` }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
      } catch (error) {
        await sendAndStore(sock, remoteJid, { text: `Não foi possível alterar a configuração do grupo. Detalhes: ${error.message}` }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
      }
      break;
    }

    case 'leave': {
      if (!isGroupMessage) {
        await sendAndStore(sock, remoteJid, { text: GROUP_ONLY_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }
      if (!(await isUserAdmin(remoteJid, senderIdentity))) {
        await sendAndStore(sock, remoteJid, { text: NO_PERMISSION_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }
      try {
        await leaveGroup(sock, remoteJid);
        await sendAndStore(sock, remoteJid, { text: 'Saída do grupo concluída com sucesso.' }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
      } catch (error) {
        await sendAndStore(sock, remoteJid, { text: `Não foi possível sair do grupo. Detalhes: ${error.message}` }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
      }
      break;
    }

    case 'invite': {
      if (!isGroupMessage) {
        await sendAndStore(sock, remoteJid, { text: GROUP_ONLY_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }
      if (!(await isUserAdmin(remoteJid, senderIdentity))) {
        await sendAndStore(sock, remoteJid, { text: NO_PERMISSION_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }

      try {
        const code = await getGroupInviteCode(sock, remoteJid);
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: `Código de convite atual do grupo:
${code}`,
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
      } catch (error) {
        await sendAndStore(sock, remoteJid, { text: `Não foi possível obter o código de convite. Detalhes: ${error.message}` }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
      }
      break;
    }

    case 'revoke': {
      if (!isGroupMessage) {
        await sendAndStore(sock, remoteJid, { text: GROUP_ONLY_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }
      if (!(await isUserAdmin(remoteJid, senderIdentity))) {
        await sendAndStore(sock, remoteJid, { text: NO_PERMISSION_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }

      try {
        const code = await revokeGroupInviteCode(sock, remoteJid);
        await sendAndStore(sock, remoteJid, { text: `Código de convite anterior revogado com sucesso.\nNovo código: ${code}` }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
      } catch (error) {
        await sendAndStore(sock, remoteJid, { text: `Não foi possível revogar o código de convite. Detalhes: ${error.message}` }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
      }
      break;
    }

    case 'join': {
      if (args.length < 1) {
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: getAdminUsageText('join', { commandPrefix }),
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }
      const code = args[0];
      try {
        const response = await acceptGroupInvite(sock, code);
        await sendAndStore(sock, remoteJid, { text: `Entrada no grupo concluída com sucesso.\nIdentificador retornado: ${response}` }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
      } catch (error) {
        await sendAndStore(sock, remoteJid, { text: `Não foi possível entrar no grupo. Detalhes: ${error.message}` }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
      }
      break;
    }

    case 'infofrominvite': {
      if (args.length < 1) {
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: getAdminUsageText('infofrominvite', { commandPrefix }),
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }
      const code = args[0];
      try {
        const response = await getGroupInfoFromInvite(sock, code);
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: `Informações obtidas pelo convite:
${JSON.stringify(response, null, 2)}`,
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
      } catch (error) {
        await sendAndStore(sock, remoteJid, { text: `Não foi possível obter informações do grupo. Detalhes: ${error.message}` }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
      }
      break;
    }

    case 'metadata': {
      const groupId = args[0] || remoteJid;
      if (!(await isUserAdmin(groupId, senderJid))) {
        await sendAndStore(sock, remoteJid, { text: NO_PERMISSION_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }
      try {
        const metadata = getGroupInfo(groupId);
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: `Metadados do grupo:
${JSON.stringify(metadata, null, 2)}`,
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
      } catch (error) {
        await sendAndStore(sock, remoteJid, { text: `Não foi possível obter metadados do grupo. Detalhes: ${error.message}` }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
      }
      break;
    }

    case 'requests': {
      if (!isGroupMessage) {
        await sendAndStore(sock, remoteJid, { text: GROUP_ONLY_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }
      if (!(await isUserAdmin(remoteJid, senderIdentity))) {
        await sendAndStore(sock, remoteJid, { text: NO_PERMISSION_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }

      try {
        const response = await getGroupRequestParticipantsList(sock, remoteJid);
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: `Solicitações de entrada pendentes:
${JSON.stringify(response, null, 2)}`,
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
      } catch (error) {
        await sendAndStore(sock, remoteJid, { text: `Não foi possível listar solicitações de entrada. Detalhes: ${error.message}` }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
      }
      break;
    }

    case 'updaterequests': {
      if (!isGroupMessage) {
        await sendAndStore(sock, remoteJid, { text: GROUP_ONLY_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }
      if (!(await isUserAdmin(remoteJid, senderIdentity))) {
        await sendAndStore(sock, remoteJid, { text: NO_PERMISSION_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }

      if (args.length < 1 || !['approve', 'reject'].includes(args[0])) {
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: getAdminUsageText('updaterequests', {
              commandPrefix,
              variant: 'invalid_action',
            }),
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }
      const action = args[0];
      const participants = getParticipantJids(messageInfo, args.slice(1));
      if (participants.length === 0) {
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: getAdminUsageText('updaterequests', {
              commandPrefix,
              variant: 'missing_targets',
            }),
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }
      try {
        const response = await updateGroupRequestParticipants(sock, remoteJid, participants, action);
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: `Solicitações de entrada atualizadas com sucesso:
${JSON.stringify(response, null, 2)}`,
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
      } catch (error) {
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: `Não foi possível atualizar solicitações de entrada. Detalhes: ${error.message}`,
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
      }
      break;
    }

    case 'autorequests': {
      if (!isGroupMessage) {
        await sendAndStore(sock, remoteJid, { text: GROUP_ONLY_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }
      if (!(await isUserAdmin(remoteJid, senderIdentity))) {
        await sendAndStore(sock, remoteJid, { text: NO_PERMISSION_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }

      const action = args[0]?.toLowerCase();
      if (!action || !['on', 'off', 'status'].includes(action)) {
        await sendAndStore(sock, remoteJid, { text: getAdminUsageText('autorequests', { commandPrefix }) }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }

      if (action === 'status') {
        const config = await groupConfigStore.getGroupConfig(remoteJid);
        const enabled = Boolean(config.autoApproveRequestsEnabled);
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: `🤖 Auto-aprovação de solicitações: *${enabled ? 'ativada' : 'desativada'}*.\n` + 'Quando ativo, o bot aprova automaticamente novas solicitações de entrada.',
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }

      const enabled = action === 'on';
      await groupConfigStore.updateGroupConfig(remoteJid, {
        autoApproveRequestsEnabled: enabled,
      });
      await sendAndStore(
        sock,
        remoteJid,
        {
          text: enabled ? '✅ Auto-aprovação de solicitações ativada para este grupo.' : '🛑 Auto-aprovação de solicitações desativada para este grupo.',
        },
        { quoted: messageInfo, ephemeralExpiration: expirationMessage },
      );
      break;
    }

    case 'temp': {
      if (!isGroupMessage) {
        await sendAndStore(sock, remoteJid, { text: GROUP_ONLY_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }
      if (!(await isUserAdmin(remoteJid, senderIdentity))) {
        await sendAndStore(sock, remoteJid, { text: NO_PERMISSION_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }

      if (args.length < 1) {
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: getAdminUsageText('temp', { commandPrefix }),
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }
      const duration = parseInt(args[0]);
      try {
        await toggleEphemeral(sock, remoteJid, duration);
        await sendAndStore(sock, remoteJid, { text: `Configuração de mensagens temporárias atualizada para ${duration} segundos.` }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
      } catch (error) {
        await sendAndStore(sock, remoteJid, { text: `Não foi possível atualizar mensagens efêmeras. Detalhes: ${error.message}` }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
      }
      break;
    }

    case 'addmode': {
      if (!isGroupMessage) {
        await sendAndStore(sock, remoteJid, { text: GROUP_ONLY_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }
      if (!(await isUserAdmin(remoteJid, senderIdentity))) {
        await sendAndStore(sock, remoteJid, { text: NO_PERMISSION_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }

      if (args.length < 1 || !['all_member_add', 'admin_add'].includes(args[0])) {
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: getAdminUsageText('addmode', { commandPrefix }),
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }
      const mode = args[0];
      try {
        await updateGroupAddMode(sock, remoteJid, mode);
        await sendAndStore(sock, remoteJid, { text: `Modo de adição de membros atualizado com sucesso para: ${mode}.` }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
      } catch (error) {
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: `Não foi possível atualizar o modo de adição de membros. Detalhes: ${error.message}`,
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
      }
      break;
    }

    case 'prefix': {
      if (!isGroupMessage) {
        await sendAndStore(sock, remoteJid, { text: GROUP_ONLY_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }
      if (!(await isUserAdmin(remoteJid, senderIdentity))) {
        await sendAndStore(sock, remoteJid, { text: NO_PERMISSION_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }

      const rawPrefix = args[0]?.trim();
      const normalizedKeyword = rawPrefix?.toLowerCase();
      const usageText = getAdminUsageText('prefix', { commandPrefix });

      if (!rawPrefix) {
        await sendAndStore(sock, remoteJid, { text: usageText }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }

      if (['status', 'info'].includes(normalizedKeyword)) {
        const config = await groupConfigStore.getGroupConfig(remoteJid);
        const customPrefix = typeof config.commandPrefix === 'string' ? config.commandPrefix.trim() : '';
        const currentPrefix = customPrefix || DEFAULT_COMMAND_PREFIX;
        const isCustom = Boolean(customPrefix && customPrefix !== DEFAULT_COMMAND_PREFIX);
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: [`🔧 Prefixo ativo neste grupo: *${currentPrefix}*`, `Prefixo padrão global: *${DEFAULT_COMMAND_PREFIX}*`, isCustom ? '✅ Este grupo utiliza um prefixo personalizado.' : 'ℹ️ Este grupo utiliza o prefixo padrão.'].join('\n'),
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }

      if (['reset', 'default', 'padrao', 'padrão'].includes(normalizedKeyword)) {
        await groupConfigStore.updateGroupConfig(remoteJid, { commandPrefix: null });
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: `✅ Prefixo restaurado para o padrão global: *${DEFAULT_COMMAND_PREFIX}*`,
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }

      if (rawPrefix.length > 5) {
        await sendAndStore(sock, remoteJid, { text: '⚠️ Prefixo inválido: utilize no máximo 5 caracteres.' }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }

      if (/\s/.test(rawPrefix)) {
        await sendAndStore(sock, remoteJid, { text: '⚠️ Prefixo inválido: não utilize espaços.' }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }

      const newPrefix = rawPrefix;
      if (newPrefix === DEFAULT_COMMAND_PREFIX) {
        await groupConfigStore.updateGroupConfig(remoteJid, { commandPrefix: null });
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: `✅ Prefixo atualizado para o padrão global: *${DEFAULT_COMMAND_PREFIX}*`,
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }

      await groupConfigStore.updateGroupConfig(remoteJid, { commandPrefix: newPrefix });
      await sendAndStore(sock, remoteJid, { text: `✅ Prefixo deste grupo atualizado para: *${newPrefix}*` }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
      break;
    }

    case 'welcome': {
      if (!isGroupMessage) {
        await sendAndStore(sock, remoteJid, { text: GROUP_ONLY_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }

      const subCommandMatch = text.trimStart().match(/^(\S+)([\s\S]*)$/);
      const subCommand = subCommandMatch ? subCommandMatch[1].toLowerCase() : '';
      const messageOrPath = subCommandMatch ? subCommandMatch[2].trimStart() : '';

      if (!subCommand || !['on', 'off', 'set'].includes(subCommand)) {
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: getAdminUsageText('welcome', { commandPrefix }),
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }

      if (!(await isUserAdmin(remoteJid, senderIdentity))) {
        await sendAndStore(sock, remoteJid, { text: NO_PERMISSION_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }

      try {
        if (subCommand === 'on') {
          await groupConfigStore.updateGroupConfig(remoteJid, { welcomeMessageEnabled: true });
          await sendAndStore(sock, remoteJid, { text: 'Mensagens de boas-vindas ativadas com sucesso para este grupo.' }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        } else if (subCommand === 'off') {
          await groupConfigStore.updateGroupConfig(remoteJid, { welcomeMessageEnabled: false });
          await sendAndStore(sock, remoteJid, { text: 'Mensagens de boas-vindas desativadas com sucesso para este grupo.' }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        } else if (subCommand === 'set') {
          if (!messageOrPath && !(messageInfo.message.imageMessage || messageInfo.message.videoMessage)) {
            await sendAndStore(
              sock,
              remoteJid,
              {
                text: getAdminUsageText('welcome', {
                  commandPrefix,
                  variant: 'missing_content',
                }),
              },
              { quoted: messageInfo, ephemeralExpiration: expirationMessage },
            );
            break;
          }

          const quotedMessage = messageInfo.message?.extendedTextMessage?.contextInfo?.quotedMessage;
          let mediaToDownload = null;
          let mediaType = null;

          if (messageInfo.message.imageMessage) {
            mediaToDownload = messageInfo.message.imageMessage;
            mediaType = 'image';
          } else if (messageInfo.message.videoMessage) {
            mediaToDownload = messageInfo.message.videoMessage;
            mediaType = 'video';
          } else if (quotedMessage) {
            if (quotedMessage.imageMessage) {
              mediaToDownload = quotedMessage.imageMessage;
              mediaType = 'image';
            } else if (quotedMessage.videoMessage) {
              mediaToDownload = quotedMessage.videoMessage;
              mediaType = 'video';
            }
          }

          if (mediaToDownload) {
            const downloadedMediaPath = await downloadMediaMessage(mediaToDownload, mediaType, './temp');
            if (downloadedMediaPath) {
              await groupConfigStore.updateGroupConfig(remoteJid, {
                welcomeMedia: downloadedMediaPath,
              });
              await sendAndStore(sock, remoteJid, { text: `Mídia de boas-vindas configurada com sucesso: ${downloadedMediaPath}` }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
            } else {
              await sendAndStore(
                sock,
                remoteJid,
                {
                  text: 'Não foi possível processar a mídia informada. Tente novamente em instantes.',
                },
                { quoted: messageInfo, ephemeralExpiration: expirationMessage },
              );
            }
          } else if (messageOrPath.startsWith('/') || messageOrPath.startsWith('.') || messageOrPath.startsWith('~')) {
            await groupConfigStore.updateGroupConfig(remoteJid, {
              welcomeMedia: messageOrPath,
            });
            await sendAndStore(sock, remoteJid, { text: `Mídia de boas-vindas configurada com sucesso: ${messageOrPath}` }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
          } else {
            await groupConfigStore.updateGroupConfig(remoteJid, {
              welcomeMessage: messageOrPath,
            });
            await sendAndStore(sock, remoteJid, { text: `Mensagem de boas-vindas configurada com sucesso: ${messageOrPath}` }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
          }
        }
      } catch (error) {
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: `Não foi possível configurar mensagens de boas-vindas. Detalhes: ${error.message}`,
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
      }
      break;
    }

    case 'farewell': {
      if (!isGroupMessage) {
        await sendAndStore(sock, remoteJid, { text: GROUP_ONLY_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }
      if (!(await isUserAdmin(remoteJid, senderIdentity))) {
        await sendAndStore(sock, remoteJid, { text: NO_PERMISSION_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }
      const subCommandMatch = text.trimStart().match(/^(\S+)([\s\S]*)$/);
      const subCommand = subCommandMatch ? subCommandMatch[1].toLowerCase() : '';
      const messageOrPath = subCommandMatch ? subCommandMatch[2].trimStart() : '';

      if (!subCommand || !['on', 'off', 'set'].includes(subCommand)) {
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: getAdminUsageText('farewell', { commandPrefix }),
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }

      try {
        if (subCommand === 'on') {
          await groupConfigStore.updateGroupConfig(remoteJid, { farewellMessageEnabled: true });
          await sendAndStore(sock, remoteJid, { text: 'Mensagens de saída ativadas com sucesso para este grupo.' }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        } else if (subCommand === 'off') {
          await groupConfigStore.updateGroupConfig(remoteJid, { farewellMessageEnabled: false });
          await sendAndStore(sock, remoteJid, { text: 'Mensagens de saída desativadas com sucesso para este grupo.' }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        } else if (subCommand === 'set') {
          if (!messageOrPath && !(messageInfo.message.imageMessage || messageInfo.message.videoMessage)) {
            await sendAndStore(
              sock,
              remoteJid,
              {
                text: getAdminUsageText('farewell', {
                  commandPrefix,
                  variant: 'missing_content',
                }),
              },
              { quoted: messageInfo, ephemeralExpiration: expirationMessage },
            );
            break;
          }

          const quotedMessage = messageInfo.message?.extendedTextMessage?.contextInfo?.quotedMessage;
          let mediaToDownload = null;
          let mediaType = null;

          if (messageInfo.message.imageMessage) {
            mediaToDownload = messageInfo.message.imageMessage;
            mediaType = 'image';
          } else if (messageInfo.message.videoMessage) {
            mediaToDownload = messageInfo.message.videoMessage;
            mediaType = 'video';
          } else if (quotedMessage) {
            if (quotedMessage.imageMessage) {
              mediaToDownload = quotedMessage.imageMessage;
              mediaType = 'image';
            } else if (quotedMessage.videoMessage) {
              mediaToDownload = quotedMessage.videoMessage;
              mediaType = 'video';
            }
          }

          if (mediaToDownload) {
            const downloadedMediaPath = await downloadMediaMessage(mediaToDownload, mediaType, './temp');
            if (downloadedMediaPath) {
              await groupConfigStore.updateGroupConfig(remoteJid, {
                farewellMedia: downloadedMediaPath,
              });
              await sendAndStore(sock, remoteJid, { text: `Mídia de saída configurada com sucesso: ${downloadedMediaPath}` }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
            } else {
              await sendAndStore(
                sock,
                remoteJid,
                {
                  text: 'Não foi possível processar a mídia informada. Tente novamente em instantes.',
                },
                { quoted: messageInfo, ephemeralExpiration: expirationMessage },
              );
            }
          } else if (messageOrPath.startsWith('/') || messageOrPath.startsWith('.') || messageOrPath.startsWith('~')) {
            await groupConfigStore.updateGroupConfig(remoteJid, {
              farewellMedia: messageOrPath,
            });
            await sendAndStore(sock, remoteJid, { text: `Mídia de saída configurada com sucesso: ${messageOrPath}` }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
          } else {
            await groupConfigStore.updateGroupConfig(remoteJid, {
              farewellMessage: messageOrPath,
            });
            await sendAndStore(sock, remoteJid, { text: `Mensagem de saída configurada com sucesso: ${messageOrPath}` }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
          }
        }
      } catch (error) {
        await sendAndStore(sock, remoteJid, { text: `Não foi possível configurar mensagens de saída. Detalhes: ${error.message}` }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
      }
      break;
    }

    case 'captcha': {
      if (!isGroupMessage) {
        await sendAndStore(sock, remoteJid, { text: GROUP_ONLY_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }
      if (!(await isUserAdmin(remoteJid, senderIdentity))) {
        await sendAndStore(sock, remoteJid, { text: NO_PERMISSION_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }

      const action = args[0]?.toLowerCase();
      if (!action || !['on', 'off', 'status'].includes(action)) {
        await sendAndStore(sock, remoteJid, { text: getAdminUsageText('captcha', { commandPrefix }) }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }

      if (action === 'status') {
        const config = await groupConfigStore.getGroupConfig(remoteJid);
        const enabled = Boolean(config.captchaEnabled);
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: `🤖 Captcha neste grupo: *${enabled ? 'ativado' : 'desativado'}*.\n` + 'Quando ativo, novos membros precisam reagir ou enviar uma mensagem em até 5 minutos.',
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }

      const enabled = action === 'on';
      await groupConfigStore.updateGroupConfig(remoteJid, { captchaEnabled: enabled });
      if (!enabled) {
        clearCaptchasForGroup(remoteJid, 'disabled');
      }
      await sendAndStore(
        sock,
        remoteJid,
        {
          text: enabled ? '✅ Captcha ativado. Novos membros terão 5 minutos para reagir ou enviar mensagem.' : '🛑 Captcha desativado para este grupo.',
        },
        { quoted: messageInfo, ephemeralExpiration: expirationMessage },
      );
      break;
    }

    case 'antilink': {
      if (!isGroupMessage) {
        await sendAndStore(sock, remoteJid, { text: GROUP_ONLY_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }
      if (!(await isUserAdmin(remoteJid, senderIdentity))) {
        await sendAndStore(sock, remoteJid, { text: NO_PERMISSION_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }

      const subCommand = args[0] ? args[0].toLowerCase() : '';
      const currentConfig = await groupConfigStore.getGroupConfig(remoteJid);
      const allowedNetworks = currentConfig.antilinkAllowedNetworks || [];
      const allowedDomains = currentConfig.antilinkAllowedDomains || [];
      const availableNetworks = Object.keys(KNOWN_NETWORKS).sort();

      const parseNetworks = (inputArgs) => {
        const raw = inputArgs.flatMap((value) => value.split(','));
        return raw.map((value) => value.trim().toLowerCase()).filter(Boolean);
      };

      const formatNetworkList = (networks) => (networks.length ? networks.join(', ') : 'nenhuma');

      if (!['on', 'off'].includes(subCommand)) {
        if (subCommand === 'list') {
          const status = currentConfig.antilinkEnabled ? 'ativado' : 'desativado';
          await sendAndStore(
            sock,
            remoteJid,
            {
              text: `📋 *Antilink - Configuração atual*\n` + `Status: *${status}*\n\n` + `✅ *Redes permitidas*\n${formatNetworkList(allowedNetworks)}\n\n` + `✅ *Domínios permitidos*\n${formatNetworkList(allowedDomains)}\n\n` + `🧭 *Redes disponíveis*\n${availableNetworks.join(', ')}`,
            },
            { quoted: messageInfo, ephemeralExpiration: expirationMessage },
          );
          break;
        }

        if (subCommand === 'allow' || subCommand === 'disallow') {
          const requestedNetworks = parseNetworks(args.slice(1));
          const validNetworks = requestedNetworks.filter((name) => KNOWN_NETWORKS[name]);
          const invalidNetworks = requestedNetworks.filter((name) => !KNOWN_NETWORKS[name]);

          if (validNetworks.length === 0) {
            await sendAndStore(
              sock,
              remoteJid,
              {
                text: `${getAdminUsageText('antilink', { commandPrefix, variant: subCommand })}\n` + `Redes disponíveis: ${availableNetworks.join(', ')}`,
              },
              { quoted: messageInfo, ephemeralExpiration: expirationMessage },
            );
            break;
          }

          const updatedNetworks = subCommand === 'allow' ? Array.from(new Set([...allowedNetworks, ...validNetworks])) : allowedNetworks.filter((name) => !validNetworks.includes(name));

          await groupConfigStore.updateGroupConfig(remoteJid, {
            antilinkAllowedNetworks: updatedNetworks,
          });

          const invalidNote = invalidNetworks.length ? `\nIgnorados: ${invalidNetworks.join(', ')}` : '';
          await sendAndStore(
            sock,
            remoteJid,
            {
              text: `Redes permitidas atualizadas: ${formatNetworkList(updatedNetworks)}${invalidNote}`,
            },
            { quoted: messageInfo, ephemeralExpiration: expirationMessage },
          );
          break;
        }

        if (subCommand === 'add' || subCommand === 'remove') {
          const requestedDomains = parseNetworks(args.slice(1));
          const normalizedDomains = requestedDomains.map((domain) =>
            domain
              .replace(/^https?:\/\//, '')
              .replace(/^www\./, '')
              .replace(/\/.*$/, ''),
          );

          if (normalizedDomains.length === 0) {
            await sendAndStore(
              sock,
              remoteJid,
              {
                text: getAdminUsageText('antilink', { commandPrefix, variant: subCommand }),
              },
              { quoted: messageInfo, ephemeralExpiration: expirationMessage },
            );
            break;
          }

          const updatedDomains = subCommand === 'add' ? Array.from(new Set([...allowedDomains, ...normalizedDomains])) : allowedDomains.filter((domain) => !normalizedDomains.includes(domain));

          await groupConfigStore.updateGroupConfig(remoteJid, {
            antilinkAllowedDomains: updatedDomains,
          });
          await sendAndStore(sock, remoteJid, { text: `Domínios permitidos atualizados: ${formatNetworkList(updatedDomains)}` }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
          break;
        }

        const status = currentConfig.antilinkEnabled ? 'ativado' : 'desativado';
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: `📌 *Guia de uso do Antilink*\n` + `Status atual: *${status}*\n\n` + `✅ *${commandPrefix}antilink on*\nAtiva o bloqueio de links no grupo.\n\n` + `⛔ *${commandPrefix}antilink off*\nDesativa o bloqueio de links no grupo.\n\n` + `📋 *${commandPrefix}antilink list*\nExibe as redes e os domínios permitidos.\n\n` + `➕ *${commandPrefix}antilink allow <rede>*\nPermite uma rede conhecida (ex.: youtube, instagram).\n\n` + `➖ *${commandPrefix}antilink disallow <rede>*\nRemove uma rede conhecida da lista permitida.\n\n` + `🌐 *${commandPrefix}antilink add <dominio>*\nPermite um domínio específico (ex.: exemplo.com).\n\n` + `🗑️ *${commandPrefix}antilink remove <dominio>*\nRemove um domínio específico da lista permitida.\n\n` + `ℹ️ Dica: use *${commandPrefix}antilink list* para consultar as redes disponíveis.`,
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }

      try {
        const isEnabled = subCommand === 'on';
        await groupConfigStore.updateGroupConfig(remoteJid, { antilinkEnabled: isEnabled });
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: `✅ Recurso Antilink ${isEnabled ? 'ativado' : 'desativado'} com sucesso neste grupo.`,
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
      } catch (error) {
        logger.error('Erro ao configurar o antilink:', {
          error: error.message,
          groupId: remoteJid,
        });
        await sendAndStore(sock, remoteJid, { text: `Não foi possível configurar o antilink. Detalhes: ${error.message}` }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
      }
      break;
    }

    case 'noticiasfiltro': {
      if (!isGroupMessage) {
        await sendAndStore(sock, remoteJid, { text: GROUP_ONLY_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }
      if (!(await isUserAdmin(remoteJid, senderIdentity))) {
        await sendAndStore(sock, remoteJid, { text: NO_PERMISSION_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }

      const groupConfig = await groupConfigStore.getGroupConfig(remoteJid);
      const currentFilters = normalizeNewsFilterState(groupConfig);
      const scope = String(args[0] || '')
        .trim()
        .toLowerCase();
      const scopeToKey = {
        source: 'sourceIds',
        franchise: 'franchiseSlugs',
        tag: 'entitySlugs',
        entity: 'entitySlugs',
      };

      const buildStatusText = (filters) => ['🧪 *Filtros de notícias deste grupo*', '', `Sources: ${formatListForMessage(filters.sourceIds)}`, `Franchises: ${formatListForMessage(filters.franchiseSlugs)}`, `Tags/Entities: ${formatListForMessage(filters.entitySlugs)}`, `Somente em alta: *${filters.onlyTrending ? 'sim' : 'não'}*`, '', 'Exemplos:', `${commandPrefix}noticiasfiltro source add ann,mal`, `${commandPrefix}noticiasfiltro franchise add one-piece`, `${commandPrefix}noticiasfiltro tag add shounen`, `${commandPrefix}noticiasfiltro trending on`].join('\n');

      if (!scope || scope === 'status' || scope === 'list') {
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: buildStatusText(currentFilters),
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }

      if (scope === 'reset') {
        const resetFilters = {
          sourceIds: [],
          franchiseSlugs: [],
          entitySlugs: [],
          onlyTrending: false,
        };
        await groupConfigStore.updateGroupConfig(remoteJid, buildNewsFilterConfigPatch(groupConfig, resetFilters));
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: '✅ Filtros de notícias resetados com sucesso.',
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }

      if (scope === 'trending') {
        const action = String(args[1] || '')
          .trim()
          .toLowerCase();
        if (!action || !['on', 'off', 'status'].includes(action)) {
          await sendAndStore(
            sock,
            remoteJid,
            {
              text: getAdminUsageText('noticiasfiltro', { commandPrefix, variant: 'trending' }),
            },
            { quoted: messageInfo, ephemeralExpiration: expirationMessage },
          );
          break;
        }

        if (action === 'status') {
          await sendAndStore(
            sock,
            remoteJid,
            {
              text: `📈 Filtro "somente em alta" está *${currentFilters.onlyTrending ? 'ativado' : 'desativado'}*.`,
            },
            { quoted: messageInfo, ephemeralExpiration: expirationMessage },
          );
          break;
        }

        const nextFilters = {
          ...currentFilters,
          onlyTrending: action === 'on',
        };
        await groupConfigStore.updateGroupConfig(remoteJid, buildNewsFilterConfigPatch(groupConfig, nextFilters));
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: `✅ Filtro "somente em alta" ${nextFilters.onlyTrending ? 'ativado' : 'desativado'} com sucesso.`,
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }

      const filterKey = scopeToKey[scope];
      if (!filterKey) {
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: getAdminUsageText('noticiasfiltro', { commandPrefix, variant: 'invalid_scope' }),
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }

      const action = String(args[1] || '')
        .trim()
        .toLowerCase();
      if (!action || !['add', 'remove', 'list', 'clear'].includes(action)) {
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: getAdminUsageText('noticiasfiltro', { commandPrefix, variant: 'invalid_action' }),
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }

      const scopeLabel = filterKey === 'sourceIds' ? 'sources' : filterKey === 'franchiseSlugs' ? 'franchises' : 'tags/entities';

      if (action === 'list') {
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: `📋 Filtro de notícias (${scopeLabel}): ${formatListForMessage(currentFilters[filterKey])}`,
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }

      if (action === 'clear') {
        const nextFilters = {
          ...currentFilters,
          [filterKey]: [],
        };
        await groupConfigStore.updateGroupConfig(remoteJid, buildNewsFilterConfigPatch(groupConfig, nextFilters));
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: `✅ Filtro de notícias (${scopeLabel}) limpo com sucesso.`,
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }

      const values = parseFilterValues(args.slice(2));
      if (values.length === 0) {
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: getAdminUsageText('noticiasfiltro', { commandPrefix, variant: 'missing_values' }),
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }

      const currentSet = new Set(currentFilters[filterKey]);
      if (action === 'add') {
        values.forEach((value) => currentSet.add(value));
      } else {
        values.forEach((value) => currentSet.delete(value));
      }

      const nextFilters = {
        ...currentFilters,
        [filterKey]: Array.from(currentSet).sort((left, right) => left.localeCompare(right)),
      };
      await groupConfigStore.updateGroupConfig(remoteJid, buildNewsFilterConfigPatch(groupConfig, nextFilters));
      await sendAndStore(
        sock,
        remoteJid,
        {
          text: `✅ Filtro de notícias (${scopeLabel}) atualizado: ${formatListForMessage(nextFilters[filterKey])}`,
        },
        { quoted: messageInfo, ephemeralExpiration: expirationMessage },
      );
      break;
    }

    case 'grupoaudit': {
      if (!isGroupMessage) {
        await sendAndStore(sock, remoteJid, { text: GROUP_ONLY_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }
      if (!(await isUserAdmin(remoteJid, senderIdentity))) {
        await sendAndStore(sock, remoteJid, { text: NO_PERMISSION_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }

      const groupConfig = await groupConfigStore.getGroupConfig(remoteJid);
      const stickerState = resolveStickerFocusState(groupConfig);
      const newsStatus = await getNewsStatusForGroup(remoteJid);
      const auditText = buildGroupAuditText({
        config: groupConfig,
        stickerState,
        newsStatus,
        commandPrefix,
      });

      await sendAndStore(
        sock,
        remoteJid,
        {
          text: auditText,
        },
        { quoted: messageInfo, ephemeralExpiration: expirationMessage },
      );
      break;
    }

    case 'noticias': {
      if (!isGroupMessage) {
        await sendAndStore(sock, remoteJid, { text: GROUP_ONLY_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }
      if (!(await isUserAdmin(remoteJid, senderIdentity))) {
        await sendAndStore(sock, remoteJid, { text: NO_PERMISSION_COMMAND_MESSAGE }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        break;
      }

      const action = args[0]?.toLowerCase();
      if (!action || !['on', 'off', 'status'].includes(action)) {
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: getAdminUsageText('noticias', { commandPrefix }),
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }

      if (action === 'status') {
        const status = await getNewsStatusForGroup(remoteJid);
        const enabledText = status.enabled ? 'ATIVADO' : 'DESATIVADO';
        const lastSent = status.lastSentAt ? `\nÚltimo envio: ${status.lastSentAt}` : '';
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: `📰 Status de notícias neste grupo: *${enabledText.toLowerCase()}*.\nTotal de envios: ${status.sentCount}.${lastSent}`,
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
        break;
      }

      const enableNews = action === 'on';
      await groupConfigStore.updateGroupConfig(remoteJid, { newsEnabled: enableNews });
      if (enableNews) {
        startNewsBroadcastForGroup(remoteJid);
        await sendAndStore(
          sock,
          remoteJid,
          {
            text: '📰 Envio automático de notícias ativado. As atualizações serão enviadas com intervalo aproximado de 1 a 2 minutos.',
          },
          { quoted: messageInfo, ephemeralExpiration: expirationMessage },
        );
      } else {
        stopNewsBroadcastForGroup(remoteJid);
        await sendAndStore(sock, remoteJid, { text: '🛑 Envio automático de notícias desativado para este grupo.' }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
      }
      break;
    }

    default:
      break;
  }

  return true;
}
