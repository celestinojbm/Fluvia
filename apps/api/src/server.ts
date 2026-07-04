import { loadConfig } from '@fluvia/config';
import { createPool } from '@fluvia/db';
import { AuthService } from '@fluvia/auth';
import { ApiKeyService, IdentityService } from '@fluvia/identity';
import { buildApp } from './app.js';

const config = loadConfig();
const appPool = createPool({ connectionString: config.db.app });
const authPool = createPool({ connectionString: config.db.auth, max: 5 });
const app = buildApp({
  config,
  appPool,
  authService: new AuthService(authPool, { mfaEncryptionKeyHex: config.mfaSecretKey }),
  identityService: new IdentityService(appPool),
  apiKeyService: new ApiKeyService(appPool),
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'graceful shutdown started');
  await app.close();
  await Promise.all([appPool.end(), authPool.end()]);
  process.exit(0);
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => void shutdown(signal));
}

app.listen({ port: config.port, host: '0.0.0.0' }).catch((err) => {
  app.log.fatal({ err }, 'failed to start api');
  process.exit(1);
});
