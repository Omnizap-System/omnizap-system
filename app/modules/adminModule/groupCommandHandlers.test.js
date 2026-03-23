import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, test } from 'node:test';

const OWNER_PHONE = '5511999999999';
const OWNER_JID = `${OWNER_PHONE}@s.whatsapp.net`;
const NON_ADMIN_JID = '5511888888888@s.whatsapp.net';
const TARGET_JID = '5511777777777@s.whatsapp.net';
const BOT_JID = '5511666666666@s.whatsapp.net';
const GROUP_JID = '120363111111111111@g.us';

const ENV_OVERRIDES = {
  DB_HOST: '127.0.0.1',
  DB_USER: 'root',
  DB_PASSWORD: 'root',
  DB_NAME: 'omnizap_test',
  DB_MONITOR_ENABLED: 'false',
  METRICS_ENABLED: 'false',
  ADMIN_AI_HELP_SCHEDULER_ENABLED: 'false',
  WHATSAPP_ADMIN_JID: OWNER_JID,
  USER_ADMIN: OWNER_PHONE,
};

const previousEnv = new Map();
for (const [key, value] of Object.entries(ENV_OVERRIDES)) {
  previousEnv.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : null);
  process.env[key] = value;
}

const originalArgv1 = process.argv[1];
process.argv[1] = new URL('../../../database/init.js', import.meta.url).pathname;

let pool;
let handleAdminCommand;
let isAdminCommand;
let getAdminTextConfig;
let stopAdminAiHelpSchedulerForTests;

try {
  ({ pool } = await import('../../../database/index.js'));
  ({ handleAdminCommand, isAdminCommand } = await import('./groupCommandHandlers.js'));
  ({ getAdminTextConfig } = await import('./adminConfigRuntime.js'));
  ({ stopAdminAiHelpSchedulerForTests } = await import('./adminAiHelpService.js'));
} finally {
  process.argv[1] = originalArgv1;
}

const originalPoolExecute = pool.execute.bind(pool);
const originalPoolQuery = pool.query.bind(pool);

const normalizeSql = (sql) =>
  String(sql || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const createDbHarness = () => {
  const groupConfigRows = new Map();
  const groupMetadataRows = new Map();
  const premiumUserRows = new Set();
  const groupUserWarningsRows = [];
  let warningAutoIncrement = 1;

  const execute = async (sql, params = []) => {
    const normalized = normalizeSql(sql);
    const normalizedNoTicks = normalized.replaceAll('`', '');

    if (normalizedNoTicks.startsWith('select * from groups_metadata where id = ?')) {
      const row = groupMetadataRows.get(params[0]);
      return [[row].filter(Boolean), []];
    }

    if (normalizedNoTicks.startsWith('select * from group_configs where id = ?')) {
      const row = groupConfigRows.get(params[0]);
      return [[row].filter(Boolean), []];
    }

    if (normalizedNoTicks.startsWith('insert into group_configs')) {
      const [id, config] = params;
      groupConfigRows.set(id, { id, config: String(config) });
      return [{ affectedRows: 1 }, []];
    }

    if (normalizedNoTicks.startsWith('select id from system_premium_users')) {
      const rows = Array.from(premiumUserRows.values())
        .sort((left, right) => String(left).localeCompare(String(right)))
        .map((id) => ({ id }));
      return [rows, []];
    }

    if (normalizedNoTicks.startsWith('delete from system_premium_users')) {
      premiumUserRows.clear();
      return [{ affectedRows: 1 }, []];
    }

    if (normalizedNoTicks.startsWith('insert into system_premium_users')) {
      const [id] = params;
      premiumUserRows.add(String(id || ''));
      return [{ affectedRows: 1 }, []];
    }

    if (normalizedNoTicks.startsWith('insert into group_user_warnings')) {
      const [groupId, participantJid, warnedByJid, reason] = params;
      groupUserWarningsRows.push({
        id: warningAutoIncrement++,
        group_id: String(groupId || ''),
        participant_jid: String(participantJid || '').toLowerCase(),
        warned_by_jid: warnedByJid ? String(warnedByJid).toLowerCase() : null,
        reason: reason ? String(reason) : null,
        created_at: new Date(__timeNowMs()).toISOString(),
      });
      return [{ affectedRows: 1 }, []];
    }

    if (normalizedNoTicks.startsWith('select count(*) as total from group_user_warnings')) {
      const [groupId, participantJid] = params;
      const filtered = groupUserWarningsRows.filter((row) => row.group_id === String(groupId || '') && row.participant_jid === String(participantJid || '').toLowerCase());
      return [[{ total: filtered.length }], []];
    }

    if (normalizedNoTicks.startsWith('select id, group_id, participant_jid, warned_by_jid, reason, created_at from group_user_warnings')) {
      const [groupId, participantJid, limit] = params;
      const safeLimit = Number.parseInt(String(limit || 0), 10);
      const filtered = groupUserWarningsRows
        .filter((row) => row.group_id === String(groupId || '') && row.participant_jid === String(participantJid || '').toLowerCase())
        .sort((left, right) => right.id - left.id)
        .slice(0, Number.isFinite(safeLimit) && safeLimit > 0 ? safeLimit : 20)
        .map((row) => ({ ...row }));
      return [filtered, []];
    }

    if (normalizedNoTicks.startsWith('delete from group_user_warnings') && normalizedNoTicks.includes('order by id desc limit ?')) {
      const [groupId, participantJid, limit] = params;
      const safeGroupId = String(groupId || '');
      const safeParticipantJid = String(participantJid || '').toLowerCase();
      const safeLimit = Number.parseInt(String(limit || 0), 10);
      const rowsToDelete = groupUserWarningsRows
        .filter((row) => row.group_id === safeGroupId && row.participant_jid === safeParticipantJid)
        .sort((left, right) => right.id - left.id)
        .slice(0, Number.isFinite(safeLimit) && safeLimit > 0 ? safeLimit : 1)
        .map((row) => row.id);

      if (rowsToDelete.length > 0) {
        for (let index = groupUserWarningsRows.length - 1; index >= 0; index -= 1) {
          if (!rowsToDelete.includes(groupUserWarningsRows[index].id)) continue;
          groupUserWarningsRows.splice(index, 1);
        }
      }

      return [{ affectedRows: rowsToDelete.length }, []];
    }

    if (normalizedNoTicks.startsWith('delete from group_user_warnings')) {
      const [groupId, participantJid] = params;
      const safeGroupId = String(groupId || '');
      const safeParticipantJid = String(participantJid || '').toLowerCase();
      let removed = 0;
      for (let index = groupUserWarningsRows.length - 1; index >= 0; index -= 1) {
        if (groupUserWarningsRows[index].group_id !== safeGroupId || groupUserWarningsRows[index].participant_jid !== safeParticipantJid) continue;
        groupUserWarningsRows.splice(index, 1);
        removed += 1;
      }
      return [{ affectedRows: removed }, []];
    }

    if (normalizedNoTicks.includes('from lid_map') || normalizedNoTicks.includes('into lid_map') || normalizedNoTicks.startsWith('update messages')) {
      return [[], []];
    }

    throw new Error(`Unhandled SQL in admin command tests: ${normalized}`);
  };

  const setGroupParticipants = (groupId, participants) => {
    groupMetadataRows.set(groupId, {
      id: groupId,
      participants: JSON.stringify(participants),
    });
  };

  const setGroupConfig = (groupId, config) => {
    groupConfigRows.set(groupId, {
      id: groupId,
      config: JSON.stringify(config),
    });
  };

  const getGroupConfig = (groupId) => {
    const row = groupConfigRows.get(groupId);
    return row ? JSON.parse(row.config) : {};
  };

  const setPremiumUsers = (premiumUsers) => {
    premiumUserRows.clear();
    for (const premiumUser of premiumUsers || []) {
      premiumUserRows.add(String(premiumUser || ''));
    }
  };

  return {
    execute,
    setGroupParticipants,
    setGroupConfig,
    getGroupConfig,
    setPremiumUsers,
  };
};

const createSockStub = () => {
  const messages = [];
  const participantUpdates = [];

  return {
    messages,
    participantUpdates,
    sock: {
      user: { id: BOT_JID },
      sendMessage: async (jid, content, options) => {
        messages.push({ jid, content, options });
        return {
          key: { remoteJid: jid },
          message: content,
          messageTimestamp: Math.floor(__timeNowMs() / 1000),
        };
      },
      groupParticipantsUpdate: async (groupId, participants, action) => {
        participantUpdates.push({ groupId, participants, action });
        return [{ groupId, participants, action }];
      },
    },
  };
};

const buildMessageInfo = (participant = OWNER_JID, { mentionedJid = [], replyParticipant = '' } = {}) => {
  const contextInfo = {};
  if (Array.isArray(mentionedJid) && mentionedJid.length > 0) {
    contextInfo.mentionedJid = mentionedJid;
  }
  if (replyParticipant) {
    contextInfo.participant = replyParticipant;
  }

  return {
    key: { participant },
    message: Object.keys(contextInfo).length
      ? {
          extendedTextMessage: {
            contextInfo,
          },
        }
      : {},
  };
};

const runAdminCommand = async ({ command, args = [], text = args.join(' '), sock, senderJid = OWNER_JID, remoteJid = GROUP_JID, isGroupMessage = true, messageInfo, botJid = BOT_JID }) =>
  handleAdminCommand({
    command,
    args,
    text,
    sock,
    messageInfo: messageInfo || buildMessageInfo(senderJid),
    remoteJid,
    senderJid,
    botJid,
    isGroupMessage,
    expirationMessage: 0,
    commandPrefix: '/',
  });

let dbHarness;

beforeEach(() => {
  dbHarness = createDbHarness();
  pool.execute = dbHarness.execute;
  pool.query = dbHarness.execute;
});

afterEach(() => {
  pool.execute = originalPoolExecute;
  pool.query = originalPoolQuery;
});

after(() => {
  stopAdminAiHelpSchedulerForTests();
  for (const [key, value] of previousEnv.entries()) {
    if (value === null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

test('isAdminCommand reconhece comandos válidos', () => {
  assert.equal(isAdminCommand('nsfw'), true);
  assert.equal(isAdminCommand('banir'), true);
  assert.equal(isAdminCommand('warn'), true);
  assert.equal(isAdminCommand('warnings'), true);
  assert.equal(isAdminCommand('clearwarn'), true);
  assert.equal(isAdminCommand('warnlimit'), true);
  assert.equal(isAdminCommand('stickerallowance'), true);
  assert.equal(isAdminCommand('noticiasfiltro'), true);
  assert.equal(isAdminCommand('grupoaudit'), true);
  assert.equal(isAdminCommand('comando-inexistente'), false);
});

test('handleAdminCommand retorna false para comando desconhecido', async () => {
  const { sock, messages } = createSockStub();
  const handled = await runAdminCommand({
    command: 'comando-inexistente',
    sock,
  });
  assert.equal(handled, false);
  assert.equal(messages.length, 0);
});

test('nsfw em conversa privada retorna aviso de comando exclusivo de grupo', async () => {
  const { sock, messages } = createSockStub();
  const texts = getAdminTextConfig();

  await runAdminCommand({
    command: 'nsfw',
    args: ['on'],
    sock,
    isGroupMessage: false,
    remoteJid: NON_ADMIN_JID,
    senderJid: NON_ADMIN_JID,
    messageInfo: buildMessageInfo(NON_ADMIN_JID),
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].content.text, texts.group_only_command_message);
});

test('nsfw bloqueia usuário sem privilégio de admin', async () => {
  const { sock, messages } = createSockStub();
  const texts = getAdminTextConfig();

  dbHarness.setGroupParticipants(GROUP_JID, [{ id: NON_ADMIN_JID }]);

  await runAdminCommand({
    command: 'nsfw',
    args: ['on'],
    sock,
    senderJid: NON_ADMIN_JID,
    messageInfo: buildMessageInfo(NON_ADMIN_JID),
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].content.text, texts.no_permission_command_message);
  assert.equal(dbHarness.getGroupConfig(GROUP_JID).nsfwEnabled, undefined);
});

test('nsfw on e status persistem configuração para admin', async () => {
  const { sock, messages } = createSockStub();

  dbHarness.setGroupParticipants(GROUP_JID, [{ id: OWNER_JID, admin: 'admin' }]);

  await runAdminCommand({
    command: 'nsfw',
    args: ['on'],
    sock,
  });

  await runAdminCommand({
    command: 'nsfw',
    args: ['status'],
    sock,
  });

  assert.equal(dbHarness.getGroupConfig(GROUP_JID).nsfwEnabled, true);
  assert.equal(messages.length, 2);
  assert.match(messages[0].content.text, /Configuração NSFW atualizada/i);
  assert.match(messages[1].content.text, /\*ativado\*/i);
});

test('add normaliza alvos e executa atualização de participantes', async () => {
  const { sock, messages, participantUpdates } = createSockStub();
  dbHarness.setGroupParticipants(GROUP_JID, [{ id: OWNER_JID, admin: 'admin' }]);

  await runAdminCommand({
    command: 'add',
    args: [TARGET_JID, TARGET_JID],
    sock,
  });

  assert.equal(participantUpdates.length, 1);
  assert.deepEqual(participantUpdates[0], {
    groupId: GROUP_JID,
    participants: [TARGET_JID],
    action: 'add',
  });
  assert.equal(messages[messages.length - 1].content.text, 'Participantes adicionados com sucesso.');
});

test('ban bloqueia tentativa de remover o próprio bot', async () => {
  const { sock, messages, participantUpdates } = createSockStub();
  dbHarness.setGroupParticipants(GROUP_JID, [{ id: OWNER_JID, admin: 'admin' }]);

  await runAdminCommand({
    command: 'ban',
    args: [BOT_JID],
    sock,
  });

  assert.equal(participantUpdates.length, 0);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].content.text, 'Operação cancelada: o bot não pode remover a própria conta.');
});

test('warn registra advertência e warnings lista histórico', async () => {
  const { sock, messages } = createSockStub();
  dbHarness.setGroupParticipants(GROUP_JID, [{ id: OWNER_JID, admin: 'admin' }]);

  await runAdminCommand({
    command: 'warn',
    args: ['@alvo', 'spam', 'repetitivo'],
    sock,
    messageInfo: buildMessageInfo(OWNER_JID, { mentionedJid: [TARGET_JID] }),
  });

  assert.match(messages[messages.length - 1].content.text, /Advertência registrada/i);
  assert.match(messages[messages.length - 1].content.text, /spam repetitivo/i);

  await runAdminCommand({
    command: 'warnings',
    args: [],
    sock,
    messageInfo: buildMessageInfo(OWNER_JID, { replyParticipant: TARGET_JID }),
  });

  assert.match(messages[messages.length - 1].content.text, /Histórico de advertências/i);
  assert.match(messages[messages.length - 1].content.text, /Total neste grupo: \*1\*/i);
  assert.match(messages[messages.length - 1].content.text, /spam repetitivo/i);
});

test('warn aplica auto-ban no limite padrão de 3 advertências', async () => {
  const { sock, messages, participantUpdates } = createSockStub();
  dbHarness.setGroupParticipants(GROUP_JID, [{ id: OWNER_JID, admin: 'admin' }]);

  await runAdminCommand({
    command: 'warn',
    args: [TARGET_JID, 'motivo-1'],
    sock,
  });
  await runAdminCommand({
    command: 'warn',
    args: [TARGET_JID, 'motivo-2'],
    sock,
  });
  await runAdminCommand({
    command: 'warn',
    args: [TARGET_JID, 'motivo-3'],
    sock,
  });

  assert.equal(participantUpdates.length, 1);
  assert.deepEqual(participantUpdates[0], {
    groupId: GROUP_JID,
    participants: [TARGET_JID],
    action: 'remove',
  });
  assert.match(messages[messages.length - 1].content.text, /Auto-ban configurado para: \*3\*/i);
  assert.match(messages[messages.length - 1].content.text, /Limite atingido/i);
});

test('warnlimit permite ajustar limite por grupo e resetar para padrão', async () => {
  const { sock, messages, participantUpdates } = createSockStub();
  dbHarness.setGroupParticipants(GROUP_JID, [{ id: OWNER_JID, admin: 'admin' }]);

  await runAdminCommand({
    command: 'warnlimit',
    args: ['2'],
    sock,
  });
  assert.equal(dbHarness.getGroupConfig(GROUP_JID).warnAutoBanThreshold, 2);

  await runAdminCommand({
    command: 'warn',
    args: [TARGET_JID, 'motivo-1'],
    sock,
  });
  await runAdminCommand({
    command: 'warn',
    args: [TARGET_JID, 'motivo-2'],
    sock,
  });

  assert.equal(participantUpdates.length, 1);
  assert.deepEqual(participantUpdates[0], {
    groupId: GROUP_JID,
    participants: [TARGET_JID],
    action: 'remove',
  });

  await runAdminCommand({
    command: 'warnlimit',
    args: ['status'],
    sock,
  });
  assert.match(messages[messages.length - 1].content.text, /Limite atual de auto-ban/i);
  assert.match(messages[messages.length - 1].content.text, /\*2\*/);

  await runAdminCommand({
    command: 'warnlimit',
    args: ['reset'],
    sock,
  });
  assert.equal(dbHarness.getGroupConfig(GROUP_JID).warnAutoBanThreshold, null);
  assert.match(messages[messages.length - 1].content.text, /padrão: \*3\*/i);
});

test('clearwarn remove parcialmente e depois remove todas as advertências', async () => {
  const { sock, messages } = createSockStub();
  dbHarness.setGroupParticipants(GROUP_JID, [{ id: OWNER_JID, admin: 'admin' }]);

  await runAdminCommand({
    command: 'warn',
    args: [TARGET_JID, 'motivo-1'],
    sock,
  });
  await runAdminCommand({
    command: 'warn',
    args: [TARGET_JID, 'motivo-2'],
    sock,
  });
  await runAdminCommand({
    command: 'warn',
    args: [TARGET_JID, 'motivo-3'],
    sock,
  });

  await runAdminCommand({
    command: 'clearwarn',
    args: [TARGET_JID, '2'],
    sock,
  });
  assert.match(messages[messages.length - 1].content.text, /removi \*2 advertência\(s\)\*/i);
  assert.match(messages[messages.length - 1].content.text, /Advertências restantes neste grupo: \*1\*/i);

  await runAdminCommand({
    command: 'clearwarn',
    args: [TARGET_JID, 'all'],
    sock,
  });
  assert.match(messages[messages.length - 1].content.text, /todas as advertências \(1\)/i);
  assert.match(messages[messages.length - 1].content.text, /Advertências restantes neste grupo: \*0\*/i);

  await runAdminCommand({
    command: 'warnings',
    args: [TARGET_JID],
    sock,
  });
  assert.match(messages[messages.length - 1].content.text, /não possui advertências/i);
});

test('clearwarn retorna uso ao receber quantidade inválida', async () => {
  const { sock, messages } = createSockStub();
  dbHarness.setGroupParticipants(GROUP_JID, [{ id: OWNER_JID, admin: 'admin' }]);

  await runAdminCommand({
    command: 'clearwarn',
    args: [TARGET_JID, 'zero'],
    sock,
  });

  assert.equal(messages.length, 1);
  assert.match(messages[0].content.text, /Formato de uso/i);
  assert.match(messages[0].content.text, /clearwarn/i);
});

test('premium exige admin principal e lista usuários quando autorizado', async () => {
  const texts = getAdminTextConfig();
  const denied = createSockStub();

  await runAdminCommand({
    command: 'premium',
    args: ['list'],
    sock: denied.sock,
    senderJid: NON_ADMIN_JID,
    messageInfo: buildMessageInfo(NON_ADMIN_JID),
    isGroupMessage: false,
    remoteJid: NON_ADMIN_JID,
  });

  assert.equal(denied.messages.length, 1);
  assert.equal(denied.messages[0].content.text, texts.owner_only_command_message);

  dbHarness.setPremiumUsers([TARGET_JID]);
  const allowed = createSockStub();

  await runAdminCommand({
    command: 'premium',
    args: ['list'],
    sock: allowed.sock,
    senderJid: OWNER_JID,
    messageInfo: buildMessageInfo(OWNER_JID),
    isGroupMessage: false,
    remoteJid: OWNER_JID,
  });

  assert.equal(allowed.messages.length, 1);
  assert.match(allowed.messages[0].content.text, /Lista de usuários premium/i);
  assert.match(allowed.messages[0].content.text, new RegExp(TARGET_JID.replace('.', '\\.')));
});

test('prefix atualiza, consulta status e reseta para padrão', async () => {
  const { sock, messages } = createSockStub();
  dbHarness.setGroupParticipants(GROUP_JID, [{ id: OWNER_JID, admin: 'admin' }]);

  await runAdminCommand({
    command: 'prefix',
    args: ['!'],
    sock,
  });
  assert.equal(dbHarness.getGroupConfig(GROUP_JID).commandPrefix, '!');

  await runAdminCommand({
    command: 'prefix',
    args: ['status'],
    sock,
  });
  assert.match(messages[messages.length - 1].content.text, /Prefixo ativo neste grupo: \*!/i);

  await runAdminCommand({
    command: 'prefix',
    args: ['reset'],
    sock,
  });
  assert.equal(dbHarness.getGroupConfig(GROUP_JID).commandPrefix, null);
});

test('stickerallowance atualiza e consulta limite por janela', async () => {
  const { sock, messages } = createSockStub();
  dbHarness.setGroupParticipants(GROUP_JID, [{ id: OWNER_JID, admin: 'admin' }]);

  await runAdminCommand({
    command: 'stickerallowance',
    args: ['4'],
    sock,
  });

  const updatedConfig = dbHarness.getGroupConfig(GROUP_JID);
  assert.equal(updatedConfig.stickerFocusMessageAllowance, 4);
  assert.equal(updatedConfig.stickerFocusMessageAllowanceCount, 4);

  await runAdminCommand({
    command: 'stickerallowance',
    args: ['status'],
    sock,
  });

  assert.match(messages[messages.length - 1].content.text, /Limite atual de mensagens por usuário/i);
  assert.match(messages[messages.length - 1].content.text, /\*4\*/);
});

test('noticiasfiltro aplica source/tag e trending no config do grupo', async () => {
  const { sock } = createSockStub();
  dbHarness.setGroupParticipants(GROUP_JID, [{ id: OWNER_JID, admin: 'admin' }]);

  await runAdminCommand({
    command: 'noticiasfiltro',
    args: ['source', 'add', 'ann,mal'],
    sock,
  });

  await runAdminCommand({
    command: 'noticiasfiltro',
    args: ['tag', 'add', 'shounen'],
    sock,
  });

  await runAdminCommand({
    command: 'noticiasfiltro',
    args: ['trending', 'on'],
    sock,
  });

  const updatedConfig = dbHarness.getGroupConfig(GROUP_JID);
  assert.deepEqual(updatedConfig.newsSourceIds, ['ann', 'mal']);
  assert.deepEqual(updatedConfig.newsEntitySlugs, ['shounen']);
  assert.equal(updatedConfig.newsOnlyTrending, true);
  assert.equal(updatedConfig.newsFilters.onlyTrending, true);
});

test('grupoaudit retorna resumo consolidado do grupo', async () => {
  const { sock, messages } = createSockStub();
  dbHarness.setGroupParticipants(GROUP_JID, [{ id: OWNER_JID, admin: 'admin' }]);
  dbHarness.setGroupConfig(GROUP_JID, {
    commandPrefix: '!',
    nsfwEnabled: true,
    autoStickerEnabled: false,
    stickerFocusEnabled: true,
    stickerFocusMessageCooldownMinutes: 30,
    stickerFocusMessageAllowance: 3,
    captchaEnabled: true,
    autoApproveRequestsEnabled: false,
    antilinkEnabled: true,
    antilinkAllowedNetworks: ['youtube'],
    antilinkAllowedDomains: ['example.com'],
    newsEnabled: true,
    newsSentIds: ['n1', 'n2'],
    newsLastSentAt: '2026-03-18T00:00:00.000Z',
    welcomeMessageEnabled: true,
    farewellMessageEnabled: false,
  });

  await runAdminCommand({
    command: 'grupoaudit',
    args: [],
    sock,
  });

  assert.equal(messages.length, 1);
  assert.match(messages[0].content.text, /Auditoria do Grupo/i);
  assert.match(messages[0].content.text, /Notícias enviadas: \*2\*/i);
  assert.match(messages[0].content.text, /Antilink: \*ativado\*/i);
});
