/* ===========================================================
   岩壁のグリッド。

   岩壁は内部的に 2D グリッドへ分割し、各セルに登攀難易度を持たせる。
   グリッド自体はプレイヤーに見せない。難易度は岩肌の見た目で伝える。

     Easy       大きな突起、岩棚
     Medium     小さな突起、凹凸
     Hard       細いクラック、小さなエッジ
     Impossible ほぼ平滑な岩壁 (通れない)

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
