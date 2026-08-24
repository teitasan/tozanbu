/* ===========================================================
   岩壁1枚。

   内部は 2D グリッド。各セルに登攀難易度 (Easy/Medium/Hard/Impossible) を持つ。
   グリッドそのものは描かない。難易度は岩肌の造形で伝える。

     Easy       大きな突起・岩棚
     Medium     小さな突起・凹凸
     Hard       細いクラック・小さなエッジ
     Impossible ほぼ平滑 (何も生えない)

   生成したあとにグリッド経路探索で到達可能性を検査し、
   突破可能ルートが1本も無ければ岩肌を補修する。
   =========================================================== */

import * as THREE from 'three';
import { clamp, clamp01 } from '../../core/math';
import { fbm, hashString, makeNoise2D, makeRng, type Rng } from '../../core/rng';
import { CLIMB, MOVE } from '../../core/types';
import type { DifficultyProfile } from '../difficulty';
import type { Heightfield } from '../Heightfield';
import type { SurfaceMap } from '../SurfaceMap';
import { CELL_SIZE, cellMoveCost, passable, type Cell, type CellGrade } from './grid';
import { reachableSet, solveRoute, type SolverResult } from './routeSolver';

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

/** 難易度を1段ずつ易しくする */
const EASE: Record<CellGrade, CellGrade> = {
  impossible: 'hard',
  hard: 'medium',
  medium: 'easy',
  easy: 'easy',
};

const _scale = new THREE.Vector3();
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

  private readonly hoverMarker: THREE.Mesh;
  private readonly routeMarkers: THREE.Mesh[] = [];
  private readonly detailMeshes: THREE.InstancedMesh[] = [];

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
    const repair = this.guarantee(maxStamina);
    this.report = repair.report;
    this.repairs = repair.repairs;

    this.buildRockDetail(seed);
    this.hoverMarker = this.buildMarker(0xffffff, 0.42);
    this.hoverMarker.visible = false;
    this.group.add(this.hoverMarker);
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
    // 縦に伸びるクラック帯と横に走る岩棚帯ができるよう、u と v でスケールを変える
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
      // 基部は取り付けるように、平滑なままにはしない
      if (cell.row === 0 && cell.grade === 'impossible') cell.grade = 'hard';
      cell.rest = cell.grade === 'easy' && rng() < this.profile.climb.restRatio;
    }

    // 地上から取り付けるセル / 壁の上へ抜けられるセル
    for (const c of this.cells) {
      if (!c.pos) continue;
      const v = this.cellUV(c.col, c.row).v;
      c.ground = v <= 2.0;
      c.topOut = v >= this.frame.height - 1.8 && this.canExitAt(c.pos);
    }
  }

  // --- 到達可能性の保証 ---------------------------------------------------

  private solve(maxStamina: number): SolverResult {
    return solveRoute({
      cells: this.cells,
      reach: this.reach,
      distanceCost: CLIMB.distanceCost,
      maxStamina,
    });
  }

  /** 突破可能ルートが1本も無ければ岩肌を補修する */
  private guarantee(maxStamina: number): { report: SolverResult; repairs: number } {
    this.ensureEndpoints();
    let repairs = 0;
    let report = this.solve(maxStamina);
    for (let iter = 0; iter < 50 && !report.feasible; iter++) {
      const changed = this.bridgeGap() || this.easePath(maxStamina);
      if (!changed) break;
      repairs++;
      report = this.solve(maxStamina);
    }
    if (!report.feasible) {
      console.warn(`[ClimbWall] ${this.id}: 突破可能ルートを保証できなかった`);
    }
    return { report, repairs };
  }

  /** 取り付き口と抜け口が最低1つずつあるようにする */
  private ensureEndpoints(): void {
    const usable = this.cells.filter((c) => c.pos !== null);
    if (usable.length === 0) return;

    if (!this.cells.some((c) => c.ground && passable(c))) {
      const row0 = usable.filter((c) => c.row === 0);
      const pick = row0[Math.floor(row0.length / 2)] ?? usable[0];
      pick.grade = 'easy';
      pick.ground = true;
    }
    if (!this.cells.some((c) => c.topOut && passable(c))) {
      // 抜けられる場所を上から探す
      const byHeight = usable.slice().sort((a, b) => b.row - a.row);
      for (const c of byHeight) {
        if (this.canExitAt(c.pos!)) {
          if (c.grade === 'impossible') c.grade = 'hard';
          c.topOut = true;
          break;
        }
      }
    }
    if (!this.cells.some((c) => c.topOut && passable(c))) {
      // 幾何的に抜けられないので、最上段を抜け口として扱う (着地点は別途フォールバック)
      const top = usable.filter((c) => c.row === this.rows - 1);
      for (const c of top.slice(0, 3)) {
        if (c.grade === 'impossible') c.grade = 'hard';
        c.topOut = true;
      }
    }
  }

  /** 繋がっていないとき、途切れ目の岩を易しくして道を通す */
  private bridgeGap(): boolean {
    const starts = this.cells.filter((c) => c.ground && passable(c));
    if (!starts.length) return false;
    const reached = reachableSet(this.cells, this.reach, starts);
    if ([...reached].some((c) => c.topOut)) return false; // 連結はしている

    // 到達集合の縁から、上へ繋がる impossible セルを1つ開ける
    let bestCell: Cell | null = null;
    let bestScore = -Infinity;
    for (const from of reached) {
      if (!from.pos) continue;
      for (const c of this.cells) {
        if (reached.has(c) || !c.pos) continue;
        if (from.pos.distanceTo(c.pos) > this.reach) continue;
        // 高いところへ抜けられるものを優先
        const score = c.pos.y - from.pos.y + (c.grade === 'impossible' ? 0 : 1.5);
        if (score > bestScore) {
          bestScore = score;
          bestCell = c;
        }
      }
    }
    if (!bestCell) return false;
    bestCell.grade = EASE[bestCell.grade];
    return true;
  }

  /** 繋がってはいるがスタミナが足りないとき、経路上を楽にする */
  private easePath(maxStamina: number): boolean {
    const starts = this.cells.filter((c) => c.ground && passable(c));
    if (!starts.length) return false;

    // 最少手数の経路を取る
    const prev = new Map<Cell, Cell | null>();
    const queue: Cell[] = [];
    for (const s of starts) {
      prev.set(s, null);
      queue.push(s);
    }
    let goal: Cell | null = null;
    while (queue.length && !goal) {
      const cur = queue.shift()!;
      if (cur.topOut) {
        goal = cur;
        break;
      }
      for (const c of this.cells) {
        if (prev.has(c) || !passable(c) || !cur.pos) continue;
        if (cur.pos.distanceTo(c.pos!) <= this.reach) {
          prev.set(c, cur);
          queue.push(c);
        }
      }
    }
    if (!goal) return false;

    const path: Cell[] = [];
    for (let cur: Cell | null = goal; cur; cur = prev.get(cur) ?? null) path.push(cur);
    path.reverse();

    // 消費が上限に近づく最初の区間を緩める
    let segment = 0;
    let segStart = 0;
    for (let i = 1; i < path.length; i++) {
      segment += cellMoveCost(path[i - 1], path[i], CLIMB.distanceCost);
      if (path[i].rest) {
        segment = 0;
        segStart = i;
        continue;
      }
      if (segment > maxStamina * 0.85) {
        // 区間の真ん中を岩棚にして休めるようにする
        const mid = path[Math.max(segStart + 1, Math.floor((segStart + i) / 2))];
        if (mid && !mid.rest && !mid.ground) {
          mid.grade = 'easy';
          mid.rest = true;
          return true;
        }
        // すでに岩棚なら、区間内で最も重いセルを1段易しくする
        let worst: Cell | null = null;
        for (let k = segStart + 1; k <= i; k++) {
          if (!worst || rank(path[k].grade) > rank(worst.grade)) worst = path[k];
        }
        if (worst && worst.grade !== 'easy') {
          worst.grade = EASE[worst.grade];
          return true;
        }
        return false;
      }
    }
    return false;
  }

  // --- 岩肌の造形 ---------------------------------------------------------

  /** その法線を向く姿勢 */
  private orientationFor(normal: THREE.Vector3, out = new THREE.Quaternion()): THREE.Quaternion {
    _look.lookAt(_origin, normal, _up);
    return out.setFromRotationMatrix(_look);
  }

  /**
   * 難易度を岩肌の造形として置く。
   * 色ではなく形で伝える (連続した岩壁に見えるように、色は岩質のまま)。
   * セルごとの法線に合わせ、奥行きの半分を岩に埋めて生やす。
   */
  private buildRockDetail(seed: number): void {
    const rng = makeRng(seed + 991);
    const rock = new THREE.Color(0x8d8880);
    const buckets: Record<string, THREE.Matrix4[]> = { block: [], slab: [], bump: [], sliver: [] };
    const q = new THREE.Quaternion();
    const right = new THREE.Vector3();
    const upAxis = new THREE.Vector3();

    for (const cell of this.cells) {
      if (!cell.pos) continue;
      const n = cell.normal;
      this.orientationFor(n, q);
      // 壁面に沿う2軸 (法線に直交)
      right.set(-n.z, 0, n.x).normalize();
      upAxis.crossVectors(n, right).normalize();

      const jitter = (s: number) => (rng() - 0.5) * s;
      const place = (
        kind: keyof typeof buckets,
        du: number,
        dv: number,
        sx: number,
        sy: number,
        sz: number,
      ) => {
        // 奥行きの 45% を岩に埋める。浮いて見えないように
        const p = new THREE.Vector3()
          .copy(cell.pos!)
          .addScaledVector(right, du)
          .addScaledVector(upAxis, dv)
          .addScaledVector(n, sz * 0.05);
        buckets[kind].push(new THREE.Matrix4().compose(p, q, _scale.set(sx, sy, sz)));
      };

      switch (cell.grade) {
        case 'easy':
          if (cell.rest) {
            place('slab', jitter(0.2), -0.08, 1.0 + rng() * 0.35, 0.15, 0.45 + rng() * 0.18);
          }
          place('block', jitter(0.35), jitter(0.3), 0.4 + rng() * 0.18, 0.28 + rng() * 0.12, 0.24 + rng() * 0.1);
          if (rng() < 0.5) place('block', jitter(0.5), jitter(0.4), 0.28 + rng() * 0.12, 0.2, 0.18);
          break;
        case 'medium':
          place('bump', jitter(0.4), jitter(0.4), 0.17 + rng() * 0.07, 0.14 + rng() * 0.06, 0.12 + rng() * 0.05);
          place('bump', jitter(0.45), jitter(0.45), 0.13 + rng() * 0.06, 0.11 + rng() * 0.05, 0.09 + rng() * 0.04);
          if (rng() < 0.4) place('bump', jitter(0.5), jitter(0.5), 0.1, 0.09, 0.07);
          break;
        case 'hard':
          place('sliver', jitter(0.4), jitter(0.25), 0.05 + rng() * 0.03, 0.4 + rng() * 0.28, 0.08 + rng() * 0.04);
          if (rng() < 0.45) place('sliver', jitter(0.45), jitter(0.3), 0.045, 0.18 + rng() * 0.14, 0.06);
          break;
        case 'impossible':
          // ほぼ平滑。何も置かない
          break;
      }
    }

    const geo: Record<string, THREE.BufferGeometry> = {
      block: new THREE.BoxGeometry(1, 1, 1),
      slab: new THREE.BoxGeometry(1, 1, 1),
      bump: new THREE.IcosahedronGeometry(0.5, 0),
      sliver: new THREE.BoxGeometry(1, 1, 1),
    };
    const tint: Record<string, number> = { block: 1.12, slab: 1.18, bump: 1.04, sliver: 0.92 };

    for (const kind of Object.keys(buckets) as (keyof typeof buckets)[]) {
      const list = buckets[kind];
      if (!list.length) continue;
      const mesh = new THREE.InstancedMesh(
        geo[kind],
        new THREE.MeshStandardMaterial({
          color: rock.clone().multiplyScalar(tint[kind]),
          roughness: 1,
          flatShading: true,
        }),
        list.length,
      );
      for (let i = 0; i < list.length; i++) mesh.setMatrixAt(i, list[i]);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this.detailMeshes.push(mesh);
    }
  }

  private buildMarker(color: number, radius: number): THREE.Mesh {
    const m = new THREE.Mesh(
      new THREE.TorusGeometry(radius, 0.045, 8, 22),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false }),
    );
    m.renderOrder = 5;
    return m;
  }

  /** マーカーをそのセルの壁面に貼り付ける */
  private placeMarker(m: THREE.Mesh, cell: Cell): void {
    m.visible = true;
    m.position.copy(cell.pos!).addScaledVector(cell.normal, 0.1);
    this.orientationFor(cell.normal, m.quaternion);
  }

  /** カーソルが指しているセルを示す */
  setHover(cell: Cell | null): void {
    if (!cell?.pos) {
      this.hoverMarker.visible = false;
      return;
    }
    this.placeMarker(this.hoverMarker, cell);
  }

  /** 選んだルートを示す */
  markRoute(cells: Cell[]): void {
    while (this.routeMarkers.length < cells.length) {
      const m = this.buildMarker(0xffd24a, 0.34);
      this.group.add(m);
      this.routeMarkers.push(m);
    }
    for (let i = 0; i < this.routeMarkers.length; i++) {
      const m = this.routeMarkers[i];
      const c = cells[i];
      if (c?.pos) this.placeMarker(m, c);
      else m.visible = false;
    }
  }

  clearMarkers(): void {
    this.setHover(null);
    for (const m of this.routeMarkers) m.visible = false;
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
    for (const m of this.detailMeshes) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    for (const m of [this.hoverMarker, ...this.routeMarkers]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.group.clear();
  }
}

function rank(g: CellGrade): number {
  return { easy: 0, medium: 1, hard: 2, impossible: 3 }[g];
}
