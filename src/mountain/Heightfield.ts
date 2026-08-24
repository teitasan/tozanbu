/* ===========================================================
   Seed から決定論的に生成される山のハイトフィールド。

   基本形状:
     山体 (円錐) + 尾根 (リッジノイズ) - 谷 (fBm) + 麓の起伏
   そのあとに「崖バンド」を適用して、
   標高帯ごとに垂直に近い岩壁とその上のテラスを作る。
   崖バンドの強さは場所によって変わるので、
   同じバンドでも「歩いて抜けられる弱点」と「登るしかない壁」ができる。
   =========================================================== */

import { clamp, clamp01, lerp, smoothstep } from '../core/math';
import { fbm, makeNoise2D, ridgedFbm, type Noise2D } from '../core/rng';
import type { DifficultyProfile } from './difficulty';

export interface Vec2 {
  x: number;
  z: number;
}

const WORLD_SIZE = 800;
const GRID_STEP = 2.0;

export class Heightfield {
  /** ワールドの一辺 (m)。原点が中心 */
  readonly size = WORLD_SIZE;
  readonly half = WORLD_SIZE / 2;
  readonly step = GRID_STEP;
  /** 1辺のサンプル数 */
  readonly n: number;

  /** 標高 (m) */
  readonly height: Float32Array;
  /** 崖バンドの適用強度 0..1 (地表分類と岩壁探索に使う) */
  readonly cliffMask: Float32Array;

  readonly summit = { x: 0, y: 0, z: 0 };
  readonly trailhead = { x: 0, y: 0, z: 0 };

  constructor(
    readonly seed: number,
    readonly profile: DifficultyProfile,
  ) {
    this.n = Math.round(WORLD_SIZE / GRID_STEP) + 1;
    this.height = new Float32Array(this.n * this.n);
    this.cliffMask = new Float32Array(this.n * this.n);
    this.generate();
    this.findSummit();
    this.findTrailhead();
  }

  // --- 生成 ---------------------------------------------------------------

  private generate(): void {
    const p = this.profile;
    const nRidge = makeNoise2D(this.seed + 11);
    const nValley = makeNoise2D(this.seed + 23);
    const nWarp = makeNoise2D(this.seed + 37);
    const nDetail = makeNoise2D(this.seed + 53);
    const nCliff = makeNoise2D(this.seed + 71);
    const nBand = makeNoise2D(this.seed + 89);

    const { n, step, half } = this;
    for (let j = 0; j < n; j++) {
      const z = -half + j * step;
      for (let i = 0; i < n; i++) {
        const x = -half + i * step;
        const idx = j * n + i;
        const smooth = this.smoothHeight(x, z, p, nRidge, nValley, nWarp, nDetail);
        const { h, cliff } = this.applyCliffBands(smooth, x, z, p, nCliff, nBand);
        this.height[idx] = h;
        this.cliffMask[idx] = cliff;
      }
    }
  }

  private smoothHeight(
    x: number,
    z: number,
    p: DifficultyProfile,
    nRidge: Noise2D,
    nValley: Noise2D,
    nWarp: Noise2D,
    nDetail: Noise2D,
  ): number {
    const dist = Math.hypot(x, z);
    const r = dist / p.radius;

    // ドメインワープで円錐っぽさを崩す
    const wx = x + nWarp(x * 0.0035, z * 0.0035) * 55;
    const wz = z + nWarp(x * 0.0035 + 11.3, z * 0.0035 - 7.1) * 55;

    // 山体。歩ける斜度に収まるよう、ほぼ直線的な円錐にする
    let h = p.peakHeight * Math.pow(clamp01(1 - r), 1.12);

    // 尾根と谷は中腹で最も強く、山頂と山麓では弱める
    const flank = smoothstep(0.03, 0.28, r) * smoothstep(1.15, 0.5, r);
    h += (ridgedFbm(nRidge, wx * 0.0075, wz * 0.0075, 5) - 0.42) * p.ridgeAmp * flank * 2;
    h -= Math.max(0, fbm(nValley, wx * 0.0052, wz * 0.0052, 4)) * p.valleyAmp * flank * 1.6;

    // 麓の起伏と細かいディテール
    h += fbm(nDetail, x * 0.0042, z * 0.0042, 4) * 13 * smoothstep(0.25, 1.0, r);
    h += fbm(nDetail, x * 0.031, z * 0.031, 3) * 1.5;

    return Math.max(0, h);
  }

  /**
   * 崖バンド。標高を段状にリマップして、
   * 「垂直に近い壁 + その上のテラス」を作る。
   * frac が小さいほど壁が立つ。frac は場所によって変わるので弱点ができる。
   */
  private applyCliffBands(
    h: number,
    x: number,
    z: number,
    p: DifficultyProfile,
    nCliff: Noise2D,
    nBand: Noise2D,
  ): { h: number; cliff: number } {
    if (p.cliffiness <= 0.001) return { h, cliff: 0 };

    // 段化するかどうかを閾値で決める。0/1 に寄せるので
    // 「素の斜面」か「テラス+壁」かのどちらかになり、
    // 中途半端な (歩けないが壁でもない) 斜面ができない。
    //
    // ノイズを標高でもずらすのが要点。(x,z) だけで決めると、
    // 段化しないセクターが山麓から山頂まで一直線のスロープになり、
    // そこを歩くだけで登れてしまう。標高でずらすと弱点の位置が
    // バンドごとに変わるので、横に回り込むか登るかの判断が要る。
    const field = clamp01(fbm(nCliff, x * 0.02 + h * 0.05, z * 0.02 - h * 0.038, 3) * 0.75 + 0.5);
    const alt = clamp01(h / p.peakHeight);
    const threshold = p.cliffiness * (0.72 + alt * 0.42);
    const strength = smoothstep(-0.1, 0.1, threshold - field);
    if (strength <= 0.02) return { h, cliff: 0 };

    const frac = clamp(p.cliffFracBase + nBand(x * 0.006, z * 0.006) * p.cliffFracVar, 0.05, 0.95);
    const b = h / p.bandHeight + nBand(x * 0.011 + 31.7, z * 0.011 - 12.4) * 0.5;
    const i = Math.floor(b);
    const f = b - i;
    const terraced = (i + smoothstep(0, frac, f)) * p.bandHeight;
    // 壁の途中 (f < frac) ほど「崖らしさ」が高い
    const wallness = 1 - smoothstep(frac * 0.75, frac * 1.5, f);
    return { h: lerp(h, terraced, strength), cliff: strength * wallness };
  }

  private findSummit(): void {
    let best = -Infinity;
    let bi = 0;
    for (let i = 0; i < this.height.length; i++) {
      if (this.height[i] > best) {
        best = this.height[i];
        bi = i;
      }
    }
    const j = Math.floor(bi / this.n);
    const i = bi - j * this.n;
    this.summit.x = -this.half + i * this.step;
    this.summit.z = -this.half + j * this.step;
    this.summit.y = best;
  }

  /** 登山口。山体の外周でいちばん標高が低い (＝谷の出口) 方角を選ぶ */
  private findTrailhead(): void {
    const r = this.profile.radius * 0.98;
    let best = Infinity;
    let bx = r;
    let bz = 0;
    for (let k = 0; k < 128; k++) {
      const a = (k / 128) * Math.PI * 2;
      const x = this.summit.x + Math.cos(a) * r;
      const z = this.summit.z + Math.sin(a) * r;
      if (Math.abs(x) > this.half - 20 || Math.abs(z) > this.half - 20) continue;
      const h = this.heightAt(x, z) + this.slopeAt(x, z) * 40;
      if (h < best) {
        best = h;
        bx = x;
        bz = z;
      }
    }
    this.trailhead.x = bx;
    this.trailhead.z = bz;
    this.trailhead.y = this.heightAt(bx, bz);
  }

  // --- 問い合わせ ---------------------------------------------------------

  inside(x: number, z: number): boolean {
    return Math.abs(x) < this.half - this.step && Math.abs(z) < this.half - this.step;
  }

  gridHeight(i: number, j: number): number {
    const ii = clamp(i, 0, this.n - 1) | 0;
    const jj = clamp(j, 0, this.n - 1) | 0;
    return this.height[jj * this.n + ii];
  }

  gridCliff(i: number, j: number): number {
    const ii = clamp(i, 0, this.n - 1) | 0;
    const jj = clamp(j, 0, this.n - 1) | 0;
    return this.cliffMask[jj * this.n + ii];
  }

  /** バイリニア補間した標高 */
  heightAt(x: number, z: number): number {
    const fx = (x + this.half) / this.step;
    const fz = (z + this.half) / this.step;
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    const h00 = this.gridHeight(i, j);
    const h10 = this.gridHeight(i + 1, j);
    const h01 = this.gridHeight(i, j + 1);
    const h11 = this.gridHeight(i + 1, j + 1);
    return lerp(lerp(h00, h10, tx), lerp(h01, h11, tx), tz);
  }

  cliffAt(x: number, z: number): number {
    const fx = (x + this.half) / this.step;
    const fz = (z + this.half) / this.step;
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    return lerp(
      lerp(this.gridCliff(i, j), this.gridCliff(i + 1, j), tx),
      lerp(this.gridCliff(i, j + 1), this.gridCliff(i + 1, j + 1), tx),
      tz,
    );
  }

  /** 勾配 (dh/dx, dh/dz) */
  gradientAt(x: number, z: number, out: { gx: number; gz: number } = { gx: 0, gz: 0 }) {
    const d = this.step;
    out.gx = (this.heightAt(x + d, z) - this.heightAt(x - d, z)) / (2 * d);
    out.gz = (this.heightAt(x, z + d) - this.heightAt(x, z - d)) / (2 * d);
    return out;
  }

  /** 斜度 (ラジアン) */
  slopeAt(x: number, z: number): number {
    const g = this.gradientAt(x, z);
    return Math.atan(Math.hypot(g.gx, g.gz));
  }

  /** 法線 (正規化済み) */
  normalAt(x: number, z: number, out: { x: number; y: number; z: number } = { x: 0, y: 1, z: 0 }) {
    const g = this.gradientAt(x, z);
    const len = Math.hypot(g.gx, 1, g.gz);
    out.x = -g.gx / len;
    out.y = 1 / len;
    out.z = -g.gz / len;
    return out;
  }

  /** 標高に対する相対的な高さ 0..1 (山頂で 1) */
  altitudeRatio(y: number): number {
    return clamp01(y / Math.max(1, this.summit.y));
  }
}

export { WORLD_SIZE, GRID_STEP };
