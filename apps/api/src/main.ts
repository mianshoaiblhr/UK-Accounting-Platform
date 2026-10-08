import { loadConfig } from '@uk/core';
import { createApp } from './bootstrap';
import { LOGGER } from './common/tokens';

async function main() {
  const config = loadConfig();
  const app = await createApp(config);
  await app.listen(config.API_PORT, '0.0.0.0');
  app.get(LOGGER).info({ port: config.API_PORT, env: config.NODE_ENV, region: config.AWS_REGION }, 'api listening');
}
main().catch((err) => { console.error(err); process.exit(1); });
