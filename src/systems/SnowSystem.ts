/* ===========================================================
   積雪とラッセル。

   一定以上の積雪を歩くと自動的にラッセルになる (専用操作なし)。
   通過した場所は「踏み跡」として残り、後続はスタミナ消費が激減する。
     先頭が高コスト -> 踏み跡 -> 後続が低コスト
   =========================================================== */

import * as THREE from 'three';
import { clamp01 } from '../core/math';
import type { Heightfield } from '../mountain/Heightfield';
import type { SurfaceMap } from '../mountain/SurfaceMap';

/** これ以上の積雪でラッセル扱い */
export const RUSSELL_DEPTH = 0.18;
/** ラッセルの基準スタミナ消費 (毎秒, 深さ1m 相当) */
const RUSSELL_DRAIN = 7.5;

export interface SnowState {
  /** 実効積雪深 (踏み跡を考慮) */
  depth: number;
  /** 踏み固め度 0..1 */
  packed: number;
  /** ラッセル中か */
  russelling: boolean;
  /** 移動速度倍率 */
  speedScale: number;
  /** 毎秒のスタミナ消費 */
  drain: number;
}

export class SnowSystem {
  readonly cell: number;
  readonly n: number;
  /** 踏み固め度 0..255 */
  readonly packed: Uint8Array<ArrayBuffer>;
  readonly texture: THREE.DataTexture;

  /** 直近で変化したセル (ネット同期用) */
  private readonly dirtyCells = new Set<number>();
  private textureDirty = false;
  private readonly state: SnowState = {
    depth: 0,
    packed: 0,
    russelling: false,
    speedScale: 1,
    drain: 0,
  };

  constructor(
    private readonly field: Heightfield,
    private readonly surface: SurfaceMap,
  ) {
    this.cell = 2.5;
    this.n = Math.round(field.size / this.cell);
    this.packed = new Uint8Array(new ArrayBuffer(this.n * this.n));
    this.texture = new THREE.DataTexture(this.packed, this.n, this.n, THREE.RedFormat, THREE.UnsignedByteType);
    this.texture.needsUpdate = true;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
  }

  private index(x: number, z: number): number {
    const i = Math.floor((x + this.field.half) / this.cell);
    const j = Math.floor((z + this.field.half) / this.cell);
    if (i < 0 || j < 0 || i >= this.n || j >= this.n) return -1;
    return j * this.n + i;
  }

  packedAt(x: number, z: number): number {
    const idx = this.index(x, z);
    return idx < 0 ? 0 : this.packed[idx] / 255;
  }

  /** その場の状態をまとめて返す */
  evaluate(x: number, z: number): SnowState {
    const s = this.state;
    const raw = this.surface.snowDepthAt(x, z);
    const packed = this.packedAt(x, z);
    // 踏み跡は積雪を潰す
    const depth = raw * (1 - packed * 0.88);
    s.depth = depth;
    s.packed = packed;
    s.russelling = depth > RUSSELL_DEPTH;
    s.speedScale = 1 / (1 + Math.max(0, depth - 0.05) * 1.9);
    s.drain = s.russelling ? RUSSELL_DRAIN * Math.pow(depth, 1.35) : 0;
    return s;
  }

  /** 通過して踏み跡を付ける */
  stamp(x: number, z: number, amount = 1): void {
    const r = 1; // 隣接セルまで
    const ci = Math.floor((x + this.field.half) / this.cell);
    const cj = Math.floor((z + this.field.half) / this.cell);
    for (let j = cj - r; j <= cj + r; j++) {
      for (let i = ci - r; i <= ci + r; i++) {
        if (i < 0 || j < 0 || i >= this.n || j >= this.n) continue;
        const falloff = i === ci && j === cj ? 1 : 0.45;
        const idx = j * this.n + i;
        const next = Math.min(255, this.packed[idx] + amount * 60 * falloff);
        if (next !== this.packed[idx]) {
          this.packed[idx] = next;
          this.dirtyCells.add(idx);
          this.textureDirty = true;
        }
      }
    }
  }

  /** 他プレイヤーの踏み跡を反映する */
  applyRemote(cells: ArrayLike<number>): void {
    for (let k = 0; k + 1 < cells.length; k += 2) {
      const idx = cells[k];
      const v = cells[k + 1];
      if (idx < 0 || idx >= this.packed.length) continue;
      if (v > this.packed[idx]) {
        this.packed[idx] = v;
        this.textureDirty = true;
      }
    }
  }

  /** 自分が付けた踏み跡の差分を取り出す (送信後にクリアされる) */
  takeDelta(): number[] {
    if (this.dirtyCells.size === 0) return [];
    const out: number[] = [];
    for (const idx of this.dirtyCells) {
      out.push(idx, this.packed[idx]);
    }
    this.dirtyCells.clear();
    return out;
  }

  /** 全体スナップショット (参加時の同期用) */
  snapshot(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.packed.length; i++) {
      if (this.packed[i] > 0) out.push(i, this.packed[i]);
    }
    return out;
  }

  update(): void {
    if (this.textureDirty) {
      this.texture.needsUpdate = true;
      this.textureDirty = false;
    }
  }

  /** 踏み固め度から見た「開拓済み率」(デバッグ表示用) */
  get trailCoverage(): number {
    let c = 0;
    for (let i = 0; i < this.packed.length; i++) if (this.packed[i] > 40) c++;
    return clamp01(c / this.packed.length);
  }
}
