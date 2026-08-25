/* ===========================================================
   マルチプレイのクライアント。
   静的な山は Seed から各自が生成するので送らない。
   送るのは動的な状態だけ (位置・スタミナ・状態・ロープ・踏み跡・登頂)。
   =========================================================== */

import type { MountainRecord } from '../mountain/Mountain';
import type { FixedRope } from '../systems/RopeSystem';
import type { MapMark } from '../ui/Briefing';

export interface RemoteSnapshot {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  a: string;
  cur: number;
  max: number;
}

export interface JoinOptions {
  mountainId: string;
  room: string;
  name: string;
  x: number;
  y: number;
  z: number;
}

export class NetClient {
  private ws: WebSocket | null = null;
  private lastStateAt = 0;

  connected = false;
  selfId: string | null = null;

  onWelcome: ((data: {
    players: RemoteSnapshot[];
    ropes: FixedRope[];
    marks: MapMark[];
    trail: number[];
    record: MountainRecord | null;
  }) => void) | null = null;
  onJoin: ((p: RemoteSnapshot) => void) | null = null;
  onLeave: ((id: string) => void) | null = null;
  onState: ((p: RemoteSnapshot) => void) | null = null;
  onTrail: ((cells: number[]) => void) | null = null;
  onMark: ((mark: MapMark) => void) | null = null;
  onUnmark: ((by: string) => void) | null = null;
  onRope: ((rope: FixedRope) => void) | null = null;
  onRecord: ((record: MountainRecord) => void) | null = null;
  onNotice: ((text: string) => void) | null = null;
  onClose: (() => void) | null = null;

  connect(opts: JoinOptions): void {
    this.close();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws?mountain=${encodeURIComponent(
      opts.mountainId,
    )}&room=${encodeURIComponent(opts.room)}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.onNotice?.('サーバに接続できない (ソロで続行)');
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.connected = true;
      this.send({ t: 'join', mountain: opts.mountainId, name: opts.name, x: opts.x, y: opts.y, z: opts.z });
    });
    ws.addEventListener('message', (e) => this.receive(String(e.data)));
    ws.addEventListener('close', () => {
      this.connected = false;
      this.selfId = null;
      this.onClose?.();
    });
    ws.addEventListener('error', () => {
      this.onNotice?.('サーバに接続できない (ソロで続行)');
    });
  }

  private receive(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (msg.t) {
      case 'welcome':
        this.selfId = String(msg.id);
        this.onWelcome?.({
          players: (msg.players as RemoteSnapshot[]) ?? [],
          ropes: (msg.ropes as FixedRope[]) ?? [],
          marks: (msg.marks as MapMark[]) ?? [],
          trail: (msg.trail as number[]) ?? [],
          record: (msg.record as MountainRecord | null) ?? null,
        });
        break;
      case 'joined':
        this.onJoin?.(msg.p as RemoteSnapshot);
        break;
      case 'left':
        this.onLeave?.(String(msg.id));
        break;
      case 's':
        this.onState?.(msg as unknown as RemoteSnapshot);
        break;
      case 'trail':
        this.onTrail?.((msg.c as number[]) ?? []);
        break;
      case 'mark':
        this.onMark?.(msg.m as MapMark);
        break;
      case 'unmark':
        this.onUnmark?.(String(msg.by));
        break;
      case 'rope':
        this.onRope?.(msg.r as FixedRope);
        break;
      case 'record':
        this.onRecord?.(msg.record as MountainRecord);
        break;
      case 'notice':
        this.onNotice?.(String(msg.text));
        break;
    }
  }

  private send(data: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(data));
  }

  /** 位置とスタミナ。10Hz 程度に間引く */
  sendState(x: number, y: number, z: number, yaw: number, a: string, cur: number, max: number): void {
    if (!this.connected) return;
    const now = performance.now();
    if (now - this.lastStateAt < 95) return;
    this.lastStateAt = now;
    this.send({ t: 's', x, y, z, yaw, a, cur, max });
  }

  /** ブリーフィングで地図に描いたもの */
  sendMark(mark: MapMark): void {
    if (this.connected) this.send({ t: 'mark', m: mark });
  }

  /** 自分の書き込みを全部消す */
  sendUnmark(): void {
    if (this.connected) this.send({ t: 'unmark' });
  }

  sendTrail(cells: number[]): void {
    if (this.connected && cells.length) this.send({ t: 'trail', c: cells });
  }

  sendRope(rope: FixedRope): void {
    if (this.connected) this.send({ t: 'rope', r: rope });
  }

  sendRecord(record: MountainRecord): void {
    if (this.connected) this.send({ t: 'record', record });
  }

  close(): void {
    if (this.ws) {
      this.ws.onclose = null;
      try {
        this.ws.close();
      } catch {
        /* すでに閉じている */
      }
    }
    this.ws = null;
    this.connected = false;
    this.selfId = null;
  }
}
