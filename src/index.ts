import { buildApp } from './app.js';
import { getConfig } from './config.js';
import { prepareHttpsListener } from './https.js';

const config = getConfig();
const app = await buildApp({ config });

try {
  const secureListener = await prepareHttpsListener(app, config);
  await app.listen({ host: config.host, port: config.port });
  await secureListener.start();
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
  await app.close().catch((closeError) => app.log.error(closeError));
}
