import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { connect } from './db.js';

const config = loadConfig();
const db = await connect(config.mongoUri, config.mongoDb);
const { app } = await buildApp({ config, collections: db.c });

const shutdown = async (signal: string) => {
  app.log.info(`${signal}: shutting down`);
  await app.close();
  await db.client.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

app.log.info(`license public key (put this in the app's publicKey.ts): ${config.publicKeyBase64}`);
await app.listen({ host: config.host, port: config.port });
