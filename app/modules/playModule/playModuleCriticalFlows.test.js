import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { __playMediaClientTestUtils } from './playCommandMediaClient.js';

const withEnv = async (overrides, fn) => {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides || {})) {
    previous.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : null);
    if (value === null || value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = String(value);
    }
  }

  try {
    return await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

let closeDatabasePoolForTests = null;

after(async () => {
  if (typeof closeDatabasePoolForTests !== 'function') {
    return;
  }
  await closeDatabasePoolForTests();
  closeDatabasePoolForTests = null;
});

test('resolve candidates deduplica URLs e ignora inválidas', () => {
  const urls = __playMediaClientTestUtils.extractCandidateUrlsFromSearchResult({
    resultado: { url: 'https://www.youtube.com/watch?v=abc123' },
    resultados: [{ url: 'https://www.youtube.com/watch?v=abc123' }, { url: 'https://youtu.be/xyz987' }, { url: 'not-an-url' }, { url: 'https://www.youtube.com/watch?v=zzz000' }],
  });

  assert.deepEqual(urls, ['https://www.youtube.com/watch?v=abc123', 'https://youtu.be/xyz987', 'https://www.youtube.com/watch?v=zzz000']);
});

test('ytmp3 principal é elegível para áudio e vídeo com URL do YouTube', () => {
  assert.equal(
    __playMediaClientTestUtils.isYtmp3PrimaryEligible({
      type: 'audio',
      link: 'https://www.youtube.com/watch?v=test1234567A',
    }),
    true,
  );

  assert.equal(
    __playMediaClientTestUtils.isYtmp3PrimaryEligible({
      type: 'video',
      link: 'https://www.youtube.com/watch?v=test1234567A',
    }),
    true,
  );

  assert.equal(
    __playMediaClientTestUtils.isYtmp3PrimaryEligible({
      type: 'audio',
      link: 'https://vimeo.com/1234',
    }),
    false,
  );
});

test('anti-bot: detecta causa e retorna mensagem genérica do provedor', { concurrency: false }, async () => {
  assert.equal(
    __playMediaClientTestUtils.isYouTubeBotCheckCause({
      meta: { cause: 'ERROR: [youtube] Sign in to confirm you’re not a bot.' },
    }),
    true,
  );

  const message = __playMediaClientTestUtils.buildYouTubeBotCheckUserMessage();
  assert.match(message, /anti-bot/i);
  assert.ok(!message.includes('PLAY_'));
  assert.ok(!message.toLowerCase().includes('cookies_path'));
});

test('notifyFailure: envia admin só para erro técnico e deduplica alertas', { concurrency: false }, async () => {
  await withEnv(
    {
      USER_ADMIN: '5511999999999',
    },
    async () => {
      const mod = await import(`./playCommandCore.js?test=${__timeNowMs()}-${Math.random().toString(16).slice(2)}`);
      const { closePool } = await import('../../../database/index.js');
      closeDatabasePoolForTests = closePool;
      const utils = mod.__playCommandCoreTestUtils;
      utils.resetAdminAlertDedupCacheForTests();

      const sent = [];
      const sock = {
        sendMessage: async (jid, content, options) => {
          sent.push({ jid, content, options });
          return {
            key: { remoteJid: jid },
            message: content,
            messageTimestamp: Math.floor(__timeNowMs() / 1000),
          };
        },
      };

      const technicalError = Object.assign(new Error('spawn failed'), {
        code: 'EAPI',
        meta: {
          technical: true,
          endpoint: 'local:download',
          cause: 'spawn failed',
          rawCode: 'EPROCESS',
        },
      });

      await utils.notifyFailure(sock, '120363111111111111@g.us', { key: {}, message: {} }, 0, technicalError, {
        type: 'audio',
        requestId: 'req-1',
      });
      assert.equal(sent.length, 2);
      assert.match(sent[1].content.text, /diagnóstico/i);

      await utils.notifyFailure(sock, '120363111111111111@g.us', { key: {}, message: {} }, 0, technicalError, {
        type: 'audio',
        requestId: 'req-1',
      });
      assert.equal(sent.length, 3);

      const businessError = Object.assign(new Error('not found'), {
        code: 'ENOTFOUND',
        meta: {
          technical: false,
          endpoint: 'local:search',
        },
      });

      await utils.notifyFailure(sock, '120363111111111111@g.us', { key: {}, message: {} }, 0, businessError, {
        type: 'audio',
        requestId: 'req-2',
      });
      assert.equal(sent.length, 4);
    },
  );
});
