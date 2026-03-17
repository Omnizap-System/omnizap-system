import logger from '#logger';
import { isGroupJid, normalizeJid } from '../config/index.js';
import { findById, upsert } from '../../database/index.js';

const SYSTEM_CONFIG_PREFIX = 'system:';

const normalizeGroupConfigId = (groupId) => {
  const raw = String(groupId || '').trim();
  if (!raw) return '';
  return normalizeJid(raw) || raw;
};

const isReservedSystemConfigId = (groupId) => groupId.startsWith(SYSTEM_CONFIG_PREFIX);

const assertWritableGroupConfigId = (groupId) => {
  if (!groupId) {
    throw new Error('O identificador do grupo é obrigatório para persistir configurações.');
  }

  if (isReservedSystemConfigId(groupId)) {
    throw new Error(`O id ${groupId} é reservado para configurações de sistema e não pode ser salvo em group_configs.`);
  }

  if (!isGroupJid(groupId)) {
    throw new Error(`O id ${groupId} não representa um grupo válido para group_configs.`);
  }
};

const groupConfigStore = {
  /**
   * Recupera a configuracao de um grupo especifico.
   * @param {string} groupId - O JID do grupo.
   * @returns {object} A configuracao do grupo, ou um objeto vazio se nao encontrado.
   */
  getGroupConfig: async function (groupId) {
    const normalizedGroupId = normalizeGroupConfigId(groupId);
    if (!normalizedGroupId || !isGroupJid(normalizedGroupId)) {
      return {};
    }
    if (isReservedSystemConfigId(normalizedGroupId)) {
      logger.warn('Tentativa bloqueada de leitura de configuração reservada em group_configs.', { groupId: normalizedGroupId });
      return {};
    }

    try {
      const record = await findById('group_configs', normalizedGroupId);
      if (!record || record.config === null || record.config === undefined) {
        return {};
      }
      if (Buffer.isBuffer(record.config)) {
        return JSON.parse(record.config.toString('utf8'));
      }
      if (typeof record.config === 'string') {
        return JSON.parse(record.config);
      }
      return record.config || {};
    } catch (error) {
      logger.error('Error loading group configuration from DB:', {
        error: error.message,
        groupId: normalizedGroupId,
      });
      return {};
    }
  },

  /**
   * Atualiza a configuracao de um grupo especifico.
   * @param {string} groupId - O JID do grupo.
   * @param {object} newConfig - O novo objeto de configuracao para mesclar.
   * @param {string} [newConfig.welcomeMedia] - Caminho opcional para midia de boas-vindas.
   * @param {string} [newConfig.farewellMedia] - Caminho opcional para midia de despedida.
   */
  updateGroupConfig: async function (groupId, newConfig) {
    const normalizedGroupId = normalizeGroupConfigId(groupId);
    assertWritableGroupConfigId(normalizedGroupId);
    const currentConfig = await this.getGroupConfig(normalizedGroupId);
    const updatedConfig = { ...currentConfig, ...newConfig };
    try {
      await upsert('group_configs', {
        id: normalizedGroupId,
        config: JSON.stringify(updatedConfig),
      });
      return updatedConfig;
    } catch (error) {
      logger.error('Error updating group configuration in DB:', {
        error: error.message,
        groupId: normalizedGroupId,
      });
      throw error;
    }
  },
};

export default groupConfigStore;
