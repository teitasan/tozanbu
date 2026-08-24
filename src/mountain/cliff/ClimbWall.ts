/* ===========================================================
   岩壁1枚ぶんの登攀ルート生成。

   壁面をローカル座標 (u = 横, v = 高さ) で扱い、
   ジッタ付きグリッドに登攀可能箇所を撒く。
   撒いたあとにグラフとして到達可能性を検査し、
   突破可能ルートが1本もなければ補修する (橋渡し / 岩棚化 / ホールド強化)。
   正解ルート自体は表示しない。
   =========================================================== */

import * as THREE from 'three';
import { clamp, clamp01 } from '../../core/math';
import { hashString, makeRng, type Rng } from '../../core/rng';
import { CLIMB, HOLD_BASE_COST, MOVE, type HoldType } from '../../core/types';
import type { DifficultyProfile } from '../difficulty';
import type { Heightfield } from '../Heightfield';
import type { SurfaceMap } from '../SurfaceMap';
import { Hold } from './Hold';
import { solveRoute, type SolvableHold, type SolverResult } from './routeSolver';

export interface WallFrame {
  id: string;
  /** 壁の基部 (接触点の足元) */
  base: THREE.Vector3;
  /** 水平・壁から外向き */
  outward: THREE.Vector3;
  /** 水平・壁沿い */
  tangent: THREE.Vector3;
  /** 壁の高さ (m) */
  height: number;
  /** 壁の横幅の半分 (m) */
  halfWidth: number;
}

interface HoldSpec extends SolvableHold {
  u: number;
  v: number;
  normal: THREE.Vector3;
  ground: boolean;
  topOut: boolean;
}

const UPGRADE: Record<HoldType, HoldType> = {
  bad: 'small',
  small: 'normal',
  normal: 'large',
  large: 'ledge',
  ledge: 'ledge',
};

export class ClimbWall {
  readonly id: string;
  readonly holds: Hold[] = [];
  readonly holdById = new Map<string, Hold>();
  readonly startHolds: Hold[] = [];
  readonly topHolds: Hold[] = [];
  readonly group = new THREE.Group();
  readonly pickTargets: THREE.Object3D[] = [];
  readonly reach: number;
  /** 生成時の到達可能性検査の結果 (デバッグ用。ルートは表示しない) */
  readonly report: SolverResult;
  readonly repairs: number;

  private readonly uv = new Map<string, { u: number; v: number }>();

  constructor(
    readonly frame: WallFrame,
    private readonly field: Heightfield,
    private readonly profile: DifficultyProfile,
    surface: SurfaceMap,
    mountainId: string,
    maxStamina: number,
  ) {
    this.id = frame.id;
    this.reach = profile.climb.reach;
    const rng = makeRng(hashString(`${mountainId}|${frame.id}`));

    let specs = this.scatterHolds(rng, surface.rockKind.gripBias);
    const repair = this.guarantee(specs, maxStamina);
    specs = repair.specs;
    this.report = repair.report;
    this.repairs = repair.repairs;

    for (const spec of specs) {
      const hold = new Hold({
        id: spec.id,
        type: spec.type,
        position: spec.position,
        normal: spec.normal,
        ground: spec.ground,
        topOut: spec.topOut,
      });
      this.holds.push(hold);
      this.holdById.set(hold.id, hold);
      this.uv.set(hold.id, { u: spec.u, v: spec.v });
      this.group.add(hold.group);
      this.pickTargets.push(hold.pickTarget);
      if (hold.ground) this.startHolds.push(hold);
      if (hold.topOut) this.topHolds.push(hold);
    }
  }

  // --- 壁面の座標変換 -----------------------------------------------------

  /**
   * 壁面上の点を求める。高さ y のところで壁の外側から内側へ探索し、
   * 地形に当たった点を返す。当たらなければ null (その高さに壁が無い)。
   */
  surfacePoint(u: number, v: number, out = new THREE.Vector3()): THREE.Vector3 | null {
    const f = this.frame;
    const y = f.base.y + v;
    // 基部は壁の足元なので、少し外から内へ向かって探せばよい
    const startX = f.base.x + f.tangent.x * u + f.outward.x * 3.5;
    const startZ = f.base.z + f.tangent.z * u + f.outward.z * 3.5;
    const stepLen = 0.3;
    // 壁が寝ているほど奥まで探さないと面に当たらない
    const steps = Math.ceil(Math.min(28, 8 + f.height * 1.4) / stepLen);
    let prevX = startX;
    let prevZ = startZ;
    for (let i = 0; i < steps; i++) {
      const x = startX - f.outward.x * (i * stepLen);
      const z = startZ - f.outward.z * (i * stepLen);
      if (!this.field.inside(x, z)) {
        // 世界の外側から始まることがある。そこで諦めず内側まで見る
        prevX = x;
        prevZ = z;
        continue;
      }
      if (this.field.heightAt(x, z) >= y) {
        // 1つ手前 (= 壁の表面) をわずかに外へ出した点
        out.set(prevX + f.outward.x * 0.16, y, prevZ + f.outward.z * 0.16);
        return out;
      }
      prevX = x;
      prevZ = z;
    }
    return null;
  }

  /** その位置から壁の上へ抜けられるか (テラスが手の届く高さにあるか) */
  private canExitAt(pos: THREE.Vector3): boolean {
    const f = this.frame;
    for (let d = 0.8; d <= 4.5; d += 0.4) {
      const x = pos.x - f.outward.x * d;
      const z = pos.z - f.outward.z * d;
      if (!this.field.inside(x, z)) return false;
      const h = this.field.heightAt(x, z);
      if (h <= pos.y + 1.4 && this.field.slopeAt(x, z) < MOVE.maxStandSlope) return true;
    }
    return false;
  }

  /** そのホールドからマントリングで抜けたときの着地点 */
  topOutPoint(hold: Hold): THREE.Vector3 | null {
    const uv = this.uv.get(hold.id);
    if (!uv) return null;
    const f = this.frame;
    for (let d = 0.8; d <= 5; d += 0.4) {
      const x = hold.position.x - f.outward.x * d;
      const z = hold.position.z - f.outward.z * d;
      if (!this.field.inside(x, z)) break;
      const h = this.field.heightAt(x, z);
      if (h <= hold.position.y + 1.4 && this.field.slopeAt(x, z) < 0.85) {
        return new THREE.Vector3(x, h, z);
      }
    }
    return null;
  }

  // --- ホールドを撒く -----------------------------------------------------

  private pickType(rng: Rng, gripBias: number): HoldType {
    const c = this.profile.climb;
    if (rng() < c.restRatio) return 'ledge';
    const hard = clamp01(c.hardRatio - gripBias * 0.5);
    if (rng() < hard) return rng() < 0.35 ? 'bad' : 'small';
    return rng() < 0.45 + gripBias ? 'large' : 'normal';
  }

  private makeSpec(
    id: string,
    type: HoldType,
    u: number,
    v: number,
    pos: THREE.Vector3,
  ): HoldSpec {
    const f = this.frame;
    return {
      id,
      type,
      u,
      v,
      position: pos,
      baseStaminaCost: HOLD_BASE_COST[type],
      normal: new THREE.Vector3(f.outward.x, 0.28, f.outward.z).normalize(),
      ground: v <= 1.9,
      // 「上のテラスに手が届く」ことをトップアウトの条件にする。
      // 壁の形は場所ごとに違うので、高さの閾値だけでは判定できない
      topOut: v >= Math.min(4, f.height * 0.55) && this.canExitAt(pos),
    };
  }

  private scatterHolds(rng: Rng, gripBias: number): HoldSpec[] {
    const f = this.frame;
    const c = this.profile.climb;
    const cell = 1 / Math.sqrt(c.density);
    const specs: HoldSpec[] = [];
    const pos = new THREE.Vector3();
    let n = 0;

    const cols = Math.max(2, Math.round((f.halfWidth * 2) / cell));
    const rows = Math.max(3, Math.round(f.height / cell));
    for (let r = 0; r <= rows; r++) {
      for (let col = 0; col <= cols; col++) {
        const baseU = -f.halfWidth + (col / cols) * f.halfWidth * 2;
        const baseV = 0.7 + (r / rows) * (f.height - 1.1);
        const u = baseU + (rng() - 0.5) * cell * 0.5;
        const v = clamp(baseV + (rng() - 0.5) * cell * 0.5, 0.55, f.height - 0.35);
        if (Math.abs(u) > f.halfWidth) continue;
        if (!this.surfacePoint(u, v, pos)) continue;
        specs.push(this.makeSpec(`${this.id}#${n++}`, this.pickType(rng, gripBias), u, v, pos.clone()));
      }
    }

    // 最上部の列。ここが無いとトップアウトできる手がかりが生まれないことがある
    const topV = Math.max(0.6, f.height - 0.45);
    for (let u = -f.halfWidth; u <= f.halfWidth + 0.01; u += Math.max(1.2, cell * 0.8)) {
      if (!this.surfacePoint(u, topV, pos)) continue;
      const type = rng() < 0.35 ? 'ledge' : this.pickType(rng, gripBias);
      specs.push(this.makeSpec(`${this.id}#t${n++}`, type, u, topV, pos.clone()));
    }

    // 行き止まりのおとり
    const decoys = Math.round(specs.length * c.deadEndRatio);
    for (let i = 0; i < decoys; i++) {
      const u = (rng() * 2 - 1) * f.halfWidth;
      const v = 1.5 + rng() * (f.height - 2.5);
      if (!this.surfacePoint(u, v, pos)) continue;
      const type: HoldType = rng() < 0.5 ? 'bad' : 'small';
      specs.push(this.makeSpec(`${this.id}#${n++}`, type, u, v, pos.clone()));
    }

    return specs;
  }

  // --- 到達可能性の保証 ---------------------------------------------------

  private solve(specs: HoldSpec[], maxStamina: number): SolverResult {
    return solveRoute({
      holds: specs,
      reach: this.reach,
      distanceCost: CLIMB.distanceCost,
      starts: specs.filter((s) => s.ground),
      goals: specs.filter((s) => s.topOut),
      maxStamina,
    });
  }

  /** 突破可能ルートが1本もなければ補修する */
  private guarantee(
    specs: HoldSpec[],
    maxStamina: number,
  ): { specs: HoldSpec[]; report: SolverResult; repairs: number } {
    let repairs = 0;
    let report = this.solve(specs, maxStamina);
    for (let iter = 0; iter < 60 && !report.feasible; iter++) {
      const changed = this.bridgeGap(specs) || this.easePath(specs, maxStamina);
      if (!changed) break;
      repairs++;
      report = this.solve(specs, maxStamina);
    }
    if (!report.feasible) {
      console.warn(`[ClimbWall] ${this.id}: 突破可能ルートを保証できなかった (holds=${specs.length})`);
    }
    return { specs, report, repairs };
  }

  /** スタート -> トップアウトが物理的に繋がっていないとき、橋渡しのホールドを足す */
  private bridgeGap(specs: HoldSpec[]): boolean {
    const starts = specs.filter((s) => s.ground);
    const pos = new THREE.Vector3();
    if (starts.length === 0) {
      // 取り付ける場所が無い: 基部に大ホールドを作る
      for (const u of [0, -2, 2, -4, 4, -6, 6]) {
        if (this.surfacePoint(u, 1.1, pos)) {
          specs.push(this.makeSpec(`${this.id}#b${specs.length}`, 'large', u, 1.1, pos.clone()));
          return true;
        }
      }
      return false;
    }

    // コスト無視の到達集合
    const reachable = new Set<HoldSpec>(starts);
    const queue = [...starts];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const s of specs) {
        if (reachable.has(s)) continue;
        if (cur.position.distanceTo(s.position) <= this.reach) {
          reachable.add(s);
          queue.push(s);
        }
      }
    }
    if ([...reachable].some((s) => s.topOut)) return false; // 連結はしている

    // 高いところから順に、そこから届く範囲でいちばん上へ足場を1つ伸ばす
    const frontier = [...reachable].sort((a, b) => b.v - a.v);
    const hw = this.frame.halfWidth;
    for (const from of frontier.slice(0, 8)) {
      let best: { u: number; v: number; pos: THREE.Vector3 } | null = null;
      for (let dv = 0.5; dv <= this.reach; dv += 0.3) {
        const v = Math.min(this.frame.height - 0.3, from.v + dv);
        for (const du of [0, 0.7, -0.7, 1.4, -1.4, 2.1, -2.1]) {
          const u = clamp(from.u + du, -hw, hw);
          if (!this.surfacePoint(u, v, pos)) continue;
          const d = pos.distanceTo(from.position);
          if (d < 0.4 || d > this.reach * 0.97) continue;
          if (!best || v > best.v) best = { u, v, pos: pos.clone() };
        }
      }
      if (best && best.v > from.v + 0.3) {
        specs.push(this.makeSpec(`${this.id}#b${specs.length}`, 'normal', best.u, best.v, best.pos));
        return true;
      }
    }
    return false;
  }

  /** 繋がってはいるがスタミナが足りないとき、最短経路上のホールドを楽にする */
  private easePath(specs: HoldSpec[], maxStamina: number): boolean {
    const starts = specs.filter((s) => s.ground);
    if (!starts.length) return false;

    // 最少手数の経路を取る
    const prev = new Map<HoldSpec, HoldSpec | null>();
    const queue: HoldSpec[] = [];
    for (const s of starts) {
      prev.set(s, null);
      queue.push(s);
    }
    let goal: HoldSpec | null = null;
    while (queue.length && !goal) {
      const cur = queue.shift()!;
      if (cur.topOut) {
        goal = cur;
        break;
      }
      for (const s of specs) {
        if (prev.has(s)) continue;
        if (cur.position.distanceTo(s.position) <= this.reach) {
          prev.set(s, cur);
          queue.push(s);
        }
      }
    }
    if (!goal) return false;

    const path: HoldSpec[] = [];
    for (let cur: HoldSpec | null = goal; cur; cur = prev.get(cur) ?? null) path.push(cur);
    path.reverse();

    // 消費が maxStamina を超える最初の区間を探して緩める
    let segment = 0;
    let segStart = 0;
    for (let i = 1; i < path.length; i++) {
      const cost =
        path[i].baseStaminaCost + path[i - 1].position.distanceTo(path[i].position) * CLIMB.distanceCost;
      segment += cost;
      if (path[i].type === 'ledge') {
        segment = 0;
        segStart = i;
        continue;
      }
      if (segment > maxStamina * 0.85) {
        // 区間の真ん中を岩棚にして休憩できるようにする
        const mid = path[Math.max(segStart + 1, Math.floor((segStart + i) / 2))];
        if (mid && mid.type !== 'ledge' && !mid.ground) {
          mid.type = 'ledge';
          mid.baseStaminaCost = HOLD_BASE_COST.ledge;
          return true;
        }
        // すでに岩棚なら、区間内で最も重いホールドを1段楽にする
        let worst: HoldSpec | null = null;
        for (let k = segStart + 1; k <= i; k++) {
          if (!worst || path[k].baseStaminaCost > worst.baseStaminaCost) worst = path[k];
        }
        if (worst && worst.type !== 'large' && worst.type !== 'ledge') {
          worst.type = UPGRADE[worst.type];
          worst.baseStaminaCost = HOLD_BASE_COST[worst.type];
          return true;
        }
        return false;
      }
    }
    return false;
  }

  update(dt: number): void {
    for (const h of this.holds) h.update(dt);
  }

  getHold(id: string): Hold | undefined {
    return this.holdById.get(id);
  }

  holdsWithin(position: THREE.Vector3, radius: number, exclude?: Hold): Hold[] {
    const out: Hold[] = [];
    for (const h of this.holds) {
      if (h === exclude) continue;
      if (h.position.distanceTo(position) <= radius) out.push(h);
    }
    return out;
  }

  dispose(): void {
    for (const h of this.holds) h.dispose();
    this.group.clear();
  }
}
