/* ===========================================================
   地形図。

   3Dの山と同じ Heightfield から等高線を引く。
   同じ標高データを見ているので、
   **地図で等高線が密な場所は実際にも急斜面**になる。
   地図を読む意味があるのはそのため。

   載せるのは地図の縮尺で判別できるものだけ。

     等高線 / 標高 / 山頂 / 登山開始地点 / 方角 / 縮尺 / 崖

   岩肌の難易度・クラック・小さな段差は載せない。
   そこは実際に取り付いてから見て決める。
   =========================================================== */

import { MOVE } from '../core/types';
import type { Heightfield } from './Heightfield';
import type { DifficultyProfile } from './difficulty';

/** 北は -Z。地図の上が北になる */
export interface MapPoint {
  x: number;
  y: number;
}

const PAPER = '#efe9dc';

/** 等高線の間隔を山の高さから決める */
function intervals(peak: number): { minor: number; index: number } {
  if (peak <= 130) return { minor: 5, index: 25 };
  if (peak <= 200) return { minor: 10, index: 50 };
  return { minor: 10, index: 50 };
}

interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export class TopoMap {
  readonly canvas: HTMLCanvasElement;
  /** 地図が覆う一辺 (m) */
  readonly extent: number;
  readonly centerX: number;
  readonly centerZ: number;
  readonly minor: number;
  readonly index: number;
  /** 描画解像度 (px) */
  readonly size: number;

  /** 地図の解像度で拾った標高 */
  private sample = new Float32Array(0);
  private sn = 0;
  private stride = 0;

  constructor(
    private readonly field: Heightfield,
    private readonly profile: DifficultyProfile,
    size = 1400,
  ) {
    this.size = size;
    const t = field.trailhead;
    const s = field.summit;
    // 山体と、登山開始地点・山頂が必ず入る範囲
    const need = Math.max(
      profile.radius * 2.1,
      Math.abs(t.x) * 2.3,
      Math.abs(t.z) * 2.3,
      Math.abs(s.x) * 2.3,
      Math.abs(s.z) * 2.3,
    );
    this.extent = Math.min(field.size, need);
    this.centerX = 0;
    this.centerZ = 0;
    const iv = intervals(profile.peakHeight);
    this.minor = iv.minor;
    this.index = iv.index;

    this.canvas = document.createElement('canvas');
    this.canvas.width = size;
    this.canvas.height = size;
    this.draw();
  }

  /** ワールド座標 → 地図のピクセル */
  toMap(x: number, z: number, out: MapPoint = { x: 0, y: 0 }): MapPoint {
    const k = this.size / this.extent;
    out.x = (x - (this.centerX - this.extent / 2)) * k;
    out.y = (z - (this.centerZ - this.extent / 2)) * k;
    return out;
  }

  /** 地図の正規化座標 (0..1) → ワールド座標 */
  toWorld(u: number, v: number): { x: number; z: number } {
    return {
      x: this.centerX - this.extent / 2 + u * this.extent,
      z: this.centerZ - this.extent / 2 + v * this.extent,
    };
  }

  /** 1px あたりの実距離 (m) */
  get metresPerPixel(): number {
    return this.extent / this.size;
  }

  // --- 描画 ---------------------------------------------------------------

  private draw(): void {
    // 標高は一度だけ拾って使い回す。
    // 等高線は本数ぶん走査するので、そのたびに拾うと桁違いに遅くなる
    this.sampleGrid();
    const ctx = this.canvas.getContext('2d')!;
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, this.size, this.size);
    this.drawRelief(ctx);
    this.drawCliffs(ctx);
    this.drawContours(ctx);
    this.drawMarkers(ctx);
    this.drawFrame(ctx);
  }

  /** 地図の解像度で標高を拾っておく。範囲外は -1 */
  private sampleGrid(): void {
    this.stride = Math.max(1.5, this.extent / 460);
    this.sn = Math.ceil(this.extent / this.stride) + 1;
    this.sample = new Float32Array(this.sn * this.sn);
    const x0 = this.centerX - this.extent / 2;
    const z0 = this.centerZ - this.extent / 2;
    const f = this.field;
    for (let j = 0; j < this.sn; j++) {
      const z = z0 + j * this.stride;
      for (let i = 0; i < this.sn; i++) {
        const x = x0 + i * this.stride;
        this.sample[j * this.sn + i] = f.inside(x, z) ? f.heightAt(x, z) : -1;
      }
    }
  }

  /** 拾っておいた標高 (格子の外は -1) */
  private at(i: number, j: number): number {
    if (i < 0 || j < 0 || i >= this.sn || j >= this.sn) return -1;
    return this.sample[j * this.sn + i];
  }

  /**
   * 標高による淡い段彩。等高線だけだと高い側がどちらか読みにくい。
   * 格子の解像度で一枚作って引き伸ばす (小さな矩形を何万回も塗るより速い)。
   */
  private drawRelief(ctx: CanvasRenderingContext2D): void {
    const n = this.sn;
    const tile = document.createElement('canvas');
    tile.width = n;
    tile.height = n;
    const tctx = tile.getContext('2d')!;
    const img = tctx.createImageData(n, n);
    const peak = Math.max(1, this.profile.peakHeight);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = (j * n + i) * 4;
        const h = this.sample[j * n + i];
        if (h < 0) {
          img.data[k + 3] = 0;
          continue;
        }
        const t = Math.min(1, Math.max(0, h / peak));
        // 低い = 緑がかった白、高い = 茶がかった白
        img.data[k] = 233 + t * 14;
        img.data[k + 1] = 233 - t * 14;
        img.data[k + 2] = 216 - t * 26;
        img.data[k + 3] = 255;
      }
    }
    tctx.putImageData(img, 0, 0);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(tile, 0, 0, this.size, this.size);
    ctx.restore();
    tile.width = 0;
    tile.height = 0;
  }

  /**
   * 崖。地図の縮尺で意味のある大きさのものだけ出す。
   *
   * 判定はゲームと同じ「立てない斜度」だが、**8m のブロック単位で測る**。
   * 1m の格子でそのまま測ると段差のたびに反応して山が真っ黒になる。
   * 崖バンドの適用強度 (cliffMask) は平地でも 0 にならないので使わない。
   *
   * 記号は下り方向へ伸ばす短い線 (ケバ)。
   * どちら側が落ちているかが読めるようにしておく。
   */
  private drawCliffs(ctx: CanvasRenderingContext2D): void {
    const block = 8; // m
    const b = Math.max(2, Math.round(block / this.stride)); // 格子いくつぶんか
    const n = Math.max(1, Math.floor((this.sn - 1) / b));
    const steep = new Uint8Array(n * n);
    const dir = new Float32Array(n * n * 2);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        let hi = -Infinity;
        let lo = Infinity;
        let outside = false;
        for (let dj = 0; dj <= b; dj++) {
          for (let di = 0; di <= b; di++) {
            const h = this.at(i * b + di, j * b + dj);
            if (h < 0) {
              outside = true;
              break;
            }
            if (h > hi) hi = h;
            if (h < lo) lo = h;
          }
          if (outside) break;
        }
        if (outside) continue;
        if (Math.atan((hi - lo) / block) <= MOVE.maxStandSlope) continue;
        steep[j * n + i] = 1;
        // 下り方向 (ケバを伸ばす向き)
        const ci = i * b + (b >> 1);
        const cj = j * b + (b >> 1);
        const gx = this.at(ci + 1, cj) - this.at(ci - 1, cj);
        const gz = this.at(ci, cj + 1) - this.at(ci, cj - 1);
        const len = Math.hypot(gx, gz) || 1;
        dir[(j * n + i) * 2] = -gx / len;
        dir[(j * n + i) * 2 + 1] = -gz / len;
      }
    }

    // 孤立した1マスは落とす。地図に出すのはまとまった崖だけ
    const px = this.size / n;
    ctx.save();
    ctx.strokeStyle = 'rgba(80,62,48,0.9)';
    ctx.lineWidth = Math.max(1.2, this.size / 800);
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let j = 1; j < n - 1; j++) {
      for (let i = 1; i < n - 1; i++) {
        if (!steep[j * n + i]) continue;
        let neigh = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            neigh += steep[(j + dy) * n + (i + dx)];
          }
        }
        if (neigh < 2) continue;
        const cx = (i + 0.5) * px;
        const cy = (j + 0.5) * px;
        const dx = dir[(j * n + i) * 2];
        const dz = dir[(j * n + i) * 2 + 1];
        ctx.moveTo(cx - dx * px * 0.42, cy - dz * px * 0.42);
        ctx.lineTo(cx + dx * px * 0.42, cy + dz * px * 0.42);
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  /** マーチングスクエアで等高線を拾う */
  private levelSegments(level: number): Segment[] {
    const out: Segment[] = [];
    const n = this.sn - 1;
    const k = this.size / n;

    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const h00 = this.sample[j * this.sn + i];
        const h10 = this.sample[j * this.sn + i + 1];
        const h01 = this.sample[(j + 1) * this.sn + i];
        const h11 = this.sample[(j + 1) * this.sn + i + 1];
        let code = 0;
        if (h00 > level) code |= 1;
        if (h10 > level) code |= 2;
        if (h11 > level) code |= 4;
        if (h01 > level) code |= 8;
        if (code === 0 || code === 15) continue;

        const x0 = i * k;
        const x1 = x0 + k;
        const y0 = j * k;
        const y1 = y0 + k;
        const lerpX = (a: number, c: number) => x0 + ((level - a) / (c - a)) * k;
        const lerpY = (a: number, c: number) => y0 + ((level - a) / (c - a)) * k;
        // 各辺の交点
        const top = { x: lerpX(h00, h10), y: y0 };
        const right = { x: x1, y: lerpY(h10, h11) };
        const bottom = { x: lerpX(h01, h11), y: y1 };
        const left = { x: x0, y: lerpY(h00, h01) };
        const push = (a: { x: number; y: number }, c: { x: number; y: number }) =>
          out.push({ x1: a.x, y1: a.y, x2: c.x, y2: c.y });

        switch (code) {
          case 1:
          case 14:
            push(left, top);
            break;
          case 2:
          case 13:
            push(top, right);
            break;
          case 3:
          case 12:
            push(left, right);
            break;
          case 4:
          case 11:
            push(right, bottom);
            break;
          case 5:
            push(left, top);
            push(right, bottom);
            break;
          case 6:
          case 9:
            push(top, bottom);
            break;
          case 7:
          case 8:
            push(left, bottom);
            break;
          case 10:
            push(top, right);
            push(left, bottom);
            break;
        }
      }
    }
    return out;
  }

  private drawContours(ctx: CanvasRenderingContext2D): void {
    const peak = this.field.summit.y;
    const scale = this.size / 1400;

    for (let level = this.minor; level < peak; level += this.minor) {
      const isIndex = Math.abs(level % this.index) < 0.001;
      const segs = this.levelSegments(level);
      if (!segs.length) continue;
      ctx.strokeStyle = isIndex ? 'rgba(122,92,62,0.95)' : 'rgba(150,120,88,0.6)';
      ctx.lineWidth = (isIndex ? 2.4 : 1.1) * scale;
      ctx.beginPath();
      for (const s of segs) {
        ctx.moveTo(s.x1, s.y1);
        ctx.lineTo(s.x2, s.y2);
      }
      ctx.stroke();
      if (isIndex) this.labelLevel(ctx, segs, level, scale);
    }
  }

  /** 主曲線に標高を入れる。線に沿わせて、下の線は消しておく */
  private labelLevel(
    ctx: CanvasRenderingContext2D,
    segs: Segment[],
    level: number,
    scale: number,
  ): void {
    const wanted = 4;
    const step = Math.max(1, Math.floor(segs.length / wanted));
    ctx.save();
    ctx.font = `600 ${Math.round(21 * scale)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const placed: MapPoint[] = [];
    for (let i = Math.floor(step / 2); i < segs.length; i += step) {
      const s = segs[i];
      const cx = (s.x1 + s.x2) / 2;
      const cy = (s.y1 + s.y2) / 2;
      // 近すぎるラベルは置かない
      if (placed.some((p) => Math.hypot(p.x - cx, p.y - cy) < 150 * scale)) continue;
      placed.push({ x: cx, y: cy });
      let a = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
      if (a > Math.PI / 2) a -= Math.PI;
      if (a < -Math.PI / 2) a += Math.PI;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(a);
      const text = `${level}`;
      const w = ctx.measureText(text).width;
      ctx.fillStyle = PAPER;
      ctx.fillRect(-w / 2 - 5 * scale, -12 * scale, w + 10 * scale, 24 * scale);
      ctx.fillStyle = 'rgba(96,70,44,1)';
      ctx.fillText(text, 0, 0);
      ctx.restore();
    }
    ctx.restore();
  }

  private drawMarkers(ctx: CanvasRenderingContext2D): void {
    const scale = this.size / 1400;
    const s = this.toMap(this.field.summit.x, this.field.summit.z);
    const t = this.toMap(this.field.trailhead.x, this.field.trailhead.z);

    // 山頂
    ctx.save();
    ctx.fillStyle = '#3b2f22';
    ctx.beginPath();
    ctx.moveTo(s.x, s.y - 17 * scale);
    ctx.lineTo(s.x + 15 * scale, s.y + 10 * scale);
    ctx.lineTo(s.x - 15 * scale, s.y + 10 * scale);
    ctx.closePath();
    ctx.fill();
    ctx.font = `700 ${Math.round(26 * scale)}px system-ui, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 5 * scale;
    ctx.strokeStyle = PAPER;
    const label = `${Math.round(this.field.summit.y)}m`;
    ctx.strokeText(label, s.x + 22 * scale, s.y);
    ctx.fillText(label, s.x + 22 * scale, s.y);

    // 登山開始地点
    ctx.beginPath();
    ctx.arc(t.x, t.y, 12 * scale, 0, Math.PI * 2);
    ctx.fillStyle = '#c8442e';
    ctx.fill();
    ctx.lineWidth = 4 * scale;
    ctx.strokeStyle = PAPER;
    ctx.stroke();
    ctx.font = `700 ${Math.round(24 * scale)}px system-ui, sans-serif`;
    ctx.lineWidth = 5 * scale;
    ctx.strokeText('登山口', t.x + 20 * scale, t.y);
    ctx.fillStyle = '#c8442e';
    ctx.fillText('登山口', t.x + 20 * scale, t.y);
    ctx.restore();
  }

  /** 方角と縮尺 */
  private drawFrame(ctx: CanvasRenderingContext2D): void {
    const scale = this.size / 1400;
    const pad = 30 * scale;

    // 方位 (右上)。北は -Z
    ctx.save();
    ctx.translate(this.size - pad - 46 * scale, pad + 52 * scale);
    ctx.fillStyle = 'rgba(239,233,220,0.85)';
    ctx.strokeStyle = 'rgba(90,70,50,0.5)';
    ctx.lineWidth = 2 * scale;
    ctx.beginPath();
    ctx.arc(0, 0, 44 * scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#3b2f22';
    ctx.beginPath();
    ctx.moveTo(0, -32 * scale);
    ctx.lineTo(11 * scale, 8 * scale);
    ctx.lineTo(0, 1 * scale);
    ctx.lineTo(-11 * scale, 8 * scale);
    ctx.closePath();
    ctx.fill();
    ctx.font = `700 ${Math.round(19 * scale)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', 0, 26 * scale);
    ctx.restore();

    // 縮尺 (左下)
    const bar = 100; // m
    const barPx = bar / this.metresPerPixel;
    const y = this.size - pad - 26 * scale;
    ctx.save();
    ctx.fillStyle = 'rgba(239,233,220,0.85)';
    ctx.fillRect(pad - 8 * scale, y - 26 * scale, barPx + 16 * scale, 50 * scale);
    ctx.strokeStyle = '#3b2f22';
    ctx.lineWidth = 3 * scale;
    ctx.beginPath();
    ctx.moveTo(pad, y - 8 * scale);
    ctx.lineTo(pad, y);
    ctx.lineTo(pad + barPx, y);
    ctx.lineTo(pad + barPx, y - 8 * scale);
    ctx.stroke();
    ctx.fillStyle = '#3b2f22';
    ctx.font = `600 ${Math.round(19 * scale)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(`${bar}m`, pad + barPx / 2, y + 4 * scale);
    ctx.restore();
  }

  dispose(): void {
    this.canvas.width = 0;
    this.canvas.height = 0;
  }
}
