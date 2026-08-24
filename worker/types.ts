/* Worker 側で使う最小限の型 */

declare global {
  /** Cloudflare Workers の WebSocket 拡張 */
  interface WebSocket {
    accept(): void;
  }
  interface ResponseInit {
    webSocket?: WebSocket;
  }
  // eslint-disable-next-line no-var
  var WebSocketPair: { new (): { 0: WebSocket; 1: WebSocket } };
}

export interface MountainRecord {
  id: string;
  seed: number;
  difficulty: number;
  name: string | null;
  firstAscentBy: string | null;
  firstAscentParty: string[] | null;
  firstAscentAt: number | null;
  ascents: number;
}

export interface FixedRope {
  wallId: string;
  by: string;
  x: number;
  y: number;
  z: number;
  height: number;
}

export interface Env {
  ASSETS: { fetch: (req: Request) => Promise<Response> };
  ROOM: DurableObjectNamespace;
  REGISTRY: DurableObjectNamespace;
}

export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}
export interface DurableObjectId {
  toString(): string;
}
export interface DurableObjectStub {
  fetch(req: Request): Promise<Response>;
}
export interface DurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  list<T>(options?: { prefix?: string; limit?: number }): Promise<Map<string, T>>;
  delete(key: string): Promise<boolean>;
}
export interface DurableObjectState {
  storage: DurableObjectStorage;
  acceptWebSocket(ws: WebSocket): void;
  getWebSockets(): WebSocket[];
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}

/** 名前などの自由入力を安全な短い文字列にする */
export function sanitizeText(raw: unknown, max = 20): string {
  return String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .trim()
    .slice(0, max);
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
