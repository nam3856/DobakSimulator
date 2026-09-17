import type { Plugin } from 'vite';
import { handleCharacterRequest, type CharacterApiEnv } from './character-api';

/** Local development only. This module is never imported by the browser bundle. */
export function characterApiPlugin(
  settings: Pick<CharacterApiEnv, 'NEXON_API_KEY' | 'ALLOWED_ORIGINS'>,
): Plugin {
  const windows = new Map<string, { count: number; expires: number }>();
  const limiter = {
    async limit({ key }: { key: string }) {
      const now = Date.now();
      for (const [ip, record] of windows) if (record.expires <= now) windows.delete(ip);
      const record = windows.get(key) ?? { count: 0, expires: now + 60_000 };
      if (!windows.has(key) && windows.size >= 1000) return { success: false };
      record.count++;
      windows.set(key, record);
      return { success: record.count <= 20 };
    },
  };
  return {
    name: 'local-character-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/')) return next();
        const controller = new AbortController();
        const abort = () => {
          if (!res.writableEnded) controller.abort();
        };
        res.on('close', abort);
        try {
          const headers = new Headers();
          for (const [key, value] of Object.entries(req.headers))
            if (value) headers.set(key, Array.isArray(value) ? value.join(',') : value);
          const request = new Request(
            new URL(req.url, `http://${req.headers.host ?? '127.0.0.1:5173'}`),
            { method: req.method, headers, signal: controller.signal },
          );
          const result = await handleCharacterRequest(
            request,
            { ...settings, CHAR_SEARCH_LIMITER: limiter },
            { rateLimitKey: req.socket.remoteAddress ?? 'local' },
          );
          if (res.destroyed) return;
          res.writeHead(result.status, Object.fromEntries(result.headers));
          res.end(Buffer.from(await result.arrayBuffer()));
        } catch {
          if (!res.destroyed) {
            res.writeHead(500, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            res.end('{"error":{"code":"SERVER_ERROR","message":"캐릭터를 불러오지 못했습니다."}}');
          }
        } finally {
          res.off('close', abort);
        }
      });
    },
  };
}
