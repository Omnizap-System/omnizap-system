import { TABLES, executeQuery, withTransaction } from '../../database/index.js';
import { isSameJidUser, normalizeJid } from '../config/index.js';

const PREMIUM_USERS_TABLE = TABLES.SYSTEM_PREMIUM_USERS;
const SELECT_PREMIUM_USERS_SQL = `SELECT id FROM \`${PREMIUM_USERS_TABLE}\` ORDER BY id ASC`;
const DELETE_ALL_PREMIUM_USERS_SQL = `DELETE FROM \`${PREMIUM_USERS_TABLE}\``;
const INSERT_PREMIUM_USER_SQL = `INSERT INTO \`${PREMIUM_USERS_TABLE}\` (id) VALUES (?)`;

const normalizePremiumEntry = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return normalizeJid(raw) || raw;
};

const normalizeList = (list) => {
  const normalizedList = [];
  const values = Array.isArray(list) ? list : [];

  for (const value of values) {
    const normalized = normalizePremiumEntry(value);
    if (!normalized) continue;
    if (normalizedList.some((entry) => entry === normalized || isSameJidUser(entry, normalized))) continue;
    normalizedList.push(normalized);
  }

  return normalizedList;
};

const loadPremiumUsersFromDb = async () => {
  const rows = await executeQuery(SELECT_PREMIUM_USERS_SQL);
  return normalizeList(rows.map((row) => row.id));
};

const premiumUserStore = {
  getPremiumUsers: async function () {
    return loadPremiumUsersFromDb();
  },

  setPremiumUsers: async function (premiumUsers) {
    const normalized = normalizeList(premiumUsers);

    await withTransaction(async (connection) => {
      await executeQuery(DELETE_ALL_PREMIUM_USERS_SQL, [], connection);
      for (const premiumJid of normalized) {
        await executeQuery(INSERT_PREMIUM_USER_SQL, [premiumJid], connection);
      }
    });

    return normalized;
  },

  addPremiumUsers: async function (usersToAdd) {
    const current = await this.getPremiumUsers();
    const updated = normalizeList([...current, ...usersToAdd]);
    await this.setPremiumUsers(updated);
    return updated;
  },

  removePremiumUsers: async function (usersToRemove) {
    const current = await this.getPremiumUsers();
    const normalizedTargets = normalizeList(usersToRemove);
    const updated = current.filter((jid) => !normalizedTargets.some((target) => target === jid || isSameJidUser(target, jid)));
    await this.setPremiumUsers(updated);
    return updated;
  },
};

export default premiumUserStore;
