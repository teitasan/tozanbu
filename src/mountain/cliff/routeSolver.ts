/* ===========================================================
   岩壁のグリッド経路探索。

   「地上から取り付けるセル」から「壁の上へ抜けられるセル」まで、
   スタミナの範囲で辿り着けるかを調べる。
   岩棚に着いたら消費は 0 に戻る (そこで休めるため)。

   生成直後にこれを走らせ、成立しない壁は補修する。
   正解ルート自体はプレイヤーには見せない。
   =========================================================== */

import { cellMoveCost, passable, type Cell } from './grid';

export interface SolverInput {
  cells: Cell[];
  /** 隣接判定に使う到達距離 (m) */
  reach: number;
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

/** そのセルから届くセル */
export function neighbours(cells: Cell[], from: Cell, reach: number): Cell[] {
  const out: Cell[] = [];
  if (!from.pos) return out;
  for (const c of cells) {
    if (c === from || !passable(c)) continue;
    if (from.pos.distanceTo(c.pos!) <= reach) out.push(c);
  }
  return out;
}

/** 隣接表をまとめて作る (何度も解くので使い回す) */
export function buildAdjacency(cells: Cell[], reach: number): Map<Cell, Cell[]> {
  const map = new Map<Cell, Cell[]>();
  const usable = cells.filter(passable);
  for (const c of usable) map.set(c, []);
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const a = usable[i];
      const b = usable[j];
      if (a.pos!.distanceTo(b.pos!) <= reach) {
        map.get(a)!.push(b);
        map.get(b)!.push(a);
      }
    }
  }
  return map;
}

/**
 * 「直近の岩棚からの消費」を最小化しながら広げる。
 * 岩棚に着いたら 0 に戻るので、経路そのものを持って循環を避ける。
 */
export function solveRoute(input: SolverInput): SolverResult {
  const { cells, reach, distanceCost, maxStamina } = input;
  const scale = input.costScale ?? 1;
  const adjacency = buildAdjacency(cells, reach);
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
export function reachableSet(cells: Cell[], reach: number, from: Cell[]): Set<Cell> {
  const adjacency = buildAdjacency(cells, reach);
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
