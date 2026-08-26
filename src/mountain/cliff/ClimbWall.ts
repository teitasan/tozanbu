/* ===========================================================
   岩壁1枚。

   内部は 2D グリッド。各セルに登攀難易度 (Easy/Medium/Hard/Impossible) を持つ。
   グリッドそのものは描かない。難易度は登攀中の HUD とセル判定で伝える。

     Easy       休みやすく消費が少ないセル
     Medium     標準的な消費のセル
     Hard       消費が大きいセル
     Impossible 通れないセル

   生成後は到達可能性を検査するが、岩肌の補修による突破保証は行わない。
   登れない壁・工夫で登れる壁・巻くべき壁が混在してよい。
   =========================================================== */

import * as THREE from 'three';
import { clamp, clamp01 } from '../../core/math';
import { fbm, hashString, makeNoise2D, makeRng, type Rng } from '../../core/rng';
import { CLIMB, MOVE } from '../../core/types';
import type { DifficultyProfile } from '../difficulty';
import type { Heightfield } from '../Heightfield';
import type { SurfaceMap } from '../SurfaceMap';
import {
  CELL_SIZE,
  passable,
  type Cell,
} from './grid';
import { solveRoute, type SolverResult } from './routeSolver';

export interface WallFrame {
  id: string;
  /** 壁の基部 (足元) */
  base: THREE.Vector3;
  /** 水平・壁から外向き */
  outward: THREE.Vector3;
  /** 水平・壁沿い */
  tangent: THREE.Vector3;
  height: number;
  halfWidth: number;
}


const _up = new THREE.Vector3(0, 1, 0);
const _origin = new THREE.Vector3();
const _look = new THREE.Matrix4();

export class ClimbWall {
  readonly id: string;
  readonly cols: number;
  readonly rows: number;
  readonly cellW: number;
  readonly cellH: number;
  /** row-major。row 0 が基部 */
  readonly cells: Cell[] = [];
  readonly group = new THREE.Group();
  readonly reach: number;
  /** 生成時の到達可能性検査 (デバッグ用。ルートは見せない) */
  readonly report: SolverResult;
  readonly repairs: number;

  private readonly currentMarker: THREE.Mesh;
  private readonly targetMarker: THREE.Mesh;

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
    const seed = hashString(`${mountainId}|${frame.id}`);
    const rng = makeRng(seed);
    const noise = makeNoise2D(seed + 17);

    this.cols = Math.max(3, Math.round((frame.halfWidth * 2) / CELL_SIZE));
    this.rows = Math.max(3, Math.round(frame.height / CELL_SIZE));
    this.cellW = (frame.halfWidth * 2) / this.cols;
    this.cellH = frame.height / this.rows;

    this.buildCells(rng, noise, surface.rockKind.gripBias);
    this.markEndpoints();
    this.report = this.solve(maxStamina);
    this.repairs = 0;

    // 岩肌オーバーレイは地形から浮いて見えるため描画しない。
    // 登攀の難易度はセルグリッドと HUD で伝え、岩面の色は地形メッシュの頂点色で足りる。
    this.currentMarker = this.buildMarker(0xffffff, 0.34);
    this.targetMarker = this.buildMarker(0xffd24a, 0.44);
    this.group.add(this.currentMarker, this.targetMarker);
  }

  // --- 壁面の座標 ---------------------------------------------------------

  /**
   * 壁面上の点を求める。高さ v のところで壁の外から内へ探索し、
   * 地形に当たった点を返す。当たらなければ null (その高さに壁が無い)。
   */
  surfacePoint(u: number, v: number, out = new THREE.Vector3()): THREE.Vector3 | null {
    const f = this.frame;
    const y = f.base.y + v;
    const startX = f.base.x + f.tangent.x * u + f.outward.x * 3.5;
    const startZ = f.base.z + f.tangent.z * u + f.outward.z * 3.5;
    const stepLen = 0.3;
    const steps = Math.ceil(Math.min(28, 8 + f.height * 1.4) / stepLen);
    let prev = -1;
    for (let i = 0; i < steps; i++) {
      const d = i * stepLen;
      const x = startX - f.outward.x * d;
      const z = startZ - f.outward.z * d;
      if (!this.field.inside(x, z)) {
        prev = d;
        continue;
      }
      if (this.field.heightAt(x, z) >= y) {
        // 粗い刻みだと最大 0.3m ずれるので、二分探索で壁面まで詰める。
        // ここがずれると岩の造形が壁から浮いて見える
        let lo = prev < 0 ? d - stepLen : prev; // まだ岩の外
        let hi = d; // すでに岩の中
        for (let k = 0; k < 10; k++) {
          const mid = (lo + hi) * 0.5;
          const mx = startX - f.outward.x * mid;
          const mz = startZ - f.outward.z * mid;
          if (this.field.inside(mx, mz) && this.field.heightAt(mx, mz) >= y) hi = mid;
          else lo = mid;
        }
        out.set(startX - f.outward.x * hi, y, startZ - f.outward.z * hi);
        return out;
      }
      prev = d;
    }
    return null;
  }

  /** その点の壁面法線 (水平成分を主とする、岩から外向き) */
  private surfaceNormal(pos: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
    const n = this.field.normalAt(pos.x, pos.z);
    out.set(n.x, Math.max(0, n.y) * 0.25, n.z);
    if (out.lengthSq() < 1e-6) out.set(this.frame.outward.x, 0.2, this.frame.outward.z);
    return out.normalize();
  }

  /** その位置から壁の上へ抜けられるか */
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

  /** そのセルからマントリングで抜けたときの着地点 */
  topOutPoint(cell: Cell): THREE.Vector3 | null {
    if (!cell.pos) return null;
    const f = this.frame;
    for (let d = 0.8; d <= 5; d += 0.4) {
      const x = cell.pos.x - f.outward.x * d;
      const z = cell.pos.z - f.outward.z * d;
      if (!this.field.inside(x, z)) break;
      const h = this.field.heightAt(x, z);
      if (h <= cell.pos.y + 1.4 && this.field.slopeAt(x, z) < MOVE.maxStandSlope) {
        return new THREE.Vector3(x, h, z);
      }
    }
    return null;
  }

  // --- セルの生成 ---------------------------------------------------------

  cellAt(col: number, row: number): Cell | undefined {
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return undefined;
    return this.cells[row * this.cols + col];
  }

  /** セル中心の壁面座標 */
  private cellUV(col: number, row: number): { u: number; v: number } {
    return {
      u: -this.frame.halfWidth + (col + 0.5) * this.cellW,
      v: (row + 0.5) * this.cellH,
    };
  }

  private buildCells(rng: Rng, noise: ReturnType<typeof makeNoise2D>, gripBias: number): void {
    const g = this.profile.climb.grades;
    // 岩肌の「登りやすさ」を連続場として作る。
    // 縦に伸びるクラック帯と横に走る岩棚帯ができるよう、u と v でスケールを変える。
    const quality = (u: number, v: number): number => {
      const streak = fbm(noise, u * 0.42, v * 0.14, 3); // 縦に伸びる筋
      const band = fbm(noise, u * 0.09 + 31.7, v * 0.55, 2); // 横に走る帯
      const grain = noise(u * 1.7, v * 1.6) * 0.25;
      return streak * 0.62 + band * 0.5 + grain;
    };

    const pos = new THREE.Vector3();
    const quals: number[] = [];
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const { u, v } = this.cellUV(col, row);
        const found = this.surfacePoint(u, v, pos);
        quals.push(quality(u, v));
        const p = found ? found.clone() : null;
        this.cells.push({
          col,
          row,
          grade: 'medium',
          rest: false,
          pos: p,
          normal: p ? this.surfaceNormal(p) : this.frame.outward.clone(),
          ground: false,
          topOut: false,
        });
      }
    }

    // 難易度は「登りやすさの順位」で割り当てる。
    // ノイズの分布に左右されず、狙った比率をそのまま出せる。
    const order = this.cells.map((_, i) => i).sort((a, b) => quals[b] - quals[a]);
    const total = order.length;
    const bias = clamp(gripBias, -0.15, 0.15);
    const nEasy = Math.round(total * clamp01(g.easy + bias));
    const nMedium = Math.round(total * g.medium);
    const nHard = Math.round(total * g.hard);
    order.forEach((idx, rank) => {
      const cell = this.cells[idx];
      if (rank < nEasy) cell.grade = 'easy';
      else if (rank < nEasy + nMedium) cell.grade = 'medium';
      else if (rank < nEasy + nMedium + nHard) cell.grade = 'hard';
      else cell.grade = 'impossible';
    });

    for (const cell of this.cells) {
      if (cell.row === 0 && cell.grade === 'impossible') cell.grade = 'hard';
      cell.rest = cell.grade === 'easy' && rng() < this.profile.climb.restRatio;
    }
  }

  // --- 取り付き・抜け口のマーキング (難易度は変えない) -------------------

  private markEndpoints(): void {
    for (const c of this.cells) {
      if (!c.pos) continue;
      const v = this.cellUV(c.col, c.row).v;
      c.ground = v <= 2.0;
      c.topOut = v >= this.frame.height - 1.8 && this.canExitAt(c.pos);
    }
  }

  private solve(maxStamina: number): SolverResult {
    return solveRoute({
      cells: this.cells,
      grid: this,
      distanceCost: CLIMB.distanceCost,
      maxStamina,
    });
  }

  // --- 登攀中のマーカー ---------------------------------------------------

  /** その法線を向く姿勢 */
  private orientationFor(normal: THREE.Vector3, out = new THREE.Quaternion()): THREE.Quaternion {
    _look.lookAt(_origin, normal, _up);
    return out.setFromRotationMatrix(_look);
  }

  private buildMarker(color: number, radius: number): THREE.Mesh {
    const m = new THREE.Mesh(
      new THREE.TorusGeometry(radius, 0.05, 8, 24),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false }),
    );
    m.renderOrder = 5;
    m.visible = false;
    return m;
  }

  /** マーカーをそのセルの壁面に貼り付ける */
  private placeMarker(m: THREE.Mesh, cell: Cell | null): void {
    if (!cell?.pos) {
      m.visible = false;
      return;
    }
    m.visible = true;
    m.position.copy(cell.pos).addScaledVector(cell.normal, 0.12);
    this.orientationFor(cell.normal, m.quaternion);
  }

  /** いま掴んでいるセル */
  setCurrent(cell: Cell | null): void {
    this.placeMarker(this.currentMarker, cell);
  }

  /** 方向キーで狙っているセル */
  setTarget(cell: Cell | null): void {
    this.placeMarker(this.targetMarker, cell);
  }

  clearMarkers(): void {
    this.currentMarker.visible = false;
    this.targetMarker.visible = false;
  }

  // --- 問い合わせ ---------------------------------------------------------

  /** 指定位置から reach 以内の通れるセル */
  cellsWithin(pos: THREE.Vector3, radius: number, exclude?: Cell): Cell[] {
    const out: Cell[] = [];
    for (const c of this.cells) {
      if (c === exclude || !passable(c)) continue;
      if (c.pos!.distanceTo(pos) <= radius) out.push(c);
    }
    return out;
  }

  get groundCells(): Cell[] {
    return this.cells.filter((c) => c.ground && passable(c));
  }

  update(_dt: number): void {
    /* セルは静的。表示の更新は不要 */
  }

  dispose(): void {
    for (const m of [this.currentMarker, this.targetMarker]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.group.clear();
  }
}
