import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiTextService } from './geminiService.js';

test('createGeminiTextService retorna null no modo api_key quando GEMINI_API_KEY nao existe', () => {
  const service = createGeminiTextService({ authMode: 'api_key', apiKey: '' });
  assert.equal(service, null);
});

test('createGeminiTextService envia prompt e extrai texto da resposta', async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [{ text: 'Primeira linha' }, { text: 'Segunda linha' }],
            },
          },
        ],
      }),
    };
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const service = createGeminiTextService({
    apiKey: 'gemini-test-key',
    apiBaseUrl: 'https://example-gemini.test/v1beta',
    defaultModel: 'models/gemini-2.0-flash',
    timeoutMs: 4_000,
  });

  const response = await service.generateText({
    instructions: 'Responda em PT-BR.',
    userPrompt: 'Como usar o comando?',
    model: 'models/gemini-2.0-flash',
  });

  assert.equal(response.text, 'Primeira linha\nSegunda linha');
  assert.equal(response.model, 'gemini-2.0-flash');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example-gemini.test/v1beta/models/gemini-2.0-flash:generateContent?key=gemini-test-key');

  const sentPayload = JSON.parse(calls[0].options.body);
  assert.equal(sentPayload.contents[0].parts[0].text, 'Como usar o comando?');
  assert.equal(sentPayload.systemInstruction.parts[0].text, 'Responda em PT-BR.');
});

test('createGeminiTextService propaga erro detalhado da API', async (t) => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    json: async () => ({
      error: {
        message: 'Modelo invalido',
      },
    }),
  });

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const service = createGeminiTextService({
    apiKey: 'gemini-test-key',
  });

  await assert.rejects(
    () =>
      service.generateText({
        userPrompt: 'teste',
        model: 'modelo-ruim',
      }),
    /Modelo invalido/,
  );
});

test('createGeminiTextService usa Gemini CLI quando authMode=cli', async () => {
  const calls = [];
  const service = createGeminiTextService({
    authMode: 'cli',
    cliCommand: 'gemini',
    defaultModel: 'gemini-2.5-flash',
    isCliAvailableImpl: () => true,
    execFileAsyncImpl: async (file, args, options) => {
      calls.push({ file, args, options });
      return {
        stdout: 'OK_GEMINI_CLI\n',
        stderr: 'Loaded cached credentials.',
      };
    },
  });

  assert.ok(service);
  assert.equal(service.transport, 'cli');

  const response = await service.generateText({
    instructions: 'Responda curto.',
    userPrompt: 'Diga OK.',
    model: 'gemini-2.5-flash',
  });

  assert.equal(response.model, 'gemini-2.5-flash');
  assert.equal(response.text, 'OK_GEMINI_CLI');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'gemini');
  assert.ok(calls[0].args.includes('-m'));
  assert.ok(calls[0].args.includes('gemini-2.5-flash'));
  assert.ok(calls[0].args.includes('-p'));
  assert.ok(calls[0].args.includes('--output-format'));
});

test('createGeminiTextService propaga erro do Gemini CLI', async () => {
  const service = createGeminiTextService({
    authMode: 'cli',
    cliCommand: 'gemini',
    defaultModel: 'gemini-2.5-flash',
    isCliAvailableImpl: () => true,
    execFileAsyncImpl: async () => {
      const error = new Error('Command failed');
      error.stderr = 'ModelNotFoundError: Requested entity was not found.';
      throw error;
    },
  });

  await assert.rejects(
    () =>
      service.generateText({
        userPrompt: 'teste',
      }),
    /ModelNotFoundError/,
  );
});
