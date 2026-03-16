import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { __playYtDlpClientTestUtils } from './playCommandYtDlpClient.js';

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

test('resolve candidates deduplica URLs e ignora inválidas', () => {
  const urls = __playYtDlpClientTestUtils.extractCandidateUrlsFromSearchResult({
    resultado: { url: 'https://www.youtube.com/watch?v=abc123' },
    resultados: [{ url: 'https://www.youtube.com/watch?v=abc123' }, { url: 'https://youtu.be/xyz987' }, { url: 'not-an-url' }, { url: 'https://www.youtube.com/watch?v=zzz000' }],
  });

  assert.deepEqual(urls, ['https://www.youtube.com/watch?v=abc123', 'https://youtu.be/xyz987', 'https://www.youtube.com/watch?v=zzz000']);
});

test('estratégia de formato gera tentativas de fallback para áudio e vídeo', () => {
  const link = 'https://www.youtube.com/watch?v=test123';
  const outputTemplate = '/tmp/play-test.%(ext)s';

  const audioAttempts = __playYtDlpClientTestUtils.buildDownloadAttemptArgsList({
    type: 'audio',
    outputTemplate,
    link,
  });
  assert.ok(audioAttempts.length >= 2);
  assert.ok(audioAttempts[0].includes('-x'));
  assert.ok(audioAttempts[0].includes('--audio-format'));
  assert.equal(audioAttempts[0][audioAttempts[0].length - 1], link);

  const videoAttempts = __playYtDlpClientTestUtils.buildDownloadAttemptArgsList({
    type: 'video',
    outputTemplate,
    link,
  });
  assert.ok(videoAttempts.length >= 2);
  assert.ok(videoAttempts[0].includes('--merge-output-format'));
  assert.equal(videoAttempts[0][videoAttempts[0].length - 1], link);
});

test('anti-bot: detecta causa e retorna mensagem apropriada conforme cookies', { concurrency: false }, async () => {
  assert.equal(
    __playYtDlpClientTestUtils.isYouTubeBotCheckCause({
      meta: { cause: 'ERROR: [youtube] Sign in to confirm you’re not a bot.' },
    }),
    true,
  );

  await withEnv(
    {
      PLAY_YTDLP_COOKIES_PATH: '/tmp/cookies-inexistente.txt',
      PLAY_YTDLP_COOKIES_FROM_BROWSER: '',
    },
    async () => {
      const message = __playYtDlpClientTestUtils.buildYouTubeBotCheckUserMessage();
      assert.match(message, /PLAY_YTDLP_COOKIES_PATH/);
    },
  );

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'play-cookies-'));
  const cookiesPath = path.join(tempDir, 'cookies.txt');
  fs.writeFileSync(cookiesPath, '.youtube.com\tTRUE\t/\tFALSE\t2147483647\tSID\ttest-cookie\n', 'utf8');

  try {
    await withEnv(
      {
        PLAY_YTDLP_COOKIES_PATH: cookiesPath,
        PLAY_YTDLP_COOKIES_FROM_BROWSER: '',
      },
      async () => {
        const message = __playYtDlpClientTestUtils.buildYouTubeBotCheckUserMessage();
        assert.match(message, /cookies\.txt/i);
        assert.ok(!message.includes('PLAY_YTDLP_COOKIES_PATH'));
      },
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('notifyFailure: envia admin só para erro técnico e deduplica alertas', { concurrency: false }, async () => {
  await withEnv(
    {
      USER_ADMIN: '5511999999999',
    },
    async () => {
      const mod = await import(`./playCommandCore.js?test=${__timeNowMs()}-${Math.random().toString(16).slice(2)}`);
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
