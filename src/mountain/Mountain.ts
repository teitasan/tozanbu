/* ===========================================================
   1つの山。Seed と難易度だけで地形が決まるので、
   同じ Mountain ID なら誰がプレイしても同じ山になる。
   =========================================================== */

import * as THREE from 'three';
import { STAMINA } from '../core/types';
import { SnowSystem } from '../systems/SnowSystem';
import { WallFinder } from './cliff/WallFinder';
import { difficultyProfile, type DifficultyLevel, type DifficultyProfile } from './difficulty';
import { Heightfield } from './Heightfield';
import { MountainMesh } from './MountainMesh';
import { SurfaceMap } from './SurfaceMap';

export interface MountainRecord {
  id: string;
  seed: number;
  difficulty: DifficultyLevel;
  /** 命名されていなければ null (= 未踏峰) */
  name: string | null;
  firstAscentBy: string | null;
  firstAscentParty: string[] | null;
  /** epoch ms */
  firstAscentAt: number | null;
  ascents: number;
}

export function mountainId(seed: number, difficulty: DifficultyLevel): string {
  return `M${(seed >>> 0).toString(36).toUpperCase().padStart(7, '0')}-${difficulty}`;
}

export function parseMountainId(id: string): { seed: number; difficulty: DifficultyLevel } | null {
  const m = /^M([0-9A-Z]+)-([1-5])$/.exec(id.trim().toUpperCase());
  if (!m) return null;
  const seed = parseInt(m[1], 36);
  if (!Number.isFinite(seed)) return null;
  return { seed: seed >>> 0, difficulty: Number(m[2]) as DifficultyLevel };
}

export function newRecord(seed: number, difficulty: DifficultyLevel): MountainRecord {
  return {
    id: mountainId(seed, difficulty),
    seed,
    difficulty,
    name: null,
    firstAscentBy: null,
    firstAscentParty: null,
    firstAscentAt: null,
    ascents: 0,
  };
}

export class Mountain {
  readonly group = new THREE.Group();
  readonly profile: DifficultyProfile;
  readonly field: Heightfield;
  readonly surface: SurfaceMap;
  readonly snow: SnowSystem;
  readonly mesh: MountainMesh;
  readonly walls: WallFinder;
  readonly summitMarker: THREE.Object3D;

  private constructor(
    readonly record: MountainRecord,
    field: Heightfield,
    surface: SurfaceMap,
    snow: SnowSystem,
    mesh: MountainMesh,
  ) {
    this.profile = field.profile;
    this.field = field;
    this.surface = surface;
    this.snow = snow;
    this.mesh = mesh;
    this.group.add(mesh.group);
    this.summitMarker = mesh.addSummitMarker();
    this.walls = new WallFinder(field, surface, this.profile, record.id, STAMINA.max);
  }

  /** 段階ごとに1フレーム譲りながら生成する (ローディング表示のため) */
  static async create(
    record: MountainRecord,
    onProgress?: (label: string, ratio: number) => void,
  ): Promise<Mountain> {
    const profile = difficultyProfile(record.difficulty);
    const yieldFrame = () => new Promise((r) => setTimeout(r, 0));

    onProgress?.('地形を生成中', 0.05);
    await yieldFrame();
    const field = new Heightfield(record.seed, profile);

    onProgress?.('山肌を決定中', 0.45);
    await yieldFrame();
    const surface = new SurfaceMap(field, profile, record.seed);
    const snow = new SnowSystem(field, surface);

    onProgress?.('メッシュを構築中', 0.6);
    await yieldFrame();
    const mesh = new MountainMesh(field, surface, snow.texture, record.seed);

    onProgress?.('準備完了', 1);
    await yieldFrame();
    return new Mountain(record, field, surface, snow, mesh);
  }

  get displayName(): string {
    return this.record.name ?? `未踏峰 ${this.record.id}`;
  }

  get isUnclimbed(): boolean {
    return this.record.firstAscentAt === null;
  }

  get summitHeight(): number {
    return this.field.summit.y;
  }

  /** 山頂に到達したか */
  atSummit(pos: THREE.Vector3, radius = 6): boolean {
    const s = this.field.summit;
    return Math.hypot(pos.x - s.x, pos.z - s.z) < radius && pos.y > s.y - 4;
  }

  update(dt: number): void {
    this.snow.update();
    for (const wall of this.walls.active) wall.update(dt);
  }

  dispose(): void {
    for (const wall of this.walls.active) {
      wall.dispose();
      wall.group.removeFromParent();
    }
    this.mesh.dispose();
    this.group.clear();
  }
}
