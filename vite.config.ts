/// <reference types="vitest/config" />
import { defineConfig, loadEnv, type Plugin, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Serves the Vercel functions in api/ from the Vite dev server, so `npm run dev` runs the whole app:
 *   - with real Google credentials in .env.local (same variables as on Vercel), or
 *   - with FAKE_DRIVE=1 — an in-memory Drive with sample rounds (see dev/fakeDrive.ts).
 * Without either, there is no /api and the app falls back to the local-folder picker.
 */
function apiDevServer(): Plugin {
  return {
    name: 'api-dev-server',
    apply: 'serve',
    async configureServer(server: ViteDevServer) {
      if (process.env.VITEST) return;
      const env = loadEnv('development', process.cwd(), '');
      const fake = (process.env.FAKE_DRIVE ?? env.FAKE_DRIVE) === '1';
      if (!fake && !env.GOOGLE_API_KEY) return;
      for (const [k, v] of Object.entries(env)) process.env[k] ??= v;

      if (fake) {
        const { FakeDrive, installFakeFetch, seedFakeDrive, seedSampleOrders } = await server.ssrLoadModule('/dev/fakeDrive.ts');
        const drive = new FakeDrive();
        installFakeFetch(drive);
        seedSampleOrders(drive, await seedFakeDrive(drive));
        server.config.logger.info('  ➜  API: fake Drive (admin password: ' + process.env.ADMIN_PASSWORD + ')');
      }

      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => {
        const name = /^\/api\/([a-z]+)(?:\?|$)/.exec(req.url ?? '')?.[1];
        if (!name) return next();
        try {
          const mod = await server.ssrLoadModule(`/api/${name}.ts`);
          const handler = mod[req.method ?? 'GET'] as ((r: Request) => Promise<Response>) | undefined;
          if (!handler) {
            res.statusCode = 405;
            res.end();
            return;
          }
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const headers = new Headers();
          for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
          const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
          const response = await handler(
            new Request('http://' + req.headers.host + req.url, {
              method: req.method,
              headers,
              body: hasBody ? Buffer.concat(chunks) : undefined,
            }),
          );
          res.statusCode = response.status;
          response.headers.forEach((v, k) => {
            if (k !== 'set-cookie') res.setHeader(k, v);
          });
          const cookies = response.headers.getSetCookie?.() ?? [];
          if (cookies.length) res.setHeader('set-cookie', cookies);
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch (err) {
          next(err);
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), apiDevServer()],
  test: {
    environment: 'jsdom',
  },
});
