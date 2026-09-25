import { serve } from '@hono/node-server';
import { compose } from './composition';

// Long-running Node server (container hosts, local runs).
const { http, db, logger } = compose();
const port = Number(process.env.PORT ?? 8787);
serve({ fetch: http.fetch, port }, () => logger.info('api.started', { port }));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    logger.info('api.stopping', { signal });
    await db.close();
    process.exit(0);
  });
}
