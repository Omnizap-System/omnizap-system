import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTimeFormats,
  elapsedMs,
  formatDateTimeExtenso,
  formatTimeAmPm,
  formatTimeExtenso,
  now,
  nowIso,
  toUnixMs,
  toUnixSeconds,
} from './timeModule.js';

const FIXED_ISO = '2026-03-16T15:45:30.000Z';

test('now e nowIso retornam valores válidos de data/hora', () => {
  const nowValue = now();
  const nowIsoValue = nowIso();

  assert.ok(nowValue instanceof Date);
  assert.ok(Number.isFinite(nowValue.getTime()));
  assert.ok(Number.isFinite(Date.parse(nowIsoValue)));
});

test('conversão unix e elapsedMs funcionam conforme esperado', () => {
  assert.equal(toUnixMs(FIXED_ISO), 1773675930000);
  assert.equal(toUnixSeconds(FIXED_ISO), 1773675930);
  assert.equal(elapsedMs('2026-03-16T15:45:00.000Z', FIXED_ISO), 30000);
});

test('formatTimeAmPm gera horário em AM/PM', () => {
  const result = formatTimeAmPm(FIXED_ISO, {
    locale: 'en-US',
    timeZone: 'UTC',
  });

  assert.equal(result, '03:45 PM');
});

test('formatDateTimeExtenso gera data/hora por extenso em pt-BR', () => {
  const result = formatDateTimeExtenso(FIXED_ISO, {
    locale: 'pt-BR',
    timeZone: 'America/Sao_Paulo',
  });

  assert.match(result, /16 de março de 2026/i);
  assert.match(result, /12:45/);
});

test('formatTimeExtenso gera hora por extenso em pt-BR', () => {
  const result = formatTimeExtenso(FIXED_ISO, {
    locale: 'pt-BR',
    timeZone: 'America/Sao_Paulo',
  });

  assert.equal(result, '12 horas e 45 minutos');
});

test('buildTimeFormats retorna pacote completo de formatos', () => {
  const result = buildTimeFormats(FIXED_ISO, {
    locale: 'pt-BR',
    timeZone: 'America/Sao_Paulo',
  });

  assert.deepEqual(result, {
    iso: '2026-03-16T15:45:30.000Z',
    unixMs: 1773675930000,
    unixSeconds: 1773675930,
    amPm: '12:45 PM',
    extenso: 'segunda-feira, 16 de março de 2026 às 12:45',
    horaExtenso: '12 horas e 45 minutos',
  });
});
