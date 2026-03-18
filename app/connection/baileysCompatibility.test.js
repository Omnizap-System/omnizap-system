import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

import { initAuthCreds, proto } from '@whiskeysockets/baileys';

const PINNED_BAILEYS_REF = 'github:jlucaso1/Baileys#feat-add-stickerpack-support';

const require = createRequire(import.meta.url);
const baileysPackageJsonPath = require.resolve('@whiskeysockets/baileys/package.json');
const baileysPackageDir = path.dirname(baileysPackageJsonPath);

const readBaileysTypeFile = async (relativePath) => readFile(path.join(baileysPackageDir, relativePath), 'utf8');

test('Auth.d.ts expõe AuthenticationState compatível com SocketConfig.auth', async () => {
  const [authTypes, socketTypes] = await Promise.all([readBaileysTypeFile('lib/Types/Auth.d.ts'), readBaileysTypeFile('lib/Types/Socket.d.ts')]);

  assert.match(authTypes, /export type AuthenticationState = \{/);
  assert.match(authTypes, /creds:\s*AuthenticationCreds;/);
  assert.match(authTypes, /keys:\s*SignalKeyStore;/);
  assert.match(authTypes, /'app-state-sync-key':\s*proto\.Message\.IAppStateSyncKeyData;/);
  assert.match(socketTypes, /auth:\s*AuthenticationState;/);
});

test('Baileys runtime smoke: initAuthCreds e AppStateSyncKeyData continuam válidos', () => {
  const creds = initAuthCreds();
  assert.equal(typeof creds?.registrationId, 'number');
  assert.ok(creds?.noiseKey?.private instanceof Uint8Array);

  const appStateKey = proto.Message.AppStateSyncKeyData.fromObject({});
  assert.ok(appStateKey && typeof appStateKey === 'object');
});

test('Dependência do Baileys permanece pinada para revisão conhecida', async () => {
  const packageJsonPath = path.resolve(process.cwd(), 'package.json');
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  assert.equal(packageJson?.dependencies?.['@whiskeysockets/baileys'], PINNED_BAILEYS_REF);
});
