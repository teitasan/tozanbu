/* ===========================================================
   パーティー用の部屋 (Durable Object)。
   静的な地形は Seed から各クライアントが生成するので同期しない。
   同期するのは動的な状態だけ:
     プレイヤー位置・スタミナ・状態 / ロープ / 踏み跡 / 登頂
   =========================================================== */

import {
  jsonResponse,
  sanitizeText,
  type DurableObjectState,
  type Env,
  type FixedRope,
  type MountainRecord,
} from './types';

const MAX_PLAYERS = 8;
/** 位置更新の最短間隔 (ms) */
const MIN_STATE_MS = 60;
/** 1メッセージで受け付ける踏み跡セル数 */
const MAX_TRAIL_CELLS = 4096;

interface Player {
  id: string;
  name: string;
  ws: WebSocket;
  x: number;
  y: number;
  z: number;
  yaw: number;
  a: string;
  cur: number;
  max: number;
  lastState: number;
}

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export class MountainRoom {
  private readonly players = new Map<WebSocket, Player>();
  /** 踏み跡: セル index -> 踏み固め度 */
  private readonly trail = new Map<number, number>();
  private readonly ropes = new Map<string, FixedRope>();
  private mountainId: string | null = null;
  private record: MountainRecord | null = null;
  private nextId = 1;

  constructor(_ctx: DurableObjectState, _env: Env) {}

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return jsonResponse({ error: 'websocket expected' }, 426);
    }
    if (this.players.size >= MAX_PLAYERS) {
      return jsonResponse({ error: 'room full' }, 503);
    }
    const pair = new WebSocketPair();
    const server = pair[1];
    server.accept();
    this.attach(server);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private attach(ws: WebSocket): void {
    ws.addEventListener('message', (event: MessageEvent) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      this.handle(ws, msg);
    });
    const drop = () => this.leave(ws);
    ws.addEventListener('close', drop);
    ws.addEventListener('error', drop);
  }

  private handle(ws: WebSocket, msg: Record<string, unknown>): void {
    switch (msg.t) {
      case 'join':
        this.join(ws, msg);
        break;
      case 's':
        this.state(ws, msg);
        break;
      case 'trail':
        this.trailUpdate(ws, msg);
        break;
      case 'rope':
        this.ropeUpdate(ws, msg);
        break;
      case 'record':
        this.recordUpdate(ws, msg);
        break;
      case 'ping':
        this.send(ws, { t: 'pong' });
        break;
    }
  }

  private join(ws: WebSocket, msg: Record<string, unknown>): void {
    if (this.players.has(ws)) return;
    const mountainId = sanitizeText(msg.mountain, 24);
    if (this.mountainId && mountainId && this.mountainId !== mountainId) {
      this.send(ws, { t: 'notice', text: 'この部屋では別の山に登っている' });
      ws.close(4001, 'mountain mismatch');
      return;
    }
    this.mountainId = this.mountainId ?? mountainId;

    const player: Player = {
      id: `p${this.nextId++}`,
      name: sanitizeText(msg.name, 16) || '登山者',
      ws,
      x: num(msg.x),
      y: num(msg.y),
      z: num(msg.z),
      yaw: 0,
      a: 'WALK',
      cur: 100,
      max: 100,
      lastState: 0,
    };
    this.players.set(ws, player);

    this.send(ws, {
      t: 'welcome',
      id: player.id,
      mountain: this.mountainId,
      players: [...this.players.values()].filter((p) => p !== player).map(publicPlayer),
      ropes: [...this.ropes.values()],
      trail: flattenTrail(this.trail),
      record: this.record,
    });
    this.broadcast({ t: 'joined', p: publicPlayer(player) }, ws);
  }

  private state(ws: WebSocket, msg: Record<string, unknown>): void {
    const p = this.players.get(ws);
    if (!p) return;
    const now = Date.now();
    if (now - p.lastState < MIN_STATE_MS) return;
    p.lastState = now;
    p.x = num(msg.x);
    p.y = num(msg.y);
    p.z = num(msg.z);
    p.yaw = num(msg.yaw);
    p.a = sanitizeText(msg.a, 10) || 'WALK';
    p.cur = num(msg.cur, 100);
    p.max = num(msg.max, 100);
    this.broadcast({ t: 's', ...publicPlayer(p) }, ws);
  }

  private trailUpdate(ws: WebSocket, msg: Record<string, unknown>): void {
    if (!this.players.has(ws)) return;
    const cells = Array.isArray(msg.c) ? (msg.c as unknown[]) : [];
    if (cells.length === 0 || cells.length > MAX_TRAIL_CELLS * 2) return;
    const accepted: number[] = [];
    for (let i = 0; i + 1 < cells.length; i += 2) {
      const idx = num(cells[i], -1) | 0;
      const val = Math.max(0, Math.min(255, num(cells[i + 1]) | 0));
      if (idx < 0) continue;
      if ((this.trail.get(idx) ?? 0) >= val) continue;
      this.trail.set(idx, val);
      accepted.push(idx, val);
    }
    if (accepted.length) this.broadcast({ t: 'trail', c: accepted }, ws);
  }

  private ropeUpdate(ws: WebSocket, msg: Record<string, unknown>): void {
    const p = this.players.get(ws);
    if (!p) return;
    const r = msg.r as Record<string, unknown> | undefined;
    if (!r) return;
    const wallId = sanitizeText(r.wallId, 24);
    if (!wallId || this.ropes.has(wallId)) return;
    const rope: FixedRope = {
      wallId,
      by: p.name,
      x: num(r.x),
      y: num(r.y),
      z: num(r.z),
      height: num(r.height),
    };
    this.ropes.set(wallId, rope);
    this.broadcast({ t: 'rope', r: rope });
  }

  private recordUpdate(ws: WebSocket, msg: Record<string, unknown>): void {
    const p = this.players.get(ws);
    if (!p) return;
    const rec = msg.record as MountainRecord | undefined;
    if (!rec || typeof rec.id !== 'string') return;
    this.record = rec;
    this.broadcast({ t: 'record', record: rec });
    this.broadcast({ t: 'notice', text: `${p.name} が登頂した` });
  }

  private leave(ws: WebSocket): void {
    const p = this.players.get(ws);
    if (!p) return;
    this.players.delete(ws);
    this.broadcast({ t: 'left', id: p.id });
    if (this.players.size === 0) {
      // 誰もいなくなったら踏み跡とロープは残さない (山そのものは Seed から再生成される)
      this.trail.clear();
      this.ropes.clear();
      this.record = null;
      this.mountainId = null;
    }
  }

  private send(ws: WebSocket, data: unknown): void {
    try {
      ws.send(JSON.stringify(data));
    } catch {
      this.players.delete(ws);
    }
  }

  private broadcast(data: unknown, except?: WebSocket): void {
    const text = JSON.stringify(data);
    for (const [ws] of this.players) {
      if (ws === except) continue;
      try {
        ws.send(text);
      } catch {
        this.players.delete(ws);
      }
    }
  }
}

function publicPlayer(p: Player) {
  return {
    id: p.id,
    name: p.name,
    x: round(p.x),
    y: round(p.y),
    z: round(p.z),
    yaw: round(p.yaw, 3),
    a: p.a,
    cur: round(p.cur, 1),
    max: round(p.max, 1),
  };
}

function round(v: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function flattenTrail(trail: Map<number, number>): number[] {
  const out: number[] = [];
  for (const [idx, val] of trail) out.push(idx, val);
  return out;
}
