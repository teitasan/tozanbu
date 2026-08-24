/* ===========================================================
   山肌の表面状態。
     基盤岩 -> 岩屑・礫 -> 土壌 -> 植生 -> 積雪
   の順に重なる構造を、標高だけでなく
   傾斜・岩質・侵食(凹み)・湿り から決める。
   =========================================================== */

import * as THREE from 'three';
import { clamp01, smoothstep } from '../core/math';
import { fbm, makeNoise2D, makeRng, type Noise2D } from '../core/rng';
import type { DifficultyProfile } from './difficulty';
import type { Heightfield } from './Heightfield';

export type SurfaceType = 'rock' | 'scree' | 'soil' | 'grass' | 'forest' | 'snow';

export interface RockKind {
  id: 'granite' | 'andesite' | 'sandstone' | 'limestone';
  label: string;
  color: THREE.Color;
  /** ホールドの掴みやすさへの補正 (+ で掴みやすい) */
  gripBias: number;
  /** 崩れやすさ。大きいほど岩屑が多い */
  friability: number;
}

const ROCK_KINDS: RockKind[] = [
  { id: 'granite', label: '花崗岩', color: new THREE.Color(0x8d8880), gripBias: 0.12, friability: 0.35 },
  { id: 'andesite', label: '安山岩', color: new THREE.Color(0x5f5b58), gripBias: 0.0, friability: 0.5 },
  { id: 'sandstone', label: '砂岩', color: new THREE.Color(0x9c8465), gripBias: -0.08, friability: 0.75 },
  { id: 'limestone', label: '石灰岩', color: new THREE.Color(0xa8a496), gripBias: 0.05, friability: 0.55 },
];

const COL_SCREE = new THREE.Color(0x7d776c);
const COL_SOIL = new THREE.Color(0x6d5a44);
const COL_GRASS = new THREE.Color(0x62783f);
const COL_FOREST = new THREE.Color(0x2f4b2c);
const COL_SNOW = new THREE.Color(0xeef2f7);

/** 各点で使い回す地形情報 (メッシュ生成時はグリッドから直接渡して高速化する) */
export interface TerrainSample {
  h: number;
  slope: number;
  gx: number;
  gz: number;
  cliff: number;
}

export interface SurfaceSample {
  type: SurfaceType;
  /** 積雪深 (m) */
  snow: number;
  /** 植生の密度 0..1 */
  vegetation: number;
  /** 岩の露出度 0..1 */
  rock: number;
  /** 岩屑 0..1 */
  scree: number;
}

export class SurfaceMap {
  readonly rockKind: RockKind;
  private readonly windX: number;
  private readonly windZ: number;
  private readonly nMoist: Noise2D;
  private readonly nPatch: Noise2D;
  private readonly nSnow: Noise2D;
  readonly treeLine: number;
  readonly snowLine: number;

  private readonly sample: SurfaceSample = { type: 'soil', snow: 0, vegetation: 0, rock: 0, scree: 0 };
  private readonly terrain: TerrainSample = { h: 0, slope: 0, gx: 0, gz: 0, cliff: 0 };

  constructor(
    private readonly field: Heightfield,
    private readonly profile: DifficultyProfile,
    seed: number,
  ) {
    const rng = makeRng(seed + 907);
    this.rockKind = ROCK_KINDS[Math.floor(rng() * ROCK_KINDS.length)];
    const wa = rng() * Math.PI * 2;
    this.windX = Math.cos(wa);
    this.windZ = Math.sin(wa);
    this.nMoist = makeNoise2D(seed + 131);
    this.nPatch = makeNoise2D(seed + 149);
    this.nSnow = makeNoise2D(seed + 167);
    this.treeLine = profile.snowMax > 0 ? field.summit.y * 0.62 + 25 : field.summit.y * 1.3;
    this.snowLine = field.summit.y * profile.snowLine;
  }

  /** 座標から地形情報を作る (単発クエリ用) */
  private terrainAt(x: number, z: number): TerrainSample {
    const t = this.terrain;
    t.h = this.field.heightAt(x, z);
    const g = this.field.gradientAt(x, z);
    t.gx = g.gx;
    t.gz = g.gz;
    t.slope = Math.atan(Math.hypot(g.gx, g.gz));
    t.cliff = this.field.cliffAt(x, z);
    return t;
  }

  // --- 積雪 ---------------------------------------------------------------

  snowDepthWith(x: number, z: number, t: TerrainSample): number {
    if (this.profile.snowMax <= 0) return 0;
    const above = (t.h - this.snowLine) / Math.max(30, this.field.summit.y - this.snowLine);
    if (above <= 0) return 0;
    const hold = 1 - smoothstep(0.62, 1.05, t.slope);
    if (hold <= 0) return 0;
    const lee = clamp01(0.55 + (t.gx * this.windX + t.gz * this.windZ) * 0.9);
    const patch = 0.55 + (this.nSnow(x * 0.02, z * 0.02) * 0.5 + 0.5) * 0.9;
    return Math.max(0, clamp01(above) * this.profile.snowMax * hold * lee * patch);
  }

  snowDepthAt(x: number, z: number): number {
    return this.snowDepthWith(x, z, this.terrainAt(x, z));
  }

  // --- 表面分類 -----------------------------------------------------------

  sampleWith(x: number, z: number, t: TerrainSample): SurfaceSample {
    const s = this.sample;
    const alt = clamp01(t.h / Math.max(1, this.field.summit.y));

    // 岩の露出: 急斜面・崖バンド・高標高で増える
    const rock = clamp01(
      smoothstep(0.55, 0.95, t.slope) * 0.95 + t.cliff * 1.1 + alt * 0.22 + this.nPatch(x * 0.01, z * 0.01) * 0.18,
    );
    // 岩屑は岩の下、中程度の傾斜に溜まる
    const scree = clamp01((1 - rock) * smoothstep(0.38, 0.68, t.slope) * (0.65 + this.rockKind.friability * 0.7));
    // 湿り: 凹地と低標高で高い
    const moist = clamp01(0.78 + fbm(this.nMoist, x * 0.004, z * 0.004, 3) * 0.7 - alt * 0.42 - t.slope * 0.18);
    const veg = clamp01(
      (1 - rock) * (1 - scree * 0.55) * moist * 1.3 * (1 - smoothstep(this.treeLine * 0.78, this.treeLine, t.h)),
    );
    const snow = this.snowDepthWith(x, z, t);

    s.snow = snow;
    s.rock = rock;
    s.scree = scree;
    s.vegetation = veg;
    if (snow > 0.06) s.type = 'snow';
    else if (rock > 0.55) s.type = 'rock';
    else if (scree > 0.45) s.type = 'scree';
    else if (veg > 0.55) s.type = 'forest';
    else if (veg > 0.25) s.type = 'grass';
    else s.type = 'soil';
    return s;
  }

  surfaceAt(x: number, z: number): SurfaceSample {
    return this.sampleWith(x, z, this.terrainAt(x, z));
  }

  // --- 頂点色 -------------------------------------------------------------

  colorWith(x: number, z: number, t: TerrainSample, out: THREE.Color): THREE.Color {
    const s = this.sampleWith(x, z, t);
    out.copy(COL_SOIL);
    out.lerp(COL_GRASS, clamp01(s.vegetation * 1.7));
    if (s.vegetation > 0.5) out.lerp(COL_FOREST, smoothstep(0.5, 0.95, s.vegetation));
    out.lerp(COL_SCREE, clamp01(s.scree * 0.85));
    out.lerp(this.rockKind.color, s.rock);
    out.offsetHSL(0, 0, this.nPatch(x * 0.09, z * 0.09) * 0.055);
    if (s.snow > 0.02) out.lerp(COL_SNOW, smoothstep(0.02, 0.26, s.snow));
    return out;
  }

  colorAt(x: number, z: number, out: THREE.Color): THREE.Color {
    return this.colorWith(x, z, this.terrainAt(x, z), out);
  }

  /** メッシュ生成用: グリッドから直接与えた地形情報で色を作る */
  colorFromGrid(
    x: number,
    z: number,
    h: number,
    gx: number,
    gz: number,
    cliff: number,
    out: THREE.Color,
  ): THREE.Color {
    const t = this.terrain;
    t.h = h;
    t.gx = gx;
    t.gz = gz;
    t.slope = Math.atan(Math.hypot(gx, gz));
    t.cliff = cliff;
    return this.colorWith(x, z, t, out);
  }

  isWalkableSlope(slope: number): boolean {
    return slope < 0.8;
  }

  isClimbableSlope(slope: number): boolean {
    return slope > 0.95;
  }

  describe(): string {
    return `${this.rockKind.label} / 森林限界 ${Math.round(this.treeLine)}m / 雪線 ${
      this.profile.snowMax > 0 ? `${Math.round(this.snowLine)}m` : 'なし'
    }`;
  }
}

export { ROCK_KINDS, COL_SNOW };
