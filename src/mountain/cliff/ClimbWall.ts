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
import { clamp, clamp01, smoothstep } from '../../core/math';
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
  private overlay: THREE.Mesh | null = null;
  /** 岩肌の「登りやすさ」の連続場。難易度もテクスチャもここから作る */
  private quality: (u: number, v: number) => number = () => 0;
  /** 素のノイズ。テクスチャの粒はこちらで作る (fbm より軽い) */
  private noise: ReturnType<typeof makeNoise2D> = makeNoise2D(1);
  private qEasy = 0;
  private qMedium = 0;
  private qHard = 0;

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

    this.buildSurfaceOverlay(surface.rockKind.color);
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
    // 縦に伸びるクラック帯と横に走る岩棚帯ができるよう、u と v でスケールを変える。
    // 岩肌のテクスチャもこの同じ場から焼くので、見た目と難易度が必ず一致し、
    // かつ連続なのでセルの境目が見えない (グリッドは見せない)
    this.quality = (u: number, v: number): number => {
      const streak = fbm(noise, u * 0.42, v * 0.14, 3); // 縦に伸びる筋
      const band = fbm(noise, u * 0.09 + 31.7, v * 0.55, 2); // 横に走る帯
      const grain = noise(u * 1.7, v * 1.6) * 0.25;
      return streak * 0.62 + band * 0.5 + grain;
    };
    const quality = this.quality;
    this.noise = noise;

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
    // 難易度の境目にあたる quality の値。テクスチャを同じ境目で変化させる
    const at = (r: number) => quals[order[clamp(r, 0, total - 1) | 0]];
    this.qEasy = at(nEasy);
    this.qMedium = at(nEasy + nMedium);
    this.qHard = at(nEasy + nMedium + nHard);

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
  /**
   * 岩肌の見た目。
   *
   * 突起をジオメトリで生やすと壁から浮いて見えるので、
   * 壁面にぴったり沿う薄いメッシュを1枚張り、
   * 難易度を「色」と「ノーマルマップ」だけで表現する。
   * どちらも難易度を決めているのと同じ連続場から焼くので、
   * 見た目と難易度が一致し、セルの境目も見えない。
   */
  private buildSurfaceOverlay(rockColor: THREE.Color): void {
    const f = this.frame;
    // セル1つに頂点1つ。細かい凹凸はノーマルマップが持つので、
    // メッシュは壁の形に沿うだけでよい
    const sub = 1;
    const nx = this.cols * sub;
    const ny = this.rows * sub;
    const vertCount = (nx + 1) * (ny + 1);
    const positions = new Float32Array(vertCount * 3);
    const normals = new Float32Array(vertCount * 3);
    const uvs = new Float32Array(vertCount * 2);
    const valid = new Uint8Array(vertCount);

    const p = new THREE.Vector3();
    const n = new THREE.Vector3();
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i <= nx; i++) {
        const idx = j * (nx + 1) + i;
        const u = -f.halfWidth + (i / nx) * f.halfWidth * 2;
        const v = (j / ny) * f.height;
        const found = this.surfacePoint(u, Math.max(0.05, Math.min(f.height - 0.05, v)), p);
        if (found) {
          this.surfaceNormal(p, n);
          // 岩肌のすぐ手前に置く。奥に入れると地形に食われる
          positions[idx * 3] = p.x + n.x * 0.05;
          positions[idx * 3 + 1] = p.y + n.y * 0.05;
          positions[idx * 3 + 2] = p.z + n.z * 0.05;
          normals[idx * 3] = n.x;
          normals[idx * 3 + 1] = n.y;
          normals[idx * 3 + 2] = n.z;
          valid[idx] = 1;
        }
        uvs[idx * 2] = i / nx;
        uvs[idx * 2 + 1] = j / ny;
      }
    }

    const index: number[] = [];
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const a = j * (nx + 1) + i;
        const b = a + 1;
        const c = a + (nx + 1);
        const d = c + 1;
        // 壁面が取れなかった所は張らない
        if (!valid[a] || !valid[b] || !valid[c] || !valid[d]) continue;
        index.push(a, c, b, b, c, d);
      }
    }
    if (index.length === 0) return;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(index);
    geo.computeBoundingSphere();

    const { color, normalMap } = this.bakeRockTexture(rockColor);
    const mat = new THREE.MeshStandardMaterial({
      map: color,
      normalMap,
      normalScale: new THREE.Vector2(1.6, 1.6),
      transparent: true,
      roughness: 1,
      metalness: 0,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.renderOrder = 1;
    this.overlay = mesh;
    this.group.add(mesh);
  }

  /**
   * 岩肌のカラーとノーマルを焼く。
   * 難易度と同じ quality 場から作るので、
   *   高い = 大きな瘤が寄り集まった凹凸 (登りやすい)
   *   中   = 細かい粒
   *   低い = 縦に走る細い溝だけ
   *   最低 = ほぼ平滑
   * となり、見ただけで難易度が読める。
   */
  private bakeRockTexture(rockColor: THREE.Color): {
    color: THREE.CanvasTexture;
    normalMap: THREE.CanvasTexture;
  } {
    const f = this.frame;
    // 1m あたりのピクセル。細部はノーマルマップの陰影で見せるので、
    // 解像度を上げるより焼き時間を抑えるほうが効く
    const px = 4;
    const w = Math.max(32, Math.min(128, Math.round(f.halfWidth * 2 * px)));
    const h = Math.max(32, Math.min(128, Math.round(f.height * px)));

    const relief = new Float32Array(w * h);
    const uAt = (i: number) => -f.halfWidth + ((i + 0.5) / w) * f.halfWidth * 2;
    const vAt = (j: number) => ((j + 0.5) / h) * f.height;

    // 1) 起伏を作る
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const u = uAt(i);
        const v = vAt(j);
        const q = this.quality(u, v);
        // 難易度帯ごとの重み (境目はなめらか)
        const wEasy = smoothstep(this.qMedium, this.qEasy, q);
        const wHard = 1 - smoothstep(this.qHard, this.qMedium, q);
        const wBlank = 1 - smoothstep(this.qHard - 0.12, this.qHard, q);

        // 粒や溝は素のノイズで作る。fbm を何度も呼ぶと焼くのに時間がかかる
        const blob = Math.max(0, this.noise(u * 1.1 + 11.3, v * 1.1 - 7.7));
        const grain = this.noise(u * 6.0 - 3.1, v * 6.0 + 5.2) * 0.5;
        const groove = Math.abs(this.noise(u * 7.0 + 21.0, v * 0.7));

        let r = 0.5 + grain * 0.35;
        r += wEasy * blob * 1.5;
        r -= wHard * (1 - Math.min(1, groove * 5)) * 0.55;
        r = 0.5 + (r - 0.5) * (1 - wBlank * 0.85); // 平滑帯は起伏を潰す
        relief[j * w + i] = r;
      }
    }

    // 2) カラー: 岩質の色に起伏ぶんの明暗だけ乗せる
    const colorCanvas = document.createElement('canvas');
    colorCanvas.width = w;
    colorCanvas.height = h;
    const cctx = colorCanvas.getContext('2d')!;
    const cimg = cctx.createImageData(w, h);
    const edge = 0.1; // 縁をなじませる幅 (0..0.5)
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const k = j * w + i;
        const r = relief[k];
        const shade = 0.78 + clamp01(r) * 0.42;
        const fu = (i + 0.5) / w;
        const fv = (j + 0.5) / h;
        const fade =
          smoothstep(0, edge, fu) *
          smoothstep(0, edge, 1 - fu) *
          smoothstep(0, edge * 0.6, fv) *
          smoothstep(0, edge * 0.6, 1 - fv);
        cimg.data[k * 4] = clamp01(rockColor.r * shade) * 255;
        cimg.data[k * 4 + 1] = clamp01(rockColor.g * shade) * 255;
        cimg.data[k * 4 + 2] = clamp01(rockColor.b * shade) * 255;
        cimg.data[k * 4 + 3] = fade * 255;
      }
    }
    cctx.putImageData(cimg, 0, 0);

    // 3) ノーマル: 起伏の勾配から作る。これで突起が無くても凹凸に見える
    const normalCanvas = document.createElement('canvas');
    normalCanvas.width = w;
    normalCanvas.height = h;
    const nctx = normalCanvas.getContext('2d')!;
    const nimg = nctx.createImageData(w, h);
    const at = (i: number, j: number) =>
      relief[Math.min(h - 1, Math.max(0, j)) * w + Math.min(w - 1, Math.max(0, i))];
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const k = j * w + i;
        const dx = (at(i + 1, j) - at(i - 1, j)) * 2.2;
        const dy = (at(i, j + 1) - at(i, j - 1)) * 2.2;
        const len = Math.hypot(-dx, -dy, 1);
        nimg.data[k * 4] = ((-dx / len) * 0.5 + 0.5) * 255;
        nimg.data[k * 4 + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
        nimg.data[k * 4 + 2] = (1 / len) * 0.5 * 255 + 127;
        nimg.data[k * 4 + 3] = 255;
      }
    }
    nctx.putImageData(nimg, 0, 0);

    const color = new THREE.CanvasTexture(colorCanvas);
    color.colorSpace = THREE.SRGBColorSpace;
    const normalMap = new THREE.CanvasTexture(normalCanvas);
    for (const t of [color, normalMap]) {
      t.wrapS = THREE.ClampToEdgeWrapping;
      t.wrapT = THREE.ClampToEdgeWrapping;
      t.needsUpdate = true;
    }
    return { color, normalMap };
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
    if (this.overlay) {
      this.overlay.geometry.dispose();
      const mat = this.overlay.material as THREE.MeshStandardMaterial;
      mat.map?.dispose();
      mat.normalMap?.dispose();
      mat.dispose();
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
