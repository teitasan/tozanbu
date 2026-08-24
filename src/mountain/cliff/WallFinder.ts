/* ===========================================================
   プレイヤーの正面にある岩壁を見つけ、その登攀ルートを生成する。

   壁の同一性は「4m グリッドに量子化したアンカー」で決まり、
   フレーム(基部・向き・高さ・幅)はアンカーとハイトフィールドだけから
   決まるので、どのクライアントでも同じ壁・同じホールドになる。
   =========================================================== */

import * as THREE from 'three';
import { clamp } from '../../core/math';
import { MOVE } from '../../core/types';
import type { DifficultyProfile } from '../difficulty';
import type { Heightfield } from '../Heightfield';
import type { SurfaceMap } from '../SurfaceMap';
import { ClimbWall, type WallFrame } from './ClimbWall';

/** 壁アンカーの量子化サイズ (m) */
const ANCHOR_CELL = 4;
/**
 * これ以上の実効勾配 (上昇量/水平距離) を壁とみなす。
 * 「歩いて登れない斜面は必ず登攀できる」ようにするため、
 * 歩行の限界斜度とそろえてある。中間の詰み斜面を作らないための約束。
 */
// 歩行の限界よりわずかに緩くしておく。境界の誤差で
// 「歩けないのに壁でもない」隙間ができないようにするため
const WALL_GRADIENT = Math.tan(MOVE.maxWalkSlope) * 0.88;
/** これ未満の高さは登攀ではなくマントリング */
const MIN_WALL_HEIGHT = 2.6;
const MAX_WALL_HEIGHT = 45;

const _grad = { gx: 0, gz: 0 };

export class WallFinder {
  private readonly cache = new Map<string, ClimbWall>();
  private readonly failed = new Set<string>();

  constructor(
    private readonly field: Heightfield,
    private readonly surface: SurfaceMap,
    private readonly profile: DifficultyProfile,
    private readonly mountainId: string,
    private readonly maxStamina: number,
  ) {}

  /**
   * 正面 (fx, fz) に岩壁があれば、その正規化されたフレームを返す。
   *
   * 「その点の斜度」ではなく「足元からの上昇量 ÷ 水平距離」で判定する。
   * ハイトフィールドは 2m 格子を補間しているので、壁の根元に立つと
   * 足元の斜度は緩く出てしまい、点の斜度だけでは壁を見落とす。
   */
  probe(pos: THREE.Vector3, fx: number, fz: number, range = 3.6): WallFrame | null {
    const len = Math.hypot(fx, fz);
    if (len < 1e-4) return null;
    const dx = fx / len;
    const dz = fz / len;
    for (let d = 0.4; d <= range; d += 0.3) {
      const x = pos.x + dx * d;
      const z = pos.z + dz * d;
      if (!this.field.inside(x, z)) return null;
      const rise = this.field.heightAt(x, z) - pos.y;
      // ジャンプでもマントリングでも越えられない高さで、かつ壁として立っている
      if (rise > MIN_WALL_HEIGHT * 0.62 && rise / d > WALL_GRADIENT) {
        return this.frameFromAnchor(x, z);
      }
    }
    return null;
  }

  /** 量子化アンカーから壁のフレームを組み立てる (決定論的) */
  frameFromAnchor(px: number, pz: number): WallFrame | null {
    const qi = Math.round(px / ANCHOR_CELL);
    const qj = Math.round(pz / ANCHOR_CELL);
    const id = `w${qi}_${qj}`;
    const cached = this.cache.get(id);
    if (cached) return cached.frame;
    if (this.failed.has(id)) return null;

    const ax = qi * ANCHOR_CELL;
    const az = qj * ANCHOR_CELL;
    if (!this.field.inside(ax, az)) {
      this.failed.add(id);
      return null;
    }

    // 外向き = 下り方向
    this.field.gradientAt(ax, az, _grad);
    const gl = Math.hypot(_grad.gx, _grad.gz);
    if (gl < 0.35) {
      this.failed.add(id);
      return null;
    }
    const outward = new THREE.Vector3(-_grad.gx / gl, 0, -_grad.gz / gl);
    const tangent = new THREE.Vector3(-outward.z, 0, outward.x);

    // 基部 = 壁の足元。アンカーから外へ出て、最初に歩ける地面に出たところ。
    // d=0 から見るのが要点で、アンカー自体が既に足元(平坦)のことがある。
    const anchorH = this.field.heightAt(ax, az);
    let baseX = ax;
    let baseZ = az;
    let baseY = anchorH;
    let found = false;
    // 平らな足元が無い長い急斜面のために、最も低かった点も覚えておく
    let lowX = ax;
    let lowZ = az;
    let lowY = anchorH;
    for (let d = 0; d <= 24; d += 0.3) {
      const x = ax + outward.x * d;
      const z = az + outward.z * d;
      if (!this.field.inside(x, z)) break;
      const h = this.field.heightAt(x, z);
      if (h > anchorH + 0.5) break; // 外へ出たのに上り返した = 行き過ぎ
      if (h < lowY) {
        lowX = x;
        lowZ = z;
        lowY = h;
      }
      if (this.field.slopeAt(x, z) < MOVE.maxWalkSlope) {
        baseX = x;
        baseZ = z;
        baseY = h;
        found = true;
        break;
      }
    }
    if (!found) {
      // どこまでも急な斜面。歩ける足元が無くても登れるようにする。
      // ここで諦めると「歩けないが登れもしない」詰み斜面ができてしまう
      if (anchorH - lowY < MIN_WALL_HEIGHT) {
        this.failed.add(id);
        return null;
      }
      baseX = lowX;
      baseZ = lowZ;
      baseY = lowY;
    }

    // 上端: 内へ向かってテラスに出るまで登る
    let topY = anchorH;
    for (let d = 0.3; d <= 22; d += 0.3) {
      const x = ax - outward.x * d;
      const z = az - outward.z * d;
      if (!this.field.inside(x, z)) break;
      const h = this.field.heightAt(x, z);
      if (h > topY) topY = h;
      if (h > baseY + MIN_WALL_HEIGHT && this.field.slopeAt(x, z) < MOVE.maxWalkSlope) {
        topY = h;
        break;
      }
    }

    const height = Math.min(MAX_WALL_HEIGHT, topY - baseY);
    if (height < MIN_WALL_HEIGHT) {
      this.failed.add(id);
      return null;
    }

    const base = new THREE.Vector3(baseX, baseY, baseZ);
    const halfWidth = this.measureHalfWidth(base, outward, tangent, height);
    if (halfWidth < 2) {
      this.failed.add(id);
      return null;
    }

    return { id, base, outward, tangent, height, halfWidth };
  }

  /** 壁が横にどこまで続いているか */
  private measureHalfWidth(
    base: THREE.Vector3,
    outward: THREE.Vector3,
    tangent: THREE.Vector3,
    height: number,
  ): number {
    const midV = height * 0.5;
    // 垂直な壁なら数mで届くが、40度くらいの岩盤だと奥まで探さないと中腹に届かない
    const depth = Math.min(30, height * 1.6 + 6);
    const test = (u: number): boolean => {
      const x = base.x + tangent.x * u;
      const z = base.z + tangent.z * u;
      // その u で中腹の高さに壁面があるか
      for (let d = 0; d <= depth; d += 0.3) {
        const sx = x - outward.x * d;
        const sz = z - outward.z * d;
        if (!this.field.inside(sx, sz)) return false;
        if (this.field.heightAt(sx, sz) >= base.y + midV) return true;
      }
      return false;
    };
    let left = 0;
    let right = 0;
    for (let u = 1.5; u <= 12; u += 1.5) {
      if (test(u)) right = u;
      else break;
    }
    for (let u = 1.5; u <= 12; u += 1.5) {
      if (test(-u)) left = u;
      else break;
    }
    return clamp(Math.min(left, right), 0, 9);
  }

  /** フレームから登攀ルートを取得 (キャッシュ) */
  acquire(frame: WallFrame): ClimbWall {
    let wall = this.cache.get(frame.id);
    if (!wall) {
      wall = new ClimbWall(frame, this.field, this.profile, this.surface, this.mountainId, this.maxStamina);
      this.cache.set(frame.id, wall);
    }
    return wall;
  }

  get(id: string): ClimbWall | undefined {
    return this.cache.get(id);
  }

  /** 遠くの壁を解放する */
  prune(center: THREE.Vector3, radius: number, keepId: string | null): void {
    for (const [id, wall] of this.cache) {
      if (id === keepId) continue;
      if (wall.frame.base.distanceTo(center) > radius) {
        wall.dispose();
        wall.group.removeFromParent();
        this.cache.delete(id);
      }
    }
  }

  get active(): ClimbWall[] {
    return [...this.cache.values()];
  }
}
