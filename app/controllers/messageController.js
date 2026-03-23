import { handleMessagesThroughPipeline } from './messageProcessingPipeline.js';

/**
 * Facade do controller de mensagens.
 * Mantem assinatura/compatibilidade enquanto delega ao pipeline modular.
 */
export const handleMessages = async (update, sock, options = {}) => handleMessagesThroughPipeline(update, sock, options);
