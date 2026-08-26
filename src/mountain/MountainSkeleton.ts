/* ===========================================================
   山の骨格。seed から決定論的に主峰・副峰・稜線・谷を作る。

   円錐や逆さ鉢ではなく、稜線ネットワークと峰の配置から標高の骨格を決める。
   そのあと Heightfield が肉付け・侵食・崖・表面ノイズを載せる。
   =========================================================== */

import { clamp, clamp01, smoothstep } from '../core/math';
import { fbm, makeRng, ridgedFbm, type Noise2D } from '../core/rng';

export interface SkeletonPeak {
  x: number;
  z: number;
  /** 主峰に対する相対標高 0..1 */
  rel: number;
  main: boolean;
}

export interface SkeletonRidge {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** 稜線の強さ 0..1 */
  amp: number;
  /** 主稜線 (地図に載せる) */
  main: boolean;
}

export interface SkeletonValley {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** 谷の深さ 0..1 (正規化前) */
  depth: number;
}

export interface SkeletonSaddle {
  x: number;
  z: number;
  /** 鞍部を刻む深さ 0..1 */
  depth: number;
}

/** 前山・外周帯の低い支尾根。山体の外側を歩ける起伏にする */
export interface SkeletonFoothillRidge {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** 支尾根の強さ 0..1 */
  amp: number;
}

/** 前山・外周帯の浅い谷。トラバースと巻き道の差を出す */
export interface SkeletonFoothillValley {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** 谷の深さ 0..1 (正規化前) */
  depth: number;
}

export interface MountainSkeleton {
  peaks: SkeletonPeak[];
  ridges: SkeletonRidge[];
  valleys: SkeletonValley[];
  saddles: SkeletonSaddle[];
  /** 前山の低い支尾根 (2km 四方の余白を地形として使う) */
  foothillRidges: SkeletonFoothillRidge[];
  /** 前山の浅い谷 */
  foothillValleys: SkeletonFoothillValley[];
  /** 登山アプローチの方角 (rad)。登山口探索のバイアスに使う */
  approachAngle: number;
}

/** 点から線分までの距離と沿線位置 t∈[0,1] */
export function distToSegment(
  px: number,
  pz: number,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
): { dist: number; t: number } {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const len2 = dx * dx + dz * dz;
  if (len2 < 1e-6) return { dist: Math.hypot(px - x0, pz - z0), t: 0 };
  let t = ((px - x0) * dx + (pz - z0) * dz) / len2;
  t = clamp(t, 0, 1);
  const qx = x0 + dx * t;
  const qz = z0 + dz * t;
  return { dist: Math.hypot(px - qx, pz - qz), t };
}

/** seed から山の骨格を組み立てる */
export function buildMountainSkeleton(seed: number, massifRadius: number): MountainSkeleton {
  const rng = makeRng(seed + 1009);

  const mainAngle = rng() * Math.PI * 2;
  const mainDist = massifRadius * (0.1 + rng() * 0.24);
  const mainX = Math.cos(mainAngle) * mainDist;
  const mainZ = Math.sin(mainAngle) * mainDist;
  const peaks: SkeletonPeak[] = [{ x: mainX, z: mainZ, rel: 1, main: true }];

  const nSub = 2 + Math.floor(rng() * 3);
  for (let i = 0; i < nSub; i++) {
    const a = mainAngle + (rng() - 0.5) * 2.4 + (i / Math.max(1, nSub)) * Math.PI * 1.7;
    const d = massifRadius * (0.32 + rng() * 0.42);
    peaks.push({
      x: mainX + Math.cos(a) * d,
      z: mainZ + Math.sin(a) * d,
      rel: 0.52 + rng() * 0.34,
      main: false,
    });
  }

  const approachAngle = mainAngle + Math.PI + (rng() - 0.5) * 0.9;
  const approachDist = massifRadius * 0.94;
  const trailX = Math.cos(approachAngle) * approachDist;
  const trailZ = Math.sin(approachAngle) * approachDist;

  const ridges: SkeletonRidge[] = [
    {
      x0: trailX,
      z0: trailZ,
      x1: mainX,
      z1: mainZ,
      amp: 0.88,
      main: true,
    },
  ];

  for (let i = 1; i < peaks.length; i++) {
    ridges.push({
      x0: peaks[i].x,
      z0: peaks[i].z,
      x1: mainX,
      z1: mainZ,
      amp: 0.5 + rng() * 0.28,
      main: i <= 2,
    });
  }

  for (let i = 1; i < peaks.length - 1; i++) {
    if (rng() < 0.65) {
      ridges.push({
        x0: peaks[i].x,
        z0: peaks[i].z,
        x1: peaks[i + 1].x,
        z1: peaks[i + 1].z,
        amp: 0.32 + rng() * 0.22,
        main: false,
      });
    }
  }

  const nSpurs = 1 + Math.floor(rng() * 2);
  for (let s = 0; s < nSpurs; s++) {
    const ri = Math.floor(rng() * ridges.length);
    const r = ridges[ri];
    const mx = (r.x0 + r.x1) * 0.5;
    const mz = (r.z0 + r.z1) * 0.5;
    const along = Math.atan2(r.x1 - r.x0, r.z1 - r.z0);
    const perpA = along + (rng() < 0.5 ? 1 : -1) * (0.55 + rng() * 0.55);
    const spurLen = massifRadius * (0.14 + rng() * 0.22);
    ridges.push({
      x0: mx,
      z0: mz,
      x1: mx + Math.cos(perpA) * spurLen,
      z1: mz + Math.sin(perpA) * spurLen,
      amp: 0.22 + rng() * 0.18,
      main: false,
    });
  }

  // 主峰と副峰の間は、尾根をそのまま盛るのではなく一度落ちる鞍部にする。
  // ここが「副峰を越すか、鞍部へ巻くか」という大局的な判断になる。
  const saddles: SkeletonSaddle[] = [];
  for (let i = 1; i < peaks.length; i++) {
    const a = peaks[0];
    const b = peaks[i];
    const t = 0.56 + rng() * 0.1;
    saddles.push({
      x: a.x + (b.x - a.x) * t,
      z: a.z + (b.z - a.z) * t,
      depth: 0.055 + rng() * 0.045,
    });
  }
  for (let i = 1; i < peaks.length - 1; i++) {
    if (rng() >= 0.55) continue;
    const a = peaks[i];
    const b = peaks[i + 1];
    saddles.push({
      x: (a.x + b.x) * 0.5,
      z: (a.z + b.z) * 0.5,
      depth: 0.04 + rng() * 0.04,
    });
  }

  const valleys: SkeletonValley[] = [];
  for (let i = 0; i < ridges.length; i++) {
    for (let j = i + 1; j < ridges.length; j++) {
      if (rng() > 0.42) continue;
      const ri = ridges[i];
      const rj = ridges[j];
      const mx = (ri.x0 + ri.x1 + rj.x0 + rj.x1) * 0.25;
      const mz = (ri.z0 + ri.z1 + rj.z0 + rj.z1) * 0.25;
      const outA = Math.atan2(mz, mx) + (rng() - 0.5) * 0.5;
      const len = massifRadius * (0.22 + rng() * 0.32);
      valleys.push({
        x0: mx - Math.cos(outA) * len * 0.5,
        z0: mz - Math.sin(outA) * len * 0.5,
        x1: mx + Math.cos(outA) * len * 0.5,
        z1: mz + Math.sin(outA) * len * 0.5,
        depth: 0.1 + rng() * 0.16,
      });
    }
  }

  valleys.push({
    x0: trailX * 0.65,
    z0: trailZ * 0.65,
    x1: trailX,
    z1: trailZ,
    depth: 0.18 + rng() * 0.14,
  });

  // --- 前山・外周帯 ---
  // 2km 四方のうち山体半径 (~820m) より外側は、従来ほぼ標高 0 の余白だった。
  // 同心円のすり鉢に戻さず、既存稜線の延長・浅い谷・低周波起伏で
  // 「歩いて尾根を取る／谷を巻く」判断ができる前山にする。
  const foothillRidges: SkeletonFoothillRidge[] = [];
  const foothillValleys: SkeletonFoothillValley[] = [];
  const worldReach = massifRadius * 1.18;

  const extendOutward = (x0: number, z0: number, x1: number, z1: number, scale: number) => {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len;
    const uz = dz / len;
    const startX = x0 + ux * len * 0.55;
    const startZ = z0 + uz * len * 0.55;
    const extLen = massifRadius * (0.16 + rng() * 0.24) * scale;
    const bend = (rng() - 0.5) * 0.55;
    const bx = -uz * bend;
    const bz = ux * bend;
    const endX = startX + (ux + bx) * extLen;
    const endZ = startZ + (uz + bz) * extLen;
    const endDist = Math.hypot(endX, endZ);
    if (endDist > worldReach) {
      const k = worldReach / endDist;
      foothillRidges.push({
        x0: startX,
        z0: startZ,
        x1: endX * k,
        z1: endZ * k,
        amp: 0.18 + rng() * 0.22,
      });
      return;
    }
    foothillRidges.push({
      x0: startX,
      z0: startZ,
      x1: endX,
      z1: endZ,
      amp: 0.18 + rng() * 0.22,
    });
  };

  // 主稜線・支尾根の外側へ低い稜を延ばす
  for (let i = 0; i < ridges.length; i++) {
    if (i === 0 || ridges[i].main || rng() < 0.55) {
      extendOutward(ridges[i].x0, ridges[i].z0, ridges[i].x1, ridges[i].z1, ridges[i].main ? 1.15 : 0.85);
    }
  }

  // 登山口側にもう一本、尾根へ向かう緩斜面の支尾根
  {
    const perpA = approachAngle + (rng() < 0.5 ? 1 : -1) * (0.35 + rng() * 0.45);
    const spurLen = massifRadius * (0.2 + rng() * 0.18);
    foothillRidges.push({
      x0: trailX,
      z0: trailZ,
      x1: trailX + Math.cos(perpA) * spurLen,
      z1: trailZ + Math.sin(perpA) * spurLen,
      amp: 0.14 + rng() * 0.12,
    });
  }

  // 前山稜線の間に浅い谷
  for (let i = 0; i < foothillRidges.length; i++) {
    if (rng() > 0.58) continue;
    const r = foothillRidges[i];
    const mx = (r.x0 + r.x1) * 0.5;
    const mz = (r.z0 + r.z1) * 0.5;
    const along = Math.atan2(r.x1 - r.x0, r.z1 - r.z0);
    const outA = along + (rng() < 0.5 ? 1 : -1) * (0.65 + rng() * 0.55);
    const len = massifRadius * (0.14 + rng() * 0.2);
    foothillValleys.push({
      x0: mx - Math.cos(outA) * len * 0.5,
      z0: mz - Math.sin(outA) * len * 0.5,
      x1: mx + Math.cos(outA) * len * 0.5,
      z1: mz + Math.sin(outA) * len * 0.5,
      depth: 0.05 + rng() * 0.09,
    });
  }

  // 登山口手前の安全な低地 (浅い谷をもう一段)
  foothillValleys.push({
    x0: trailX * 0.82,
    z0: trailZ * 0.82,
    x1: trailX * 1.04,
    z1: trailZ * 1.04,
    depth: 0.07 + rng() * 0.06,
  });

  return { peaks, ridges, valleys, saddles, foothillRidges, foothillValleys, approachAngle };
}

/**
 * 骨格のみの標高 0..1。
 * 中心への距離だけで決まる形状にしない (峰・稜・谷が場所を決める)。
 */
export function skeletonHeightAt(x: number, z: number, sk: MountainSkeleton, massifRadius: number): number {
  let h = 0;

  const distMassif = Math.hypot(x, z) / massifRadius;
  h += 0.06 * clamp01(1 - distMassif * distMassif);

  for (const p of sk.peaks) {
    const d = Math.hypot(x - p.x, z - p.z);
    const r = p.main ? massifRadius * 0.36 : massifRadius * (0.2 + p.rel * 0.14);
    h += p.rel * Math.pow(clamp01(1 - d / r), 1.55);
  }

  for (const r of sk.ridges) {
    const { dist, t } = distToSegment(x, z, r.x0, r.z0, r.x1, r.z1);
    const along = Math.sin(t * Math.PI);
    const width = massifRadius * (0.1 + r.amp * 0.055);
    h += r.amp * 0.34 * Math.exp(-((dist / width) ** 2)) * (0.5 + along * 0.5);
  }

  for (const s of sk.saddles) {
    const d = Math.hypot(x - s.x, z - s.z);
    const width = massifRadius * 0.08;
    h -= s.depth * Math.exp(-((d / width) ** 2));
  }

  for (const v of sk.valleys) {
    const { dist, t } = distToSegment(x, z, v.x0, v.z0, v.x1, v.z1);
    const along = Math.sin(t * Math.PI);
    const width = massifRadius * 0.075;
    h -= v.depth * Math.exp(-((dist / width) ** 2)) * along;
  }

  return Math.max(0, h);
}

/** 登山口の近似位置 (Heightfield 生成中の安全低地マスク用) */
export function approximateTrailhead(sk: MountainSkeleton, massifRadius: number): { x: number; z: number } {
  return {
    x: Math.cos(sk.approachAngle) * massifRadius * 0.96,
    z: Math.sin(sk.approachAngle) * massifRadius * 0.96,
  };
}

/**
 * 前山・外周帯の骨格標高 0..1 (線状の支尾根・谷)。
 * 連続面の上に載るアクセント。単独では広い平地になりやすい。
 */
export function forelandSkeletonAt(
  x: number,
  z: number,
  sk: MountainSkeleton,
  massifRadius: number,
): number {
  let h = 0;

  for (const r of sk.foothillRidges) {
    const { dist, t } = distToSegment(x, z, r.x0, r.z0, r.x1, r.z1);
    const along = Math.sin(t * Math.PI);
    const width = massifRadius * (0.11 + r.amp * 0.045);
    h += r.amp * 0.3 * Math.exp(-((dist / width) ** 2)) * (0.42 + along * 0.58);
  }

  for (const v of sk.foothillValleys) {
    const { dist, t } = distToSegment(x, z, v.x0, v.z0, v.x1, v.z1);
    const along = Math.sin(t * Math.PI);
    const width = massifRadius * 0.085;
    h -= v.depth * Math.exp(-((dist / width) ** 2)) * along;
  }

  return Math.max(0, h);
}

/**
 * 前山・外周帯の連続標高 (m)。
 * fBm / ridged / 方向性排水で低周波の起伏面を作る。同心円のすり鉢にはしない。
 */
export function forelandContinuousAt(
  x: number,
  z: number,
  sk: MountainSkeleton,
  massifRadius: number,
  nRoll: Noise2D,
  nRidge: Noise2D,
  nValley: Noise2D,
  nWarp: Noise2D,
): number {
  const drainA = sk.approachAngle + 0.58;
  const ca = Math.cos(drainA);
  const sa = Math.sin(drainA);

  const wAmt = 105;
  const wx = x + nWarp(x * 0.00102, z * 0.00102) * wAmt;
  const wz = z + nWarp(x * 0.00102 + 13.7, z * 0.00102 - 9.2) * wAmt;

  const rx = wx * ca - wz * sa;
  const rz = wx * sa + wz * ca;

  const roll = fbm(nRoll, wx * 0.00108, wz * 0.00108, 5);
  const ridges = ridgedFbm(nRidge, wx * 0.00188, wz * 0.00188, 4);
  const drain1 = fbm(nValley, rx * 0.00148 + 3.1, rz * 0.00148 - 2.4, 4);
  const drain2 = fbm(nValley, rx * 0.00272 + 11.2, rz * 0.00272 + 6.8, 3);
  const cross = fbm(nRoll, rz * 0.00205 + 5.5, rx * 0.00205 - 1.8, 3);
  const detail = fbm(nRoll, wx * 0.0036 + 8.4, wz * 0.0036 - 4.1, 3);

  let h = 0;
  h += (roll - 0.31) * 19;
  h += (ridges - 0.38) * 12;
  h -= Math.max(0, drain1) * 8;
  h -= Math.max(0, -drain2) * 5;
  h += (cross - 0.5) * 6;
  h += (detail - 0.48) * 3.5;

  const alongApproach = x * Math.cos(sk.approachAngle) + z * Math.sin(sk.approachAngle);
  h += smoothstep(massifRadius * 0.48, massifRadius * 0.9, alongApproach) * 3.2;

  return Math.max(0, h);
}

/** @deprecated forelandSkeletonAt を使用 */
export function forelandHeightAt(
  x: number,
  z: number,
  sk: MountainSkeleton,
  massifRadius: number,
): number {
  return forelandSkeletonAt(x, z, sk, massifRadius);
}
