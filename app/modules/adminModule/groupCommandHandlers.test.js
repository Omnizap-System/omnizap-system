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

  const execute = async (sql, params = []) => {
    const normalized = normalizeSql(sql);

    if (normalized.startsWith('select * from `groups_metadata` where id = ?')) {
      const row = groupMetadataRows.get(params[0]);
      return [[row].filter(Boolean), []];
    }

    if (normalized.startsWith('select * from `group_configs` where id = ?')) {
      const row = groupConfigRows.get(params[0]);
      return [[row].filter(Boolean), []];
    }

    if (normalized.startsWith('insert into `group_configs`')) {
      const [id, config] = params;
      groupConfigRows.set(id, { id, config: String(config) });
      return [{ affectedRows: 1 }, []];
    }

    if (normalized.startsWith('select id from `system_premium_users`')) {
      const rows = Array.from(premiumUserRows.values())
        .sort((left, right) => String(left).localeCompare(String(right)))
        .map((id) => ({ id }));
      return [rows, []];
    }

    if (normalized.startsWith('delete from `system_premium_users`')) {
      premiumUserRows.clear();
      return [{ affectedRows: 1 }, []];
    }

    if (normalized.startsWith('insert into `system_premium_users`')) {
      const [id] = params;
      premiumUserRows.add(String(id || ''));
      return [{ affectedRows: 1 }, []];
    }

    if (normalized.includes('from lid_map') || normalized.includes('from `lid_map`') || normalized.includes('into `lid_map`') || normalized.startsWith('update `messages`')) {
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

const buildMessageInfo = (participant = OWNER_JID) => ({
  key: { participant },
  message: {},
});

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
