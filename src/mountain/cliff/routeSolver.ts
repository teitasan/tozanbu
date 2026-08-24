/* ===========================================================
   岩壁のグリッド経路探索。

   「地上から取り付けるセル」から「壁の上へ抜けられるセル」まで、
   スタミナの範囲で辿り着けるかを調べる。
   岩棚に着いたら消費は 0 に戻る (そこで休めるため)。

   生成直後にこれを走らせ、成立しない壁は補修する。
   正解ルート自体はプレイヤーには見せない。
   =========================================================== */

import { aimNeighbours, cellMoveCost, passable, type Cell, type CellGrid } from './grid';

export interface SolverInput {
  cells: Cell[];
  grid: CellGrid;
  distanceCost: number;
  maxStamina: number;
  /** ロープなどによるコスト倍率 */
  costScale?: number;
}

export interface SolverResult {
  feasible: boolean;
  /** 辿れるルート (セル) */
  path: Cell[];
  totalCost: number;
  /** 岩棚から岩棚までの区間の最大消費 */
  maxSegment: number;
}

/**
 * 隣接表をまとめて作る (何度も解くので使い回す)。
 * 繋ぎ方は方向キー1回で行けるセルだけ。
 * 探索が見つけたルートは、そのまま操作で辿れるものになる。
 */
export function buildAdjacency(
  grid: CellGrid,
  cells: Cell[],
  distanceCost: number,
  costScale = 1,
): Map<Cell, Cell[]> {
  const map = new Map<Cell, Cell[]>();
  for (const c of cells) {
    if (!passable(c)) continue;
    map.set(c, aimNeighbours(grid, c, distanceCost, costScale));
  }
  return map;
}

/**
 * 「直近の岩棚からの消費」を最小化しながら広げる。
 * 岩棚に着いたら 0 に戻るので、経路そのものを持って循環を避ける。
 */
export function solveRoute(input: SolverInput): SolverResult {
  const { cells, grid, distanceCost, maxStamina } = input;
  const scale = input.costScale ?? 1;
  const adjacency = buildAdjacency(grid, cells, distanceCost, scale);
  const starts = cells.filter((c) => c.ground && passable(c));
  const goals = new Set(cells.filter((c) => c.topOut && passable(c)));

  const label = new Map<Cell, number>();
  const path = new Map<Cell, Cell[]>();
  const queue: Cell[] = [];
  for (const s of starts) {
    label.set(s, 0);
    path.set(s, [s]);
    queue.push(s);
  }

  let guard = 0;
  while (queue.length && guard++ < 300000) {
    const cur = queue.shift()!;
    if (goals.has(cur)) continue;
    const base = path.get(cur)!;
    const spent = label.get(cur)!;
    for (const next of adjacency.get(cur) ?? []) {
      const after = spent + cellMoveCost(cur, next, distanceCost, scale);
      if (after > maxStamina) continue;
      const value = next.rest ? 0 : after;
      if (value < (label.get(next) ?? Infinity) - 1e-9 && !base.includes(next)) {
        label.set(next, value);
        path.set(next, [...base, next]);
        queue.push(next);
      }
    }
  }

  let best: Cell | null = null;
  let bestValue = Infinity;
  for (const g of goals) {
    const v = label.get(g);
    if (v === undefined) continue;
    if (v < bestValue) {
      bestValue = v;
      best = g;
    }
  }
  if (!best) return { feasible: false, path: [], totalCost: 0, maxSegment: Infinity };

  const route = path.get(best)!;
  let total = 0;
  let segment = 0;
  let maxSegment = 0;
  for (let i = 1; i < route.length; i++) {
    const c = cellMoveCost(route[i - 1], route[i], distanceCost, scale);
    total += c;
    segment += c;
    maxSegment = Math.max(maxSegment, segment);
    if (route[i].rest) segment = 0;
  }
  return { feasible: true, path: route, totalCost: total, maxSegment };
}

/** コストを無視した連結性 (補修でどこが切れているかを見る) */
export function reachableSet(
  grid: CellGrid,
  cells: Cell[],
  distanceCost: number,
  from: Cell[],
): Set<Cell> {
  const adjacency = buildAdjacency(grid, cells, distanceCost);
  const seen = new Set<Cell>(from);
  const queue = [...from];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const n of adjacency.get(cur) ?? []) {
      if (seen.has(n)) continue;
      seen.add(n);
      queue.push(n);
    }
  }
  return seen;
}
