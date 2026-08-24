import type { IncomingMessage } from 'node:http';
import { createLogger, defineConfig, type Plugin } from 'vite';

/**
 * 開発時は Vite (5173) でフロント、wrangler dev (8787) でサーバを動かす。
 *
 * サーバはマルチプレイと山の記録の共有にだけ必要で、ソロで遊ぶなら不要。
 * 未起動のときに接続エラーをターミナルへ延々と出さないよう、
 * /api は Vite のプロキシを使わず自前のミドルウェアで扱い、
 * 繋がらなければ 204 を返してクライアントをローカル保存へ倒す。
 */
const WORKER = 'http://127.0.0.1:8787';

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function workerApi(): Plugin {
  let noticed = false;
  return {
    name: 'tozanbu-worker-api',
    configureServer(server) {
      server.middlewares.use('/api', (req, res) => {
        void (async () => {
          const path = req.originalUrl ?? req.url ?? '/';
          try {
            const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
            const upstream = await fetch(WORKER + path, {
              method: req.method,
              headers: { 'content-type': String(req.headers['content-type'] ?? 'application/json') },
              body: hasBody ? await readBody(req) : undefined,
            });
            res.statusCode = upstream.status;
            res.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/json');
            res.end(Buffer.from(await upstream.arrayBuffer()));
          } catch {
            if (!noticed) {
              noticed = true;
              server.config.logger.info(
                '  ➜  記録サーバ未起動: この端末のローカル保存で動作します（共有するには npm run dev:mp）',
              );
            }
            res.statusCode = 204;
            res.end();
          }
        })();
      });
    },
  };
}

/** /ws (マルチプレイ) の接続失敗もソロなら想定内なので、赤いスタックを出さない */
const logger = createLogger();
const baseError = logger.error.bind(logger);
logger.error = (msg, options) => {
  if (typeof msg === 'string' && msg.includes('http proxy error')) return;
  baseError(msg, options);
};

export default defineConfig({
  customLogger: logger,
  plugins: [workerApi()],
  server: {
    port: 5173,
    open: false,
    proxy: {
      // WebSocket だけは Vite のプロキシに任せる (ルーム名を入れたときだけ使う)
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
  build: { target: 'es2022' },
});
