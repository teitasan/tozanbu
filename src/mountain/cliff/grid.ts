/* ===========================================================
   岩壁のグリッド。

   岩壁は内部的に 2D グリッドへ分割し、各セルに登攀難易度を持たせる。
   グリッド自体はプレイヤーに見せない。難易度は地形と登攀中の HUD で伝える。

     Easy       休みやすく消費が少ないセル
     Medium     標準的な消費のセル
     Hard       消費が大きいセル
     Impossible 通れないセル

   手足や個々のホールド位置はゲームロジックでは扱わない。
   =========================================================== */

import type * as THREE from 'three';

export type CellGrade = 'easy' | 'medium' | 'hard' | 'impossible';

export const GRADES: CellGrade[] = ['easy', 'medium', 'hard', 'impossible'];

/** セルへ移動する基礎スタミナ消費。impossible は入れない */
export const GRADE_COST: Record<CellGrade, number> = {
  easy: 4,
  medium: 9,
  hard: 19,
  impossible: Infinity,
};

export const GRADE_LABEL: Record<CellGrade, string> = {
  easy: '易',
  medium: '並',
  hard: '難',
  impossible: '不可',
};

/** 移動方向による倍率。登りが基準、横は少し楽、下りはさらに楽 */
export const DIRECTION_MUL = {
  up: 1,
  lateral: 0.82,
  down: 0.58,
} as const;

/** 1セルの大きさ (m)。身体1つぶんの動きにあたる */
export const CELL_SIZE = 1.25;

export interface Cell {
  col: number;
  row: number;
  grade: CellGrade;
  /** 岩棚。停止してスタミナを回復できる */
  rest: boolean;
  /** 壁面上の座標。取れなかったセルは null (通れない) */
  pos: THREE.Vector3 | null;
  /** その点の壁面法線 (岩から外向き)。造形と表示の向きに使う */
  normal: THREE.Vector3;
  /** 地上から取り付けるセル */
  ground: boolean;
  /** ここから壁の上へ抜けられる */
  topOut: boolean;
}

export function passable(cell: Cell | undefined): cell is Cell {
  return !!cell && cell.pos !== null && cell.grade !== 'impossible';
}

/** 移動方向の倍率 */
export function directionMul(dy: number, dist: number): number {
  const ratio = dy / Math.max(0.01, dist);
  if (ratio > 0.35) return DIRECTION_MUL.up;
  if (ratio < -0.35) return DIRECTION_MUL.down;
  return DIRECTION_MUL.lateral;
}

/**
 * セル間の移動コスト。
 * セル難易度 × 移動方向 + 移動距離。
 */
export function cellMoveCost(from: Cell, to: Cell, distanceCost: number, scale = 1): number {
  if (!from.pos || !to.pos) return Infinity;
  const dist = from.pos.distanceTo(to.pos);
  const dy = to.pos.y - from.pos.y;
  return (GRADE_COST[to.grade] * directionMul(dy, dist) + dist * distanceCost) * scale;
}

/** セルを引ける格子 (岩壁) */
export interface CellGrid {
  cellAt(col: number, row: number): Cell | undefined;
  /** 手の届く距離 (m) */
  reach: number;
}

/** 方向キーで選べる8方向 */
export const AIM_DIRS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 1],
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, -1],
  [-1, 0],
  [-1, 1],
];

/**
 * その方向で試すセルの順番。
 * 隣 → その先 → その先の左右ひとつ分。
 * 隣が平滑でも、同じ方向へ手を伸ばせば越えられることがある。
 */
function scanOrder(sx: number, sy: number): Array<[number, number]> {
  if (sx === 0 || sy === 0) {
    return [
      [sx, sy],
      [sx * 2, sy * 2],
      [sx * 2 + sy, sy * 2 + sx],
      [sx * 2 - sy, sy * 2 - sx],
    ];
  }
  return [
    [sx, sy],
    [sx * 2, sy * 2],
    [sx * 2, sy],
    [sx, sy * 2],
  ];
}

/** 届く範囲にあるセル */
function within(grid: CellGrid, from: Cell, dc: number, dr: number): Cell | undefined {
  if (!from.pos) return undefined;
  const c = grid.cellAt(from.col + dc, from.row + dr);
  if (!c || !c.pos) return undefined;
  return c.pos.distanceTo(from.pos) <= grid.reach ? c : undefined;
}

/**
 * その方向へ一手出したときに掴むセル。
 * 経路探索もこの関数でセルを繋ぐので、
 * 「探索が見つけたルート」と「方向キーで辿れるルート」が一致する。
 */
export function aimedCell(
  grid: CellGrid,
  from: Cell,
  sx: number,
  sy: number,
  distanceCost: number,
  costScale = 1,
): Cell | null {
  if (!from.pos || (sx === 0 && sy === 0)) return null;
  const order = scanOrder(sx, sy);
  // まっすぐ届くならそれを掴む
  for (let i = 0; i < 2; i++) {
    const c = within(grid, from, order[i][0], order[i][1]);
    if (passable(c)) return c;
  }
  // 少しずれた先まで手を伸ばす。同じ方向なので軽い方を採る
  let best: Cell | null = null;
  let bestCost = Infinity;
  for (let i = 2; i < order.length; i++) {
    const c = within(grid, from, order[i][0], order[i][1]);
    if (!passable(c)) continue;
    const cost = cellMoveCost(from, c, distanceCost, costScale);
    if (cost < bestCost) {
      bestCost = cost;
      best = c;
    }
  }
  return best;
}

/** その方向を塞いでいる平滑なセル。塞がれていなければ null */
export function aimBlocker(grid: CellGrid, from: Cell, sx: number, sy: number): Cell | null {
  for (const [dc, dr] of scanOrder(sx, sy)) {
    const c = within(grid, from, dc, dr);
    if (c) return passable(c) ? null : c;
  }
  return null;
}

/** 方向キーひとつで行けるセル全部 */
export function aimNeighbours(
  grid: CellGrid,
  from: Cell,
  distanceCost: number,
  costScale = 1,
): Cell[] {
  const out: Cell[] = [];
  for (const [sx, sy] of AIM_DIRS) {
    const c = aimedCell(grid, from, sx, sy, distanceCost, costScale);
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}
