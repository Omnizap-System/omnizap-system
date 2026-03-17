import logger from '#logger';
import { findById, upsert } from '../../../database/index.js';
import { extractUserIdInfo, resolveUserIdCached, isLidUserId, isWhatsAppUserId } from '../../config/index.js';

const GROUP_METADATA_FIELDS = [
  'id',
  'subject',
  'description',
  'owner_jid',
  'creation',
  'participants',
  'linked_parent_jid',
  'is_community',
  'is_community_announce',
  'member_add_mode',
  'join_approval_mode',
  'addressing_mode',
];

const PARTICIPANT_ACTIONS = new Set(['add', 'remove', 'promote', 'demote', 'modify']);

const PARTICIPANT_ADMIN_FIELDS = ['admin', 'isAdmin', 'isSuperAdmin'];

const hasParticipantAdminPayload = (participant) => {
  if (!participant || typeof participant !== 'object') return false;
  return PARTICIPANT_ADMIN_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(participant, field));
};

const normalizeParticipantAdmin = (participant) => {
  if (!hasParticipantAdminPayload(participant)) return undefined;

  const admin = typeof participant?.admin === 'string' ? participant.admin.toLowerCase() : participant?.admin;
  if (admin === 'superadmin' || participant?.isSuperAdmin === true) return 'superadmin';
  if (admin === 'admin' || participant?.isAdmin === true) return 'admin';
  return null;
};

/**
 * Normaliza o campo `participants` para o formato persistido no banco.
 * @param {unknown} value - Valor bruto de participantes.
 * @returns {string | null | undefined} JSON string, null ou undefined.
 */
const normalizeParticipantsValue = (value) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch (error) {
    logger.warn('Erro ao serializar participantes para persistência.', { error: error.message });
    return null;
  }
};

/**
 * Faz parse do campo `participants` armazenado no banco.
 * @param {string | Array<Object> | null | undefined} participants - Valor armazenado.
 * @returns {Array<Object>} Lista de participantes normalizada.
 */
export const parseParticipantsFromDb = (participants) => {
  if (!participants) return [];
  try {
    if (typeof participants === 'string') return JSON.parse(participants);
    if (Array.isArray(participants)) return participants;
  } catch (error) {
    const preview = typeof participants === 'string' ? participants.slice(0, 200) : null;
    logger.warn('Erro ao fazer parse dos participantes salvos no banco.', {
      error: error.message,
      preview,
    });
  }
  return [];
};

/**
 * Normaliza um participante para o formato padrão (id/jid/lid/admin).
 * @param {string | Object | null | undefined} participant - Participante bruto.
 * @returns {Object | null} Participante normalizado ou null.
 */
export const normalizeParticipant = (participant) => {
  if (!participant) return null;
  const raw = typeof participant === 'string' ? { id: participant } : participant;
  const rawId = raw.id || raw.jid || raw.participant || raw.participantAlt || null;
  const info = extractUserIdInfo({
    jid: raw.jid || raw.id || null,
    lid: raw.lid || null,
    participantAlt: raw.participantAlt || raw.participant || null,
  });

  const canonical = resolveUserIdCached(info) || info.jid || info.lid || rawId || null;
  const canonicalIsJid = canonical && isWhatsAppUserId(canonical);
  const canonicalIsLid = canonical && isLidUserId(canonical);

  const jid = info.jid || (canonicalIsJid ? canonical : null);
  const lid = info.lid || (canonicalIsLid ? canonical : null);
  const id = canonical || jid || lid || rawId;

  if (!id && !jid && !lid) return null;

  return {
    id,
    jid,
    lid,
    admin: normalizeParticipantAdmin(raw),
  };
};

/**
 * Gera chave canônica para dedupe.
 * @param {Object | null} participant - Participante normalizado.
 * @returns {string | null} Chave canônica ou null.
 */
export const getParticipantKey = (participant) => {
  if (!participant) return null;
  return participant.id || participant.jid || null;
};

/**
 * Normaliza a lista de participantes.
 * @param {Array<Object | string>} [participants=[]] - Lista de participantes.
 * @returns {Array<Object>} Lista normalizada e filtrada.
 */
export const normalizeParticipantsList = (participants = []) => {
  if (!Array.isArray(participants)) return [];
  return participants.map(normalizeParticipant).filter((participant) => participant && (participant.jid || participant.id));
};

/**
 * Monta payload com os campos suportados para persistência.
 * @param {Object} data - Dados de grupo.
 * @returns {Object} Payload filtrado e normalizado.
 */
const buildGroupMetadataPayload = (data) => {
  const payload = {};
  for (const field of GROUP_METADATA_FIELDS) {
    if (data[field] !== undefined) payload[field] = data[field];
  }
  if (payload.participants !== undefined) {
    payload.participants = normalizeParticipantsValue(payload.participants);
  }
  return payload;
};

/**
 * Mescla dados existentes com atualizações, normalizando participantes.
 * @param {Object | null} existing - Dados atuais do banco.
 * @param {Object} updates - Atualizações recebidas.
 * @returns {Object} Payload final pronto para persistência.
 */
export const mergeGroupMetadata = (existing, updates) => {
  const safeExisting = existing || {};
  const merged = {
    ...safeExisting,
    ...updates,
    id: updates.id ?? safeExisting.id,
  };

  if (merged.participants !== undefined) {
    merged.participants = normalizeParticipantsValue(merged.participants);
  }

  return buildGroupMetadataPayload(merged);
};

/**
 * Faz upsert de metadados do grupo no banco.
 * @async
 * @param {string} groupId - ID do grupo.
 * @param {Object} updates - Dados a persistir.
 * @param {Object} [options] - Opções de merge.
 * @param {boolean} [options.mergeExisting=true] - Mescla com dados existentes.
 * @returns {Promise<any | null>} Resultado do upsert ou null quando inválido.
 */
export const upsertGroupMetadata = async (groupId, updates, options = {}) => {
  const { mergeExisting = true } = options;
  const safeUpdates = {
    ...updates,
    id: groupId,
  };

  const payload = mergeExisting ? mergeGroupMetadata(await findById('groups_metadata', groupId), safeUpdates) : buildGroupMetadataPayload(safeUpdates);

  if (!payload.id) {
    logger.warn('Ignorando upsert de grupo sem ID.', { groupId, updates });
    return null;
  }

  return upsert('groups_metadata', payload);
};

/**
 * Aplica ação de participantes (add/remove/promote/demote/modify) sobre a lista atual.
 * @param {Array<Object>} currentParticipants - Participantes atuais.
 * @param {Array<Object | string>} participants - Participantes do evento.
 * @param {string} action - Ação do evento.
 * @returns {Array<Object>} Lista atualizada.
 */
export const applyParticipantAction = (currentParticipants, participants, action) => {
  if (!PARTICIPANT_ACTIONS.has(action)) {
    logger.warn('Ação de participante inválida.', { action });
    return currentParticipants || [];
  }

  const currentMap = new Map(
    (currentParticipants || [])
      .map(normalizeParticipant)
      .filter(Boolean)
      .map((participant) => [getParticipantKey(participant), participant])
      .filter(([key]) => !!key),
  );

  const incoming = Array.isArray(participants) ? participants : [];

  for (const participant of incoming) {
    const normalized = normalizeParticipant(participant);
    const key = getParticipantKey(normalized);
    if (!normalized || !key) continue;
    const hasAdminPayload = hasParticipantAdminPayload(participant);

    if (action === 'add') {
      if (!currentMap.has(key)) currentMap.set(key, normalized);
    } else if (action === 'remove') {
      currentMap.delete(key);
    } else if (action === 'promote') {
      const entry = currentMap.get(key) || normalized;
      if (entry.admin !== 'superadmin') {
        entry.admin = 'admin';
      }
      currentMap.set(key, entry);
    } else if (action === 'demote') {
      const entry = currentMap.get(key);
      if (entry) {
        entry.admin = null;
        currentMap.set(key, entry);
      }
    } else if (action === 'modify') {
      const existing = currentMap.get(key);
      if (!existing) {
        currentMap.set(key, normalized);
        continue;
      }

      const merged = { ...existing, ...normalized };
      if (!hasAdminPayload && Object.prototype.hasOwnProperty.call(existing, 'admin')) {
        merged.admin = existing.admin;
      }
      currentMap.set(key, merged);
    }
  }

  return Array.from(currentMap.values());
};

/**
 * Atualiza participantes do grupo no banco com base em uma ação.
 * @async
 * @param {string} groupId - ID do grupo.
 * @param {Array<Object | string>} participants - Participantes do evento.
 * @param {string} action - Ação do evento.
 * @returns {Promise<Array<Object> | null>} Lista atualizada ou null.
 */
export const updateGroupParticipantsFromAction = async (groupId, participants, action) => {
  if (!groupId || !Array.isArray(participants) || participants.length === 0) return null;
  const normalizedAction = String(action || '')
    .trim()
    .toLowerCase();

  const currentGroup = await findById('groups_metadata', groupId);
  const currentParticipants = parseParticipantsFromDb(currentGroup?.participants);
  const updatedParticipants = applyParticipantAction(currentParticipants, participants, normalizedAction);

  await upsertGroupMetadata(
    groupId,
    {
      participants: updatedParticipants,
    },
    { mergeExisting: true },
  );

  logger.debug('Participantes do grupo atualizados no banco.', {
    groupId,
    action: normalizedAction,
    participantsUpdated: participants.length,
    totalParticipants: updatedParticipants.length,
  });

  return updatedParticipants;
};

/**
 * Constrói metadados de grupo a partir de um evento de update.
 * @param {Object} event - Evento do Baileys.
 * @param {Object | null} existing - Dados atuais do banco.
 * @returns {Object} Metadados prontos para persistência.
 */
export const buildGroupMetadataFromUpdate = (event, existing) => {
  const currentParticipants = parseParticipantsFromDb(existing?.participants);
  const participants = event.participants || currentParticipants;
  const normalizedParticipants = normalizeParticipantsList(participants);
  const resolveExistingValue = (snakeKey, camelKey) => existing?.[snakeKey] ?? existing?.[camelKey];
  const resolveBoolean = (eventValue, snakeKey, camelKey) => {
    if (eventValue !== undefined) return Boolean(eventValue);
    const existingValue = resolveExistingValue(snakeKey, camelKey);
    return existingValue === undefined || existingValue === null ? null : Boolean(existingValue);
  };

  const linkedParentRaw = event.linkedParent ?? resolveExistingValue('linked_parent_jid', 'linkedParent');
  const linkedParent = typeof linkedParentRaw === 'string' ? linkedParentRaw.trim() || null : linkedParentRaw || null;
  const addressingModeRaw = event.addressingMode ?? resolveExistingValue('addressing_mode', 'addressingMode');
  const addressingMode = typeof addressingModeRaw === 'string' ? addressingModeRaw.trim() || null : addressingModeRaw || null;

  return {
    id: event.id,
    subject: event.subject ?? existing?.subject,
    description: event.desc ?? existing?.description,
    owner_jid: event.owner ?? existing?.owner_jid,
    creation: event.creation ?? existing?.creation,
    participants: normalizedParticipants,
    linked_parent_jid: linkedParent,
    is_community: resolveBoolean(event.isCommunity, 'is_community', 'isCommunity'),
    is_community_announce: resolveBoolean(event.isCommunityAnnounce, 'is_community_announce', 'isCommunityAnnounce'),
    member_add_mode: resolveBoolean(event.memberAddMode, 'member_add_mode', 'memberAddMode'),
    join_approval_mode: resolveBoolean(event.joinApprovalMode, 'join_approval_mode', 'joinApprovalMode'),
    addressing_mode: addressingMode,
  };
};

/**
 * Constrói metadados de grupo a partir do snapshot completo do Baileys.
 * @param {Object} group - Grupo do Baileys.
 * @returns {Object} Metadados prontos para persistência.
 */
export const buildGroupMetadataFromGroup = (group) => ({
  id: group.id,
  subject: group.subject,
  description: group.desc,
  owner_jid: group.owner,
  creation: group.creation,
  participants: normalizeParticipantsList(group.participants || []),
  linked_parent_jid: typeof group.linkedParent === 'string' ? group.linkedParent.trim() || null : group.linkedParent || null,
  is_community: group.isCommunity === undefined ? null : Boolean(group.isCommunity),
  is_community_announce: group.isCommunityAnnounce === undefined ? null : Boolean(group.isCommunityAnnounce),
  member_add_mode: group.memberAddMode === undefined ? null : Boolean(group.memberAddMode),
  join_approval_mode: group.joinApprovalMode === undefined ? null : Boolean(group.joinApprovalMode),
  addressing_mode: typeof group.addressingMode === 'string' ? group.addressingMode.trim() || null : group.addressingMode || null,
});
