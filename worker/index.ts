/* ===========================================================
   Cloudflare Worker のエントリ。
     /ws?room=...&mountain=...  -> パーティー部屋 (Durable Object)
     /api/mountains...          -> 山の記録 (Durable Object 1インスタンス)
     それ以外                    -> ビルド済みの静的アセット
   =========================================================== */

import { MountainRegistry } from './MountainRegistry';
import { MountainRoom } from './MountainRoom';
import { sanitizeText, type Env } from './types';

export { MountainRegistry, MountainRoom };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      const mountain = sanitizeText(url.searchParams.get('mountain'), 24) || 'unknown';
      const room = sanitizeText(url.searchParams.get('room'), 24) || 'party';
      // 同じ山 + 同じ部屋名でひとつの部屋になる
      const id = env.ROOM.idFromName(`${mountain}:${room}`);
      return env.ROOM.get(id).fetch(request);
    }

    if (url.pathname.startsWith('/api/mountains')) {
      const id = env.REGISTRY.idFromName('global');
      return env.REGISTRY.get(id).fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};
