import { executeQuery, TABLES } from '../../../database/index.js';

const sanitizeText = (value, maxLength = 255) => {
  const normalized = String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, maxLength);
  return normalized || null;
};

const sanitizeCommandName = (value) => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 64);
  return normalized || null;
};

const sanitizeBool = (value) => (value ? 1 : 0);

const clampInt = (value, fallback, min, max) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(numeric)));
};

const sanitizeMetadata = (value) => {
  if (!value || typeof value !== 'object') return null;
  try {
    const asJson = JSON.stringify(value);
    if (!asJson || asJson === '{}') return null;
    return asJson;
  } catch {
    return null;
  }
};

let messageAnalysisSessionColumnSupported = true;

export async function createMessageAnalysisEvent(payload = {}, connection = null) {
  const sessionId = sanitizeText(payload.sessionId || payload.session_id, 64) || 'default';
  const ownerSessionId = sanitizeText(payload.ownerSessionId || payload.owner_session_id || payload?.metadata?.owner_session_id, 64);
  const messageId = sanitizeText(payload.messageId, 255);
  const chatId = sanitizeText(payload.chatId, 255);
  const senderId = sanitizeText(payload.senderId, 255);
  const senderName = sanitizeText(payload.senderName, 120);
  const upsertType = sanitizeText(payload.upsertType, 32);
  const source = sanitizeText(payload.source, 32) || 'whatsapp';
  const commandPrefix = sanitizeText(payload.commandPrefix, 8);
  const commandName = sanitizeCommandName(payload.commandName);
  const messageKind = sanitizeText(payload.messageKind, 48) || 'other';
  const processingResult = sanitizeText(payload.processingResult, 64) || 'processed';
  const errorCode = sanitizeText(payload.errorCode, 96);
  const metadata = sanitizeMetadata(payload.metadata);
  const isGroup = sanitizeBool(payload.isGroup);

  if (isGroup && ownerSessionId && ownerSessionId !== sessionId) {
    return false;
  }

  const valuesWithSession = [sessionId, messageId, chatId, senderId, senderName, upsertType, source, isGroup, sanitizeBool(payload.isFromBot), sanitizeBool(payload.isCommand), commandName, clampInt(payload.commandArgsCount, 0, 0, 64), payload.commandKnown === null || payload.commandKnown === undefined ? null : sanitizeBool(payload.commandKnown), commandPrefix, messageKind, sanitizeBool(payload.hasMedia), clampInt(payload.mediaCount, 0, 0, 25), clampInt(payload.textLength, 0, 0, 16_000), processingResult, errorCode, metadata];
  const valuesWithoutSession = valuesWithSession.slice(1);

  const sqlWithSession = `INSERT INTO ${TABLES.MESSAGE_ANALYSIS_EVENT}
      (
        session_id,
        message_id,
        chat_id,
        sender_id,
        sender_name,
        upsert_type,
        source,
        is_group,
        is_from_bot,
        is_command,
        command_name,
        command_args_count,
        command_known,
        command_prefix,
        message_kind,
        has_media,
        media_count,
        text_length,
        processing_result,
        error_code,
        metadata
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  const sqlWithoutSession = `INSERT INTO ${TABLES.MESSAGE_ANALYSIS_EVENT}
      (
        message_id,
        chat_id,
        sender_id,
        sender_name,
        upsert_type,
        source,
        is_group,
        is_from_bot,
        is_command,
        command_name,
        command_args_count,
        command_known,
        command_prefix,
        message_kind,
        has_media,
        media_count,
        text_length,
        processing_result,
        error_code,
        metadata
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  if (messageAnalysisSessionColumnSupported) {
    try {
      await executeQuery(sqlWithSession, valuesWithSession, connection);
      return true;
    } catch (error) {
      if (error?.code !== 'ER_BAD_FIELD_ERROR') {
        throw error;
      }
      messageAnalysisSessionColumnSupported = false;
    }
  }

  await executeQuery(sqlWithoutSession, valuesWithoutSession, connection);

  return true;
}
