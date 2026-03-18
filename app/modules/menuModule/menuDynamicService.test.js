import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDynamicMenuText } from './menuDynamicService.js';

const buildCatalogFixture = () => {
  const adminCommands = Array.from({ length: 12 }, (_, index) => ({
    name: `admincmd${index + 1}`,
    descricao: `Comando administrativo ${index + 1}`,
  }));

  const mediaCommands = Array.from({ length: 10 }, (_, index) => ({
    name: `mediacmd${index + 1}`,
    descricao: `Comando de mídia ${index + 1}`,
  }));

  const statsCommands = [
    { name: 'ranking', descricao: 'Mostra ranking do grupo' },
    { name: 'ping', descricao: 'Mostra latência do bot' },
  ];

  return {
    catalog: {
      generated_at: '2026-03-18T03:17:03.020Z',
      categories: [
        {
          key: 'admin',
          label: 'Moderação e Admin',
          commands: adminCommands,
        },
        {
          key: 'midia',
          label: 'Mídia',
          commands: mediaCommands,
        },
        {
          key: 'stats',
          label: 'Estatísticas',
          commands: statsCommands,
        },
      ],
    },
  };
};

test('menu dinâmico principal destaca comandos mais usados quando há muitos comandos', () => {
  const text = buildDynamicMenuText({
    catalogSnapshot: buildCatalogFixture(),
    usageRows: [
      { commandName: 'admincmd7', usageCount: 321 },
      { commandName: 'mediacmd3', usageCount: 230 },
      { commandName: 'ranking', usageCount: 120 },
    ],
    args: [],
    senderName: 'Equipe QA',
    commandPrefix: '/',
  });

  assert.match(text, /\*Menu dinâmico do OmniZap\*/);
  assert.match(text, /Destaques por uso/);
  assert.match(text, /\/admincmd7/);
  assert.match(text, /\/menu top/);
  assert.match(text, /https:\/\/omnizap\.shop\/comandos\//);
});

test('menu dinâmico resolve categoria por alias e filtra comandos da categoria', () => {
  const text = buildDynamicMenuText({
    catalogSnapshot: buildCatalogFixture(),
    usageRows: [{ commandName: 'admincmd2', usageCount: 88 }],
    args: ['categoria', 'adm'],
    senderName: 'Teste',
    commandPrefix: '/',
  });

  assert.match(text, /Categoria: Moderação e Admin/);
  assert.match(text, /\/admincmd2/);
  assert.doesNotMatch(text, /\/mediacmd1/);
});

test('menu dinâmico informa quando categoria não existe', () => {
  const text = buildDynamicMenuText({
    catalogSnapshot: buildCatalogFixture(),
    usageRows: [],
    args: ['categoria', 'naoexiste'],
    senderName: 'Teste',
    commandPrefix: '/',
  });

  assert.match(text, /Não encontrei a categoria/);
  assert.match(text, /\/menu admin/);
});

test('menu dinâmico todos lista categorias e comandos', () => {
  const text = buildDynamicMenuText({
    catalogSnapshot: buildCatalogFixture(),
    usageRows: [],
    args: ['todos'],
    senderName: 'Teste',
    commandPrefix: '/',
  });

  assert.match(text, /Catálogo completo de comandos/);
  assert.match(text, /Moderação e Admin/);
  assert.match(text, /\/admincmd1/);
  assert.match(text, /\/mediacmd1/);
});
