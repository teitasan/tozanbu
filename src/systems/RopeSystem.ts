/* ===========================================================
   ロープ。

   難しい登攀を先行者が突破して上部に固定すると、
   その岩壁を通る全員のスタミナ消費が大幅に下がる。
   ロープ自体を操作するゲームにはせず、
   「有限の装備をどの難所で使うか」の判断だけを持たせる。
   =========================================================== */

import * as THREE from 'three';
import { CLIMB } from '../core/types';
import type { ClimbWall } from '../mountain/cliff/ClimbWall';

export interface FixedRope {
  wallId: string;
  /** 設置したプレイヤー */
  by: string;
  /** 壁の基部座標 (表示と同期用) */
  x: number;
  y: number;
  z: number;
  /** 壁の高さ */
  height: number;
}

export class RopeSystem {
  /** 手持ちのロープ本数 */
  carried: number;
  readonly fixed = new Map<string, FixedRope>();
  readonly group = new THREE.Group();

  private readonly meshes = new Map<string, THREE.Object3D>();

  constructor(initial: number) {
    this.carried = initial;
  }

  hasRope(wallId: string): boolean {
    return this.fixed.has(wallId);
  }

  /** その壁のスタミナ消費倍率 */
  costScale(wallId: string | null): number {
    return wallId && this.fixed.has(wallId) ? CLIMB.ropeCostScale : 1;
  }

  canFix(wall: ClimbWall): boolean {
    return this.carried > 0 && !this.fixed.has(wall.id);
  }

  fix(wall: ClimbWall, by: string): FixedRope | null {
    if (!this.canFix(wall)) return null;
    this.carried -= 1;
    const rope: FixedRope = {
      wallId: wall.id,
      by,
      x: wall.frame.base.x,
      y: wall.frame.base.y,
      z: wall.frame.base.z,
      height: wall.frame.height,
    };
    this.fixed.set(wall.id, rope);
    this.addMesh(rope, wall);
    return rope;
  }

  /** 他プレイヤーが設置したロープを反映 */
  applyRemote(ropes: FixedRope[], resolveWall: (id: string) => ClimbWall | undefined): void {
    for (const r of ropes) {
      if (this.fixed.has(r.wallId)) continue;
      this.fixed.set(r.wallId, r);
      this.addMesh(r, resolveWall(r.wallId));
    }
  }

  /** 回収 (自分が張ったものだけ) */
  retrieve(wallId: string, by: string): boolean {
    const rope = this.fixed.get(wallId);
    if (!rope || rope.by !== by) return false;
    this.fixed.delete(wallId);
    this.carried += 1;
    const mesh = this.meshes.get(wallId);
    if (mesh) {
      mesh.removeFromParent();
      this.meshes.delete(wallId);
    }
    return true;
  }

  private addMesh(rope: FixedRope, wall?: ClimbWall): void {
    if (this.meshes.has(rope.wallId)) return;
    const points: THREE.Vector3[] = [];
    if (wall) {
      // 壁面に沿って垂らす
      const steps = 8;
      for (let i = steps; i >= 0; i--) {
        const v = (i / steps) * wall.frame.height;
        const p = wall.surfacePoint(0, Math.max(0.3, v));
        if (p) points.push(p.clone().addScaledVector(wall.frame.outward, 0.14));
      }
    }
    if (points.length < 2) {
      points.length = 0;
      points.push(new THREE.Vector3(rope.x, rope.y + rope.height, rope.z), new THREE.Vector3(rope.x, rope.y, rope.z));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(points);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffe066 }));
    line.renderOrder = 2;
    this.group.add(line);
    this.meshes.set(rope.wallId, line);
  }

  reset(initial: number): void {
    this.carried = initial;
    this.fixed.clear();
    for (const m of this.meshes.values()) m.removeFromParent();
    this.meshes.clear();
  }

  snapshot(): FixedRope[] {
    return [...this.fixed.values()];
  }
}
