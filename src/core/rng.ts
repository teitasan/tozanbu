/* ===========================================================
   決定論的な乱数とノイズ。
   同じ seed からは常に同じ山が生成される。
   =========================================================== */

import { TAU } from './math';

export type Rng = () => number;

/** mulberry32 相当。seed が同じなら常に同じ列 */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 文字列 -> 32bit seed (山 ID から seed を作るのに使う) */
export function hashString(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 整数座標のハッシュ (0..1)。格子ごとの決定論的な値が欲しいとき用 */
export function hash2(x: number, y: number, seed = 0): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed, 2246822519)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export interface Noise2D {
  (x: number, y: number): number;
}

/** 勾配ノイズ (-1..1)。決定論的 */
export function makeNoise2D(seed: number): Noise2D {
  const rng = makeRng(seed);
  const SIZE = 256;
  const MASK = SIZE - 1;
  const perm = new Uint8Array(SIZE * 2);
  for (let i = 0; i < SIZE; i++) perm[i] = i;
  for (let i = SIZE - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    const t = perm[i];
    perm[i] = perm[j];
    perm[j] = t;
  }
  for (let i = 0; i < SIZE; i++) perm[SIZE + i] = perm[i];

  const gx = new Float32Array(SIZE);
  const gy = new Float32Array(SIZE);
  for (let i = 0; i < SIZE; i++) {
    const a = rng() * TAU;
    gx[i] = Math.cos(a);
    gy[i] = Math.sin(a);
  }

  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

  return function noise(x: number, y: number): number {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const X = xi & MASK;
    const Y = yi & MASK;

    const aa = perm[X + perm[Y]];
    const ba = perm[X + 1 + perm[Y]];
    const ab = perm[X + perm[Y + 1]];
    const bb = perm[X + 1 + perm[Y + 1]];

    const d00 = gx[aa] * xf + gy[aa] * yf;
    const d10 = gx[ba] * (xf - 1) + gy[ba] * yf;
    const d01 = gx[ab] * xf + gy[ab] * (yf - 1);
    const d11 = gx[bb] * (xf - 1) + gy[bb] * (yf - 1);

    const u = fade(xf);
    const v = fade(yf);
    const a = d00 + u * (d10 - d00);
    const b = d01 + u * (d11 - d01);
    return a + v * (b - a);
  };
}

/** 通常の fBm (-1..1 付近) */
export function fbm(noise: Noise2D, x: number, y: number, octaves: number, lacunarity = 2.03, gain = 0.5): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise(x * freq, y * freq) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** リッジノイズ。尾根のような鋭い稜線ができる (0..1) */
export function ridgedFbm(noise: Noise2D, x: number, y: number, octaves: number, lacunarity = 2.07, gain = 0.5): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(noise(x * freq, y * freq));
    sum += n * n * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}
