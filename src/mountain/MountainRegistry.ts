/* ===========================================================
   山の永続性。
   Mountain ID / Seed / 難易度 / 山名 / 初登頂者 / 初登頂日時 / 登頂者数
   をサーバへ保存する。サーバに繋がらない場合は localStorage に退避する。
   =========================================================== */

import type { DifficultyLevel } from './difficulty';
import { mountainId, newRecord, type MountainRecord } from './Mountain';

const LOCAL_KEY = 'tozanbu.mountains.v1';

function loadLocal(): Record<string, MountainRecord> {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_KEY) ?? '{}') as Record<string, MountainRecord>;
  } catch {
    return {};
  }
}

function saveLocal(all: Record<string, MountainRecord>): void {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(all));
  } catch {
    /* 保存できなくてもゲームは続く */
  }
}

export class MountainRegistry {
  /** サーバが応答しなかった場合は以降ローカルのみで動く */
  private online = true;
  /** 起動時の疎通確認。同時に何本も投げないよう1本にまとめる */
  private probe: Promise<boolean> | null = null;

  constructor(private readonly baseUrl = '') {}

  get isOnline(): boolean {
    return this.online;
  }

  /** サーバがあるかを一度だけ確かめる */
  private async ensureOnline(): Promise<boolean> {
    if (!this.online) return false;
    this.probe ??= (async () => {
      try {
        const res = await fetch(`${this.baseUrl}/api/mountains?limit=1`);
        if (!res.ok) throw new Error(String(res.status));
        await res.json();
        return true;
      } catch {
        this.online = false;
        console.info(
          '[Registry] 山の記録サーバに接続できないため、この端末のローカル保存で動作します' +
            '（マルチプレイと共有記録を使うには npm run dev:mp）',
        );
        return false;
      }
    })();
    return this.probe;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T | null> {
    if (!(await this.ensureOnline())) return null;
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
      });
      if (!res.ok) throw new Error(String(res.status));
      return (await res.json()) as T;
    } catch {
      this.online = false;
      return null;
    }
  }

  /** 記録済みの山を新しい順に返す */
  async list(limit = 40): Promise<MountainRecord[]> {
    const remote = await this.request<{ mountains: MountainRecord[] }>(`/api/mountains?limit=${limit}`);
    if (remote) return remote.mountains;
    const all = Object.values(loadLocal());
    all.sort((a, b) => (b.firstAscentAt ?? 0) - (a.firstAscentAt ?? 0));
    return all.slice(0, limit);
  }

  async get(seed: number, difficulty: DifficultyLevel): Promise<MountainRecord> {
    const id = mountainId(seed, difficulty);
    const remote = await this.request<{ mountain: MountainRecord }>(`/api/mountains/${id}`);
    if (remote?.mountain) return remote.mountain;
    const all = loadLocal();
    return all[id] ?? newRecord(seed, difficulty);
  }

  /** 初登頂を確定させ、命名する */
  async claim(record: MountainRecord, name: string, by: string, party: string[]): Promise<MountainRecord> {
    const remote = await this.request<{ mountain: MountainRecord }>(`/api/mountains/${record.id}/claim`, {
      method: 'POST',
      body: JSON.stringify({ seed: record.seed, difficulty: record.difficulty, name, by, party }),
    });
    if (remote?.mountain) {
      this.cache(remote.mountain);
      return remote.mountain;
    }
    const all = loadLocal();
    const cur = all[record.id] ?? newRecord(record.seed, record.difficulty);
    if (cur.firstAscentAt === null) {
      cur.name = name;
      cur.firstAscentBy = by;
      cur.firstAscentParty = party;
      cur.firstAscentAt = Date.now();
    }
    cur.ascents += 1;
    all[cur.id] = cur;
    saveLocal(all);
    return cur;
  }

  /** 既登頂の山への登頂を記録する */
  async recordAscent(record: MountainRecord, by: string): Promise<MountainRecord> {
    const remote = await this.request<{ mountain: MountainRecord }>(`/api/mountains/${record.id}/ascent`, {
      method: 'POST',
      body: JSON.stringify({ seed: record.seed, difficulty: record.difficulty, by }),
    });
    if (remote?.mountain) {
      this.cache(remote.mountain);
      return remote.mountain;
    }
    const all = loadLocal();
    const cur = all[record.id] ?? newRecord(record.seed, record.difficulty);
    cur.ascents += 1;
    all[cur.id] = cur;
    saveLocal(all);
    return cur;
  }

  private cache(record: MountainRecord): void {
    const all = loadLocal();
    all[record.id] = record;
    saveLocal(all);
  }
}
