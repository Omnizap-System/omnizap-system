/**
 * Entry-point (bootstrap) do Omnizap.
 *
 * Responsabilidades principais:
 * - Inicializar o banco (garantindo DB e tabelas).
 * - Subir servidor HTTP (catálogo web + endpoint de métricas).
 * - Rodar backfill do lid_map (opcional, em background).
 * - Conectar ao WhatsApp (Baileys).
 * - Iniciar serviços auxiliares (ex: broadcast de notícias).
 * - Registrar handlers de shutdown gracioso (SIGINT/SIGTERM) e falhas fatais
 *   (uncaughtException/unhandledRejection).
 *
 * Observações:
 * - Este arquivo foi desenhado para ser "production-safe": tem timeouts, shutdown idempotente,
 *   e evita process.exit() imediato para não cortar logs/flush e não interromper fechamentos.
 */

import 'dotenv/config';

import logger from '#logger';
import { connectToWhatsApp, getActiveSocket } from './app/connection/socketController.js';
import { backfillLidMapFromMessagesOnce } from './app/config/index.js';
import { initializeNewsBroadcastService, stopNewsBroadcastService } from './app/services/messaging/newsBroadcastService.js';
import initializeDatabase from './database/init.js';
import { startHttpServer, stopHttpServer } from './server/index.js';
import { startEmailAutomationRuntime, stopEmailAutomationRuntime } from './server/email/emailAutomationRuntime.js';
import { startStickerClassificationBackground, stopStickerClassificationBackground } from './app/modules/stickerPackModule/stickerClassificationBackgroundRuntime.js';
import { startStickerAutoPackByTagsBackground, stopStickerAutoPackByTagsBackground } from './app/modules/stickerPackModule/stickerAutoPackByTagsRuntime.js';
import { isStickerWorkerPipelineEnabled, startStickerWorkerPipeline, stopStickerWorkerPipeline } from './app/modules/stickerPackModule/stickerWorkerPipelineRuntime.js';
import { startStickerPackScoreSnapshotRuntime, stopStickerPackScoreSnapshotRuntime } from './app/modules/stickerPackModule/stickerPackScoreSnapshotRuntime.js';
import { startStickerDomainEventConsumer, stopStickerDomainEventConsumer } from './app/modules/stickerPackModule/stickerDomainEventConsumerRuntime.js';
import { startAiLearningWorker, stopAiLearningWorker } from './app/workers/aiLearningWorker.js';
import { startCommandConfigEnrichmentWorker, stopCommandConfigEnrichmentWorker } from './app/workers/commandConfigEnrichmentWorker.js';
import { startAiHelperContinuousLearningWorker, stopAiHelperContinuousLearningWorker } from './app/workers/aiHelperContinuousLearningWorker.js';
import { formatCommandConfigValidationReport, validateAllCommandConfigs } from './app/services/ai/commandConfigValidationService.js';

/**
 * Timeout máximo para inicialização do banco (criar/verificar DB + tabelas).
 * Evita travar o processo em caso de MySQL indisponível ou DNS lento.
 * @type {number}
 */
const DB_INIT_TIMEOUT_MS = 15000;

/**
 * Timeout máximo para conexão inicial do WhatsApp.
 * Dependendo da rede/servidor, a conexão pode demorar, então é maior.
 * @type {number}
 */
const WHATSAPP_CONNECT_TIMEOUT_MS = 60000;

/**
 * Tempo máximo que o shutdown deve aguardar o backfill finalizar.
 * Como backfill é "best-effort", não devemos segurar o shutdown por muito tempo.
 * @type {number}
 */
const BACKFILL_SHUTDOWN_TIMEOUT_MS = 8000;

/**
 * Flag para impedir múltiplos shutdowns concorrentes.
 * @type {boolean}
 */
let isShuttingDown = false;

/**
 * Promise do shutdown em andamento (para idempotência).
 * Se o shutdown for chamado novamente, devolvemos essa mesma promise.
 * @type {Promise<void>|null}
 */
let shutdownPromise = null;

/**
 * Promise do backfill (quando habilitado).
 * Guardamos para poder aguardar com timeout durante o shutdown.
 * @type {Promise<any>|null}
 */
let backfillPromise = null;

/**
 * Erros transitórios conhecidos que não devem derrubar o serviço inteiro.
 * Ex.: limite temporário da API do WhatsApp/Baileys.
 *
 * @param {unknown} reason
 * @returns {boolean}
 */
const isTransientUnhandledRejection = (reason) => {
  const message = reason instanceof Error ? String(reason.message || '') : typeof reason === 'string' ? reason : String(reason || '');

  const normalized = message.trim().toLowerCase();
  if (!normalized) return false;

  return normalized.includes('rate-overlimit') || normalized.includes('connection closed') || normalized.includes('timed out');
};

/**
 * Executa uma Promise com um timeout.
 *
 * Útil para passos críticos que podem travar:
 * - init do banco
 * - conectar WhatsApp
 * - fechar recursos no shutdown
 *
 * @template T
 * @param {Promise<T>|T} promise - Promise (ou valor) a ser resolvido.
 * @param {number} ms - Tempo máximo em milissegundos.
 * @param {string} label - Nome curto do passo para mensagens de erro.
 * @returns {Promise<T>} Resolve com o valor da Promise, ou rejeita com erro ETIMEOUT.
 */
const withTimeout = (promise, ms, label) => {
  /** @type {NodeJS.Timeout|undefined} */
  let timeoutId;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error(`${label} excedeu ${ms}ms`);
      // Ajuda a filtrar em logs/telemetria
      // @ts-ignore - code é campo comum, mas não está no tipo padrão de Error
      error.code = 'ETIMEOUT';
      reject(error);
    }, ms);
  });

  return Promise.race([Promise.resolve(promise), timeoutPromise]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  });
};

/**
 * Log helper para erros durante o shutdown, mantendo output consistente.
 *
 * @param {string} context - Texto curto do contexto (ex: "Detalhes do desligamento.").
 * @param {unknown} error - Erro (ou reason) para log.
 * @returns {void}
 */
const logShutdownError = (context, error) => {
  if (!error) return;

  if (error instanceof Error) {
    logger.error(context, { error: error.message, stack: error.stack });
    return;
  }

  logger.error(context, { reason: error });
};

/**
 * Encerra o pool de conexões do MySQL (se existir).
 *
 * Por que o import dinâmico?
 * - Evita problemas de "import cycle" em cenários onde o DB module importa coisas
 *   que acabam importando este entrypoint (ou dependências).
 * - Só carrega o módulo no momento do shutdown.
 *
 * @returns {Promise<void>}
 */
async function closeDatabasePool() {
  try {
    const dbModule = await import('./database/index.js');
    if (typeof dbModule.closePool !== 'function') {
      // O módulo não expõe closePool, então não há o que encerrar aqui.
      return;
    }

    logger.info('Encerrando pool MySQL...');
    await withTimeout(dbModule.closePool(), 8000, 'closePool');
    logger.info('Pool MySQL encerrado.');
  } catch (error) {
    logger.warn('Falha ao encerrar pool MySQL.', { error: error?.message });
  }
}

/**
 * Inicializa o sistema e seus serviços principais.
 *
 * Fluxo de startup:
 * 1) Inicializa DB (cria/verifica DB/tabelas)
 * 2) Sobe servidor HTTP (catálogo + métricas)
 * 3) Inicia backfill (opcional) em background
 * 4) Conecta no WhatsApp
 * 5) Inicia serviços auxiliares (news broadcast)
 * 6) Sinaliza readiness (se estiver rodando sob PM2/cluster com IPC)
 *
 * Em caso de falha: seta exitCode e aciona shutdown gracioso.
 *
 * @returns {Promise<void>}
 */
async function startApp() {
  try {
    logger.info('Iniciando Omnizap...');

    const shouldValidateCommandConfigs = process.env.COMMAND_CONFIG_VALIDATE_ON_BOOT !== 'false';
    if (shouldValidateCommandConfigs) {
      logger.info('Validando commandConfig dos modulos...');
      const validation = validateAllCommandConfigs();
      if (!validation.ok) {
        const report = formatCommandConfigValidationReport(validation, { maxErrors: 60 });
        logger.error('Validacao de commandConfig falhou.', { report });
        throw new Error('commandConfig validation failed');
      }
      logger.info('Validacao de commandConfig concluida com sucesso.', {
        modules: validation.modulesValidated,
        commands: validation.commandsValidated,
      });
    } else {
      logger.warn('Validacao de commandConfig no boot desativada via env.', {
        env: 'COMMAND_CONFIG_VALIDATE_ON_BOOT=false',
      });
    }

    logger.info('Iniciando banco de dados...');
    await withTimeout(initializeDatabase(), DB_INIT_TIMEOUT_MS, 'Inicializacao do banco');
    logger.info('Banco de dados pronto.');

    logger.info('Inicializando servidor HTTP...');
    startHttpServer();
    startEmailAutomationRuntime();
    if (isStickerWorkerPipelineEnabled()) {
      startStickerWorkerPipeline();
    } else {
      startStickerClassificationBackground();
      startStickerAutoPackByTagsBackground();
    }
    startStickerPackScoreSnapshotRuntime();
    startStickerDomainEventConsumer();
    startAiLearningWorker();
    startCommandConfigEnrichmentWorker();
    startAiHelperContinuousLearningWorker();

    // Backfill é opcional, rodando em background.
    const shouldBackfill = process.env.LID_BACKFILL_ON_START !== 'false';
    if (shouldBackfill) {
      const batchSize = Number(process.env.LID_BACKFILL_BATCH) || undefined;

      logger.info('Iniciando backfill lid_map...');
      backfillPromise = backfillLidMapFromMessagesOnce({ batchSize })
        .then((result) => {
          logger.info('Backfill lid_map concluido.', { batches: result?.batches });
          return result;
        })
        .catch((error) => {
          logger.warn('Backfill lid_map nao concluido.', { error: error.message });
          return null;
        });
    }

    logger.info('Conectando ao WhatsApp...');
    await withTimeout(connectToWhatsApp(), WHATSAPP_CONNECT_TIMEOUT_MS, 'Conexao WhatsApp');
    logger.info('WhatsApp conectado.');

    logger.info('Inicializando servico de noticias...');
    await initializeNewsBroadcastService();
    logger.info('Servico de noticias pronto.');

    logger.info('Omnizap iniciado com sucesso.');

    // Compatível com gerenciadores que esperam "ready" via IPC.
    if (process.send) {
      process.send('ready');
    }
  } catch (err) {
    logger.error('Falha ao iniciar o Omnizap:', { error: err.message, stack: err.stack });
    process.exitCode = 1;
    await shutdown('STARTUP_ERROR', err);
  }
}

startApp();

/**
 * Realiza desligamento gracioso do sistema (idempotente).
 *
 * O que fecha:
 * - serviço de notícias (se stop existir)
 * - aguarda backfill (com timeout curto)
 * - encerra socket do WhatsApp
 * - encerra servidor HTTP
 * - encerra pool do MySQL
 *
 * Regras:
 * - Se já estiver desligando, retorna a mesma promise.
 * - Define process.exitCode se ainda não estiver definido.
 * - Ao finalizar, encerra o processo explicitamente para permitir restart limpo no PM2.
 *
 * @param {string} signal - Origem do shutdown (SIGINT, SIGTERM, uncaughtException, etc).
 * @param {unknown} [error] - Erro associado (se houver).
 * @returns {Promise<void>}
 */
async function shutdown(signal, error) {
  if (isShuttingDown) {
    return shutdownPromise;
  }
  isShuttingDown = true;

  if (process.exitCode === undefined || process.exitCode === null) {
    process.exitCode = error ? 1 : 0;
  }

  logger.warn(`${signal} recebido. Iniciando desligamento gracioso...`);
  logShutdownError('Detalhes do desligamento.', error);

  shutdownPromise = (async () => {
    // 1) Serviços com timers/intervals (news broadcast)
    try {
      if (typeof stopNewsBroadcastService === 'function') {
        logger.info('Encerrando servico de noticias...');
        stopNewsBroadcastService();
        logger.info('Servico de noticias encerrado.');
      }
    } catch (stopError) {
      logger.warn('Falha ao encerrar servico de noticias.', { error: stopError.message });
    }

    // 2) Esperar backfill (best-effort) com timeout
    if (backfillPromise) {
      try {
        logger.info('Aguardando backfill lid_map...');
        await withTimeout(backfillPromise, BACKFILL_SHUTDOWN_TIMEOUT_MS, 'Backfill lid_map');
        logger.info('Backfill lid_map finalizado.');
      } catch (backfillError) {
        logger.warn('Backfill lid_map nao finalizou antes do shutdown.', {
          error: backfillError.message,
        });
      }
    }

    // 3) Encerrar conexão WhatsApp
    const sock = getActiveSocket();
    if (sock) {
      try {
        logger.info('Encerrando conexão do WhatsApp...');
        await withTimeout(sock.end(), 8000, 'Encerramento WhatsApp');
        logger.info('Conexao do WhatsApp encerrada.');
      } catch (sockError) {
        logger.error('Erro ao encerrar a conexão do WhatsApp:', {
          error: sockError.message,
          stack: sockError.stack,
        });
      }
    }

    // 4) Encerrar servidor HTTP
    if (typeof stopHttpServer === 'function') {
      try {
        logger.info('Encerrando servidor HTTP...');
        await withTimeout(stopHttpServer(), 8000, 'Encerramento HTTP');
        logger.info('Servidor HTTP encerrado.');
      } catch (httpError) {
        logger.warn('Falha ao encerrar servidor HTTP.', { error: httpError.message });
      }
    }

    // 4.1) Encerrar worker de classificação de stickers
    try {
      if (isStickerWorkerPipelineEnabled()) {
        stopStickerWorkerPipeline();
      } else {
        stopStickerClassificationBackground();
      }
    } catch (workerError) {
      logger.warn('Falha ao encerrar worker de classificação de stickers.', {
        error: workerError?.message,
      });
    }

    try {
      if (!isStickerWorkerPipelineEnabled()) {
        stopStickerAutoPackByTagsBackground();
      }
    } catch (workerError) {
      logger.warn('Falha ao encerrar worker de auto-pack por tags.', {
        error: workerError?.message,
      });
    }

    try {
      stopStickerPackScoreSnapshotRuntime();
    } catch (snapshotError) {
      logger.warn('Falha ao encerrar runtime de snapshot de score dos packs.', {
        error: snapshotError?.message,
      });
    }

    try {
      stopStickerDomainEventConsumer();
    } catch (consumerError) {
      logger.warn('Falha ao encerrar consumidor interno de eventos de domínio.', {
        error: consumerError?.message,
      });
    }

    try {
      stopAiLearningWorker();
    } catch (learningWorkerError) {
      logger.warn('Falha ao encerrar worker de aprendizado de IA.', {
        error: learningWorkerError?.message,
      });
    }

    try {
      stopCommandConfigEnrichmentWorker();
    } catch (commandConfigWorkerError) {
      logger.warn('Falha ao encerrar worker de enriquecimento de commandConfig.', {
        error: commandConfigWorkerError?.message,
      });
    }

    try {
      stopAiHelperContinuousLearningWorker();
    } catch (continuousLearningWorkerError) {
      logger.warn('Falha ao encerrar worker de aprendizado contínuo de IA.', {
        error: continuousLearningWorkerError?.message,
      });
    }

    try {
      stopEmailAutomationRuntime();
    } catch (emailRuntimeError) {
      logger.warn('Falha ao encerrar runtime de automação de e-mail.', {
        error: emailRuntimeError?.message,
      });
    }

    // 5) Encerrar MySQL pool
    await closeDatabasePool();

    logger.info('Omnizap desligado.');

    const exitCode = Number(process.exitCode ?? (error ? 1 : 0));
    logger.info('Encerrando processo Node.', { exitCode, signal });
    // Força término para evitar processo "online" sem servidor HTTP ativo.
    process.exit(exitCode);
  })();

  return shutdownPromise;
}

/**
 * Handler para interrupção no terminal (Ctrl+C).
 * @returns {void}
 */
process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

/**
 * Handler para encerramento solicitado pelo sistema (ex: container/PM2).
 * @returns {void}
 */
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

/**
 * Handler para exceções não capturadas (fatal).
 * - seta exitCode=1
 * - inicia shutdown gracioso para tentar fechar recursos antes de morrer
 *
 * @param {Error} err
 * @returns {void}
 */
process.on('uncaughtException', (err) => {
  logger.error('Exceção não capturada:', { error: err.message, stack: err.stack });
  process.exitCode = 1;
  void shutdown('uncaughtException', err);
});

/**
 * Handler para rejeições de promise sem catch (fatal).
 * - loga reason
 * - seta exitCode=1
 * - inicia shutdown gracioso
 *
 * Observação: o parâmetro `promise` é incluído apenas para debug, mas geralmente não é útil.
 *
 * @param {unknown} reason
 * @param {Promise<unknown>} promise
 * @returns {void}
 */
process.on('unhandledRejection', (reason, promise) => {
  if (isTransientUnhandledRejection(reason)) {
    logger.warn('Rejeição de promessa transitória ignorada para manter disponibilidade.', {
      reason: reason instanceof Error ? reason.message : String(reason || ''),
    });
    return;
  }

  if (reason instanceof Error) {
    logger.error('Rejeição de promessa não tratada:', {
      error: reason.message,
      stack: reason.stack,
    });
  } else {
    logger.error('Rejeição de promessa não tratada:', { reason, promise });
  }
  process.exitCode = 1;
  void shutdown('unhandledRejection', reason);
});
