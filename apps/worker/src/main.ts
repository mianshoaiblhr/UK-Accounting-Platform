import { createLogger, loadConfig } from '@uk/core';
import { startWorker } from './worker';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL, 'worker');
const handle = startWorker(config, logger);
logger.info({ region: config.AWS_REGION }, 'worker started');

const shutdown = async (sig: string) => {
  logger.info({ sig }, 'shutting down');
  await handle.stop();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
