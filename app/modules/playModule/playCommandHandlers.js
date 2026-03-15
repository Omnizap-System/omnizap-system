import { DEFAULT_COMMAND_PREFIX, handleTypedPlayCommand } from './playCommandCore.js';

/**
 * Handler do comando play (audio).
 * @param {object} sock
 * @param {string} remoteJid
 * @param {object} messageInfo
 * @param {number} expirationMessage
 * @param {string} text
 * @returns {Promise<void>}
 */
export const handlePlayCommand = async (sock, remoteJid, messageInfo, expirationMessage, text, commandPrefix = DEFAULT_COMMAND_PREFIX) =>
  handleTypedPlayCommand({
    sock,
    remoteJid,
    messageInfo,
    expirationMessage,
    text,
    commandPrefix,
    type: 'audio',
  });

/**
 * Handler do comando playvid (video).
 * @param {object} sock
 * @param {string} remoteJid
 * @param {object} messageInfo
 * @param {number} expirationMessage
 * @param {string} text
 * @returns {Promise<void>}
 */
export const handlePlayVidCommand = async (sock, remoteJid, messageInfo, expirationMessage, text, commandPrefix = DEFAULT_COMMAND_PREFIX) =>
  handleTypedPlayCommand({
    sock,
    remoteJid,
    messageInfo,
    expirationMessage,
    text,
    commandPrefix,
    type: 'video',
  });
