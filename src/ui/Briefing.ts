/* ===========================================================
   ブリーフィング。

   ローディング画面の代わりに地形図を出す 30 秒。
   ここで大まかなルートを決める。

     どの尾根を使うか / どちらから回り込むか
     急斜面を避けるか直登するか / どこを中間目標にするか

   地図にはピンとルート線を描ける。マルチプレイでは全員に共有される。
   生成が 30 秒より早く終わってもブリーフィングは 30 秒続く。
   =========================================================== */

import type { TopoMap } from '../mountain/TopoMap';

export const BRIEFING_SEC = 30;

/** 地図への書き込み。座標は地図の正規化座標 (0..1) */
export interface MapMark {
  id: string;
  by: string;
  /** 色の番号 (プレイヤーごと) */
  hue: number;
  /** [u,v, u,v, ...]。1点だけならピン */
  pts: number[];
}

const MARK_COLORS = [
  '#c8442e',
  '#1f6fb2',
  '#2f8f4e',
  '#8a4fbf',
  '#c8871a',
  '#0f8f94',
];

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export class Briefing {
  private readonly root = el('briefing');
  private readonly timerEl = el('brief-timer');
  private readonly mtnEl = el('brief-mtn');
  private readonly statusEl = el('brief-status');
  private readonly stage = el('brief-map');
  private readonly partyEl = el('brief-party');
  private readonly clearBtn = el<HTMLButtonElement>('brief-clear');
  private readonly intervalEl = el('brief-interval');
  /** 書き込み用。地形図の上に重ねる */
  private readonly ink = document.createElement('canvas');

  private map: TopoMap | null = null;
  private mapCanvas: HTMLCanvasElement | null = null;
  private marks: MapMark[] = [];
  private drawing: MapMark | null = null;
  private endsAt = 0;
  private timer: number | null = null;
  private selfName = '';
  private selfHue = 0;
  private seq = 0;
  private resolveDone: (() => void) | null = null;

  /** 自分が描いた書き込み (共有する) */
  onMark: ((mark: MapMark) => void) | null = null;
  /** 自分の書き込みを全部消した */
  onClear: (() => void) | null = null;

  constructor() {
    this.ink.className = 'brief-ink';
    this.ink.addEventListener('pointerdown', this.onPointerDown);
    this.ink.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    this.clearBtn.addEventListener('click', () => {
      this.marks = this.marks.filter((m) => m.by !== this.selfName);
      this.redraw();
      this.onClear?.();
    });
  }

  get visible(): boolean {
    return !this.root.classList.contains('hidden');
  }

  /** 残り秒 */
  get remain(): number {
    return Math.max(0, (this.endsAt - performance.now()) / 1000);
  }

  /** ブリーフィングが終わるまで待つ */
  wait(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.visible) {
        resolve();
        return;
      }
      this.resolveDone = resolve;
    });
  }

  /** 生成の進み具合。地図が出るまでの間だけ見せる */
  setStatus(label: string): void {
    this.statusEl.textContent = label;
  }

  setTitle(text: string): void {
    this.mtnEl.textContent = text;
  }

  /** 山の生成を待たずに開く。地図は用意でき次第はめ込む */
  open(title: string, selfName: string, hue: number): void {
    this.selfName = selfName;
    this.selfHue = hue;
    this.marks = [];
    this.drawing = null;
    this.mtnEl.textContent = title;
    this.statusEl.textContent = '地形図を作成中';
    this.statusEl.classList.remove('hidden');
    this.intervalEl.textContent = '';
    this.root.classList.remove('hidden');
    this.endsAt = performance.now() + BRIEFING_SEC * 1000;
    this.tick();
    if (this.timer === null) this.timer = window.setInterval(this.tick, 200);
  }

  /** 地形図ができたので見せる */
  setMap(map: TopoMap): void {
    this.map = map;
    if (this.mapCanvas) this.mapCanvas.remove();
    this.mapCanvas = map.canvas;
    this.mapCanvas.className = 'brief-topo';
    this.stage.insertBefore(this.mapCanvas, this.stage.firstChild);
    if (!this.ink.parentElement) this.stage.appendChild(this.ink);
    this.ink.width = map.size;
    this.ink.height = map.size;
    this.statusEl.classList.add('hidden');
    this.intervalEl.textContent = `等高線 ${map.minor}m ごと（太線 ${map.index}m）`;
    this.redraw();
  }

  setParty(names: string[]): void {
    this.partyEl.textContent = names.length > 1 ? `${names.length}人で登る: ${names.join(' / ')}` : 'ソロ';
  }

  /** 他のプレイヤーの書き込み */
  applyMark(mark: MapMark): void {
    const i = this.marks.findIndex((m) => m.id === mark.id);
    if (i >= 0) this.marks[i] = mark;
    else this.marks.push(mark);
    this.redraw();
  }

  applyMarks(marks: MapMark[]): void {
    for (const m of marks) {
      if (!this.marks.some((o) => o.id === m.id)) this.marks.push(m);
    }
    this.redraw();
  }

  clearBy(name: string): void {
    this.marks = this.marks.filter((m) => m.by !== name);
    this.redraw();
  }

  close(): void {
    this.root.classList.add('hidden');
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.resolveDone?.();
    this.resolveDone = null;
  }

  /** デバッグ用。カウントダウンを飛ばす */
  skip(): void {
    this.endsAt = performance.now();
    this.tick();
  }

  // --- 書き込み -----------------------------------------------------------

  private point(e: PointerEvent): { u: number; v: number } {
    const r = this.ink.getBoundingClientRect();
    return {
      u: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      v: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
  }

  private onPointerDown = (e: PointerEvent) => {
    if (!this.map || e.button !== 0) return;
    e.preventDefault();
    this.ink.setPointerCapture(e.pointerId);
    const p = this.point(e);
    this.drawing = {
      id: `${this.selfName}:${this.seq++}`,
      by: this.selfName,
      hue: this.selfHue,
      pts: [p.u, p.v],
    };
    this.redraw();
  };

  private onPointerMove = (e: PointerEvent) => {
    if (!this.drawing) return;
    const p = this.point(e);
    const n = this.drawing.pts.length;
    // 近すぎる点は捨てる (共有する量を抑える)
    if (Math.hypot(p.u - this.drawing.pts[n - 2], p.v - this.drawing.pts[n - 1]) < 0.008) return;
    this.drawing.pts.push(p.u, p.v);
    this.redraw();
  };

  private onPointerUp = () => {
    const m = this.drawing;
    this.drawing = null;
    if (!m) return;
    this.marks.push(m);
    this.redraw();
    this.onMark?.(m);
  };

  private redraw(): void {
    if (!this.map) return;
    const ctx = this.ink.getContext('2d')!;
    const s = this.ink.width;
    ctx.clearRect(0, 0, s, s);
    const all = this.drawing ? [...this.marks, this.drawing] : this.marks;
    const scale = s / 1400;
    for (const m of all) {
      const color = MARK_COLORS[m.hue % MARK_COLORS.length];
      if (m.pts.length <= 2) {
        // ピン
        const x = m.pts[0] * s;
        const y = m.pts[1] * s;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - 11 * scale, y - 30 * scale);
        ctx.lineTo(x + 11 * scale, y - 30 * scale);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y - 34 * scale, 11 * scale, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.lineWidth = 3 * scale;
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.stroke();
        continue;
      }
      // ルート線
      ctx.beginPath();
      ctx.moveTo(m.pts[0] * s, m.pts[1] * s);
      for (let i = 2; i < m.pts.length; i += 2) ctx.lineTo(m.pts[i] * s, m.pts[i + 1] * s);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = 11 * scale;
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = 6 * scale;
      ctx.stroke();
    }
  }

  private tick = () => {
    const left = this.remain;
    const mm = Math.floor(left / 60);
    const ss = Math.floor(left % 60);
    this.timerEl.textContent = `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
    this.timerEl.classList.toggle('urgent', left <= 5);
    if (left <= 0) {
      if (this.timer !== null) {
        clearInterval(this.timer);
        this.timer = null;
      }
      this.resolveDone?.();
      this.resolveDone = null;
    }
  };
}
