/* ===========================================================
   Seed から決定論的に生成される山のハイトフィールド。

   1) MountainSkeleton で主峰・副峰・稜線・谷の骨格を作る
   2) 肉付け (fBm)・侵食・局所崖・表面ノイズを載せる
   3) 必要なら崖バンドで垂直に近い壁とテラスを作る

   水平スケール:
     WORLD_SIZE = 2000m (従来 800m)
     GRID_STEP  = 2m    (従来 1m。セル数は 1001² ≒ 旧 801² と同程度)
     COARSE     = 4     (骨格・緩成分は 8m 刻みで評価し 3次補間)
   =========================================================== */

import { clamp, clamp01, lerp, smoothstep } from '../core/math';
import { fbm, makeNoise2D, ridgedFbm, type Noise2D } from '../core/rng';
import type { DifficultyProfile } from './difficulty';
import {
  approximateTrailhead,
  buildMountainSkeleton,
  forelandContinuousAt,
  forelandSkeletonAt,
  skeletonHeightAt,
  type MountainSkeleton,
} from './MountainSkeleton';

export interface Vec2 {
  x: number;
  z: number;
}

/**
 * ワールド一辺 (m)。800m 級より広く、尾根・谷・副峰を読めるスケール。
 * 1m グリッドのまま 4 倍にすると 1600 万セルになり重いので 2m 刻みにしている。
 */
const WORLD_SIZE = 2000;
/** 標高・当たり判定の格子間隔 (m) */
const GRID_STEP = 2.0;
/** 骨格・緩成分の粗い評価間隔 (格子数)。実距離 = COARSE × GRID_STEP = 8m */
const COARSE = 4;

/**
 * 前山・外周帯が本体山体から切り替わる内側半径 (山体 radius に対する比率)。
 * 主峰付近の岩壁・稜線難易度を薄めないため、内側では foreland を載せない。
 */
const FORELAND_INNER = 0.48;
/** 前山がフルに効くまでの外側半径 (比率) */
const FORELAND_OUTER = 0.66;
/** ワールド端で標高を落とすフェード幅 (m) */
const FORELAND_EDGE_FADE = 130;
/** 線状骨格の最大標高 (peakHeight に対する比率) */
const FORELAND_PEAK_REL = 0.18;
/** 登山口周辺の安全低地半径 (m) */
const TRAILHEAD_SAFE_INNER = 30;
const TRAILHEAD_SAFE_OUTER = 62;

function at(a: Float32Array, cn: number, i: number, j: number): number {
  const ci = i < 0 ? 0 : i > cn - 1 ? cn - 1 : i;
  const cj = j < 0 ? 0 : j > cn - 1 ? cn - 1 : j;
  return a[cj * cn + ci];
}

function sampleLinear(
  a: Float32Array,
  cn: number,
  ci: number,
  cj: number,
  tx: number,
  ty: number,
): number {
  const a0 = at(a, cn, ci, cj) * (1 - tx) + at(a, cn, ci + 1, cj) * tx;
  const a1 = at(a, cn, ci, cj + 1) * (1 - tx) + at(a, cn, ci + 1, cj + 1) * tx;
  return a0 * (1 - ty) + a1 * ty;
}

function cubic(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const a = 2 * p1;
  const b = p2 - p0;
  const c = 2 * p0 - 5 * p1 + 4 * p2 - p3;
  const d = -p0 + 3 * p1 - 3 * p2 + p3;
  return 0.5 * (a + b * t + c * t * t + d * t * t * t);
}

function sampleCubic(
  a: Float32Array,
  cn: number,
  ci: number,
  cj: number,
  tx: number,
  ty: number,
): number {
  const r0 = cubic(at(a, cn, ci - 1, cj - 1), at(a, cn, ci, cj - 1), at(a, cn, ci + 1, cj - 1), at(a, cn, ci + 2, cj - 1), tx);
  const r1 = cubic(at(a, cn, ci - 1, cj), at(a, cn, ci, cj), at(a, cn, ci + 1, cj), at(a, cn, ci + 2, cj), tx);
  const r2 = cubic(at(a, cn, ci - 1, cj + 1), at(a, cn, ci, cj + 1), at(a, cn, ci + 1, cj + 1), at(a, cn, ci + 2, cj + 1), tx);
  const r3 = cubic(at(a, cn, ci - 1, cj + 2), at(a, cn, ci, cj + 2), at(a, cn, ci + 1, cj + 2), at(a, cn, ci + 2, cj + 2), tx);
  return cubic(r0, r1, r2, r3, ty);
}

export class Heightfield {
  readonly size = WORLD_SIZE;
  readonly half = WORLD_SIZE / 2;
  readonly step = GRID_STEP;
  readonly n: number;
  readonly skeleton: MountainSkeleton;

  readonly height: Float32Array;
  readonly cliffMask: Float32Array;

  readonly summit = { x: 0, y: 0, z: 0 };
  readonly trailhead = { x: 0, y: 0, z: 0 };
  /** 主峰以外の顕著な峰 (地図表示用) */
  readonly secondaryPeaks: { x: number; y: number; z: number }[] = [];

  constructor(
    readonly seed: number,
    readonly profile: DifficultyProfile,
  ) {
    this.n = Math.round(WORLD_SIZE / GRID_STEP) + 1;
    this.height = new Float32Array(this.n * this.n);
    this.cliffMask = new Float32Array(this.n * this.n);
    this.skeleton = buildMountainSkeleton(seed, profile.radius);
    this.generate();
    this.findSummit();
    this.findSecondaryPeaks();
    this.findTrailhead();
  }

  private generate(): void {
    const p = this.profile;
    const sk = this.skeleton;
    const nRidge = makeNoise2D(this.seed + 11);
    const nValley = makeNoise2D(this.seed + 23);
    const nWarp = makeNoise2D(this.seed + 37);
    const nDetail = makeNoise2D(this.seed + 53);
    const nCliff = makeNoise2D(this.seed + 71);
    const nBand = makeNoise2D(this.seed + 89);
    const nErode = makeNoise2D(this.seed + 103);
    const nFore = makeNoise2D(this.seed + 127);

    const { n, step, half } = this;
    const cn = Math.ceil((n - 1) / COARSE) + 3;
    const cAt = (ci: number) => -half + (ci - 1) * COARSE * step;

    const smoothC = new Float32Array(cn * cn);
    const fieldC = new Float32Array(cn * cn);
    const fracC = new Float32Array(cn * cn);
    const bandC = new Float32Array(cn * cn);
    const cliffy = p.cliffiness > 0.001;

    for (let cj = 0; cj < cn; cj++) {
      const z = cAt(cj);
      for (let ci = 0; ci < cn; ci++) {
        const x = cAt(ci);
        const k = cj * cn + ci;
        const sm = this.smoothHeight(x, z, p, sk, nRidge, nValley, nWarp, nDetail, nErode, nFore);
        smoothC[k] = sm;
        if (!cliffy) continue;
        fieldC[k] = clamp01(fbm(nCliff, x * 0.012 + sm * 0.04, z * 0.012 - sm * 0.032, 3) * 0.75 + 0.5);
        fracC[k] = clamp(p.cliffFracBase + nBand(x * 0.004, z * 0.004) * p.cliffFracVar, 0.05, 0.95);
        bandC[k] = nBand(x * 0.007 + 31.7, z * 0.007 - 12.4) * 0.5;
      }
    }

    for (let j = 0; j < n; j++) {
      const fy = j / COARSE + 1;
      const cj = Math.floor(fy);
      const ty = fy - cj;
      for (let i = 0; i < n; i++) {
        const fx = i / COARSE + 1;
        const ci = Math.floor(fx);
        const tx = fx - ci;
        const idx = j * n + i;
        const smooth = sampleCubic(smoothC, cn, ci, cj, tx, ty);
        if (!cliffy) {
          this.height[idx] = Math.max(0, smooth);
          continue;
        }
        const field = sampleLinear(fieldC, cn, ci, cj, tx, ty);
        const frac = sampleLinear(fracC, cn, ci, cj, tx, ty);
        const bandOff = sampleLinear(bandC, cn, ci, cj, tx, ty);
        const r = this.applyCliffBands(Math.max(0, smooth), p, field, frac, bandOff);
        this.height[idx] = r.h;
        this.cliffMask[idx] = r.cliff;
      }
    }
  }

  private smoothHeight(
    x: number,
    z: number,
    p: DifficultyProfile,
    sk: MountainSkeleton,
    nRidge: Noise2D,
    nValley: Noise2D,
    nWarp: Noise2D,
    nDetail: Noise2D,
    nErode: Noise2D,
    nFore: Noise2D,
  ): number {
    const wx = x + nWarp(x * 0.0022, z * 0.0022) * 85;
    const wz = z + nWarp(x * 0.0022 + 11.3, z * 0.0022 - 7.1) * 85;

    const rawSk = skeletonHeightAt(wx, wz, sk, p.radius);
    let h = rawSk * p.peakHeight;

    const distMain = Math.hypot(x - sk.peaks[0].x, z - sk.peaks[0].z);
    const flank = smoothstep(p.radius * 0.08, p.radius * 0.35, distMain) *
      smoothstep(p.radius * 1.15, p.radius * 0.55, distMain);

    h += (ridgedFbm(nRidge, wx * 0.0048, wz * 0.0048, 4) - 0.42) * p.ridgeAmp * flank * 1.8;
    h -= Math.max(0, fbm(nValley, wx * 0.0035, wz * 0.0035, 4)) * p.valleyAmp * flank * 1.4;

    const erode = fbm(nErode, x * 0.003, z * 0.003, 3);
    h -= Math.max(0, erode) * 6 * smoothstep(0.15, 0.85, rawSk);

    // --- 前山・外周帯 (foothill / foreland) ---
    // 線状骨格だけでは広い平地に見えるため、低周波の連続起伏面を主体にする。
    const distCenter = Math.hypot(x, z);
    const worldEdge = this.half - 22;
    let foreW =
      smoothstep(p.radius * FORELAND_INNER, p.radius * FORELAND_OUTER, distCenter) *
      (1 - smoothstep(worldEdge - FORELAND_EDGE_FADE, worldEdge - 6, distCenter));
    foreW *= 1 - smoothstep(0.1, 0.34, rawSk);

    if (foreW > 0.001) {
      const rawSkelFore = forelandSkeletonAt(wx, wz, sk, p.radius);
      let foreH = rawSkelFore * p.peakHeight * FORELAND_PEAK_REL;
      foreH += forelandContinuousAt(x, z, sk, p.radius, nFore, nRidge, nValley, nWarp);

      const trail = approximateTrailhead(sk, p.radius);
      const distFromTrail = Math.hypot(x - trail.x, z - trail.z);
      const trailSafe = 1 - smoothstep(TRAILHEAD_SAFE_INNER, TRAILHEAD_SAFE_OUTER, distFromTrail);
      foreH *= 1 - trailSafe * 0.82;

      const edgeDrop = smoothstep(worldEdge - 190, worldEdge - 10, distCenter);
      foreH *= 1 - edgeDrop * 0.48;
      foreH -= edgeDrop * 4.2;

      h += foreH * foreW;
    }

    const edge = Math.hypot(x, z) / p.radius;
    h += fbm(nDetail, x * 0.0028, z * 0.0028, 4) * 5 * smoothstep(0.55, 1.08, edge);
    h += fbm(nDetail, x * 0.022, z * 0.022, 3) * 1.8;

    return Math.max(0, h);
  }

  private applyCliffBands(
    h: number,
    p: DifficultyProfile,
    field: number,
    frac: number,
    bandOff: number,
  ): { h: number; cliff: number } {
    const alt = clamp01(h / p.peakHeight);
    const threshold = p.cliffiness * (0.68 + alt * 0.45);
    const strength = smoothstep(-0.1, 0.1, threshold - field);
    if (strength <= 0.02) return { h, cliff: 0 };

    const b = h / p.bandHeight + bandOff;
    const i = Math.floor(b);
    const f = b - i;
    const terraced = (i + smoothstep(0, frac, f)) * p.bandHeight;
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

  private findSecondaryPeaks(): void {
    this.secondaryPeaks.length = 0;
    const main = this.skeleton.peaks[0];
    const minSep = this.profile.radius * 0.12;
    // 副峰は主峰の半分程度でも、鞍部を挟んだ別の目標として地図に載せる。
    const minH = this.summit.y * 0.48;

    for (let pi = 1; pi < this.skeleton.peaks.length; pi++) {
      const sp = this.skeleton.peaks[pi];
      let best = -Infinity;
      let bx = sp.x;
      let bz = sp.z;
      const r = this.profile.radius * 0.14;
      for (let dz = -r; dz <= r; dz += this.step * 2) {
        for (let dx = -r; dx <= r; dx += this.step * 2) {
          const x = sp.x + dx;
          const z = sp.z + dz;
          if (!this.inside(x, z)) continue;
          const h = this.heightAt(x, z);
          if (h > best) {
            best = h;
            bx = x;
            bz = z;
          }
        }
      }
      if (best < minH) continue;
      if (Math.hypot(bx - main.x, bz - main.z) < minSep) continue;
      if (Math.hypot(bx - this.summit.x, bz - this.summit.z) < minSep) continue;
      if (this.secondaryPeaks.some((p) => Math.hypot(p.x - bx, p.z - bz) < minSep)) continue;
      this.secondaryPeaks.push({ x: bx, y: best, z: bz });
    }
  }

  private findTrailhead(): void {
    const r = this.profile.radius * 0.96;
    const prefer = this.skeleton.approachAngle;
    let best = Infinity;
    let bx = Math.cos(prefer) * r;
    let bz = Math.sin(prefer) * r;

    for (let k = 0; k < 160; k++) {
      const a = (k / 160) * Math.PI * 2;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (Math.abs(x) > this.half - 30 || Math.abs(z) > this.half - 30) continue;
      const h = this.heightAt(x, z);
      const slope = this.slopeAt(x, z);
      let angDiff = Math.abs(Math.atan2(Math.sin(a - prefer), Math.cos(a - prefer)));
      if (angDiff > Math.PI) angDiff = Math.PI * 2 - angDiff;
      const approachBias = angDiff / Math.PI;
      const score = h + slope * 35 + approachBias * 18;
      if (score < best) {
        best = score;
        bx = x;
        bz = z;
      }
    }
    this.trailhead.x = bx;
    this.trailhead.z = bz;
    this.trailhead.y = this.heightAt(bx, bz);
  }

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

  gradientAt(x: number, z: number, out: { gx: number; gz: number } = { gx: 0, gz: 0 }) {
    const d = this.step;
    out.gx = (this.heightAt(x + d, z) - this.heightAt(x - d, z)) / (2 * d);
    out.gz = (this.heightAt(x, z + d) - this.heightAt(x, z - d)) / (2 * d);
    return out;
  }

  slopeAt(x: number, z: number): number {
    const g = this.gradientAt(x, z);
    return Math.atan(Math.hypot(g.gx, g.gz));
  }

  normalAt(x: number, z: number, out: { x: number; y: number; z: number } = { x: 0, y: 1, z: 0 }) {
    const g = this.gradientAt(x, z);
    const len = Math.hypot(g.gx, 1, g.gz);
    out.x = -g.gx / len;
    out.y = 1 / len;
    out.z = -g.gz / len;
    return out;
  }

  altitudeRatio(y: number): number {
    return clamp01(y / Math.max(1, this.summit.y));
  }
}

export { WORLD_SIZE, GRID_STEP, COARSE };
