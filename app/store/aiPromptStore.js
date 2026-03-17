import { TABLES, executeQuery, findById, remove, upsert } from '../../database/index.js';
import { normalizeJid } from '../config/index.js';

const AI_PROMPTS_TABLE = TABLES.SYSTEM_AI_PROMPTS;
const SELECT_AI_PROMPTS_SQL = `SELECT id, prompt FROM \`${AI_PROMPTS_TABLE}\` ORDER BY id ASC`;

const normalizePromptJid = (jid) => {
  const raw = String(jid || '').trim();
  if (!raw) return '';
  return normalizeJid(raw) || raw;
};

const normalizePromptValue = (prompt) => {
  if (typeof prompt === 'string') return prompt;
  if (prompt === null || prompt === undefined) return '';
  return String(prompt);
};

const aiPromptStore = {
  getAllPrompts: async function () {
    const rows = await executeQuery(SELECT_AI_PROMPTS_SQL);
    const prompts = {};
    for (const row of rows) {
      const promptJid = normalizePromptJid(row?.id);
      if (!promptJid) continue;
      prompts[promptJid] = normalizePromptValue(row?.prompt);
    }
    return prompts;
  },

  getPrompt: async function (jid) {
    const normalizedJid = normalizePromptJid(jid);
    if (!normalizedJid) return null;
    const row = await findById(AI_PROMPTS_TABLE, normalizedJid);
    if (!row) return null;
    return normalizePromptValue(row.prompt);
  },

  setPrompt: async function (jid, prompt) {
    const normalizedJid = normalizePromptJid(jid);
    if (!normalizedJid) return null;
    const normalizedPrompt = normalizePromptValue(prompt);
    await upsert(AI_PROMPTS_TABLE, { id: normalizedJid, prompt: normalizedPrompt });
    return normalizedPrompt;
  },

  clearPrompt: async function (jid) {
    const normalizedJid = normalizePromptJid(jid);
    if (!normalizedJid) return null;
    await remove(AI_PROMPTS_TABLE, normalizedJid);
    return true;
  },
};

export default aiPromptStore;
