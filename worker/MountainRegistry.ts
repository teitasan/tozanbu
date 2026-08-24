/* ===========================================================
   山の永続化 (Durable Object 1インスタンス)。
   Mountain ID / Seed / 難易度 / 山名 / 初登頂者 / 初登頂日時 / 登頂者数 を保持する。
   初登頂と命名は、ここで一度だけ確定する。
   =========================================================== */

import { jsonResponse, sanitizeText, type DurableObjectState, type Env, type MountainRecord } from './types';

const KEY = (id: string) => `m:${id}`;
const MAX_LIST = 100;

function blank(id: string, seed: number, difficulty: number): MountainRecord {
  return {
    id,
    seed,
    difficulty,
    name: null,
    firstAscentBy: null,
    firstAscentParty: null,
    firstAscentAt: null,
    ascents: 0,
  };
}

export class MountainRegistry {
  constructor(
    private readonly ctx: DurableObjectState,
    _env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // /api/mountains[/:id[/:action]]
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'api' || parts[1] !== 'mountains') return jsonResponse({ error: 'not found' }, 404);

    if (parts.length === 2 && request.method === 'GET') {
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 40) || 40, MAX_LIST);
      return jsonResponse({ mountains: await this.list(limit) });
    }

    const id = sanitizeText(parts[2], 24);
    if (!id) return jsonResponse({ error: 'id required' }, 400);
    const action = parts[3];

    if (!action && request.method === 'GET') {
      const rec = await this.ctx.storage.get<MountainRecord>(KEY(id));
      return jsonResponse({ mountain: rec ?? null });
    }

    if (request.method !== 'POST') return jsonResponse({ error: 'method not allowed' }, 405);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const seed = Number(body.seed) >>> 0;
    const difficulty = Math.min(5, Math.max(1, Number(body.difficulty) || 1));

    if (action === 'claim') {
      const rec = await this.claim(id, seed, difficulty, sanitizeText(body.name), sanitizeText(body.by, 16), body.party);
      return jsonResponse({ mountain: rec });
    }
    if (action === 'ascent') {
      const rec = await this.ascent(id, seed, difficulty, sanitizeText(body.by, 16));
      return jsonResponse({ mountain: rec });
    }
    return jsonResponse({ error: 'unknown action' }, 404);
  }

  private async list(limit: number): Promise<MountainRecord[]> {
    const all = await this.ctx.storage.list<MountainRecord>({ prefix: 'm:', limit: MAX_LIST });
    const rows = [...all.values()];
    rows.sort((a, b) => (b.firstAscentAt ?? 0) - (a.firstAscentAt ?? 0));
    return rows.slice(0, limit);
  }

  /** 初登頂と命名。すでに命名済みなら名前は変えない */
  async claim(
    id: string,
    seed: number,
    difficulty: number,
    name: string,
    by: string,
    party: unknown,
  ): Promise<MountainRecord> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const rec = (await this.ctx.storage.get<MountainRecord>(KEY(id))) ?? blank(id, seed, difficulty);
      if (rec.firstAscentAt === null) {
        rec.name = name || null;
        rec.firstAscentBy = by || null;
        rec.firstAscentParty = Array.isArray(party)
          ? (party as unknown[])
              .map((p) => sanitizeText(p, 16))
              .filter(Boolean)
              .slice(0, 8)
          : by
            ? [by]
            : null;
        rec.firstAscentAt = Date.now();
      }
      rec.ascents += 1;
      await this.ctx.storage.put(KEY(id), rec);
      return rec;
    });
  }

  /** 既登頂の山への登頂を1つ足す */
  async ascent(id: string, seed: number, difficulty: number, by: string): Promise<MountainRecord> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const rec = (await this.ctx.storage.get<MountainRecord>(KEY(id))) ?? blank(id, seed, difficulty);
      if (rec.firstAscentAt === null) {
        // 命名しないまま登頂された場合も、初登頂者だけは記録する
        rec.firstAscentBy = by || null;
        rec.firstAscentParty = by ? [by] : null;
        rec.firstAscentAt = Date.now();
      }
      rec.ascents += 1;
      await this.ctx.storage.put(KEY(id), rec);
      return rec;
    });
  }
}
