/* ===========================================================
   登攀ルートの到達可能性ソルバ。

   岩壁のホールドをグラフとして扱い、
   「スタート -> トップアウト」の突破可能ルートが存在するかを検査する。
   生成直後にこれを走らせ、成立しない壁は補修する。
   正解ルート自体はプレイヤーには見せない。
   =========================================================== */

import type * as THREE from 'three';
import type { HoldType } from '../../core/types';

/** ソルバが必要とする最小のホールド情報 (生成中の素データでも Hold でも良い) */
export interface SolvableHold {
  id: string;
  type: HoldType;
  position: THREE.Vector3;
  baseStaminaCost: number;
}

export interface SolverInput {
  holds: SolvableHold[];
  /** 到達可能距離 */
  reach: number;
  /** 距離1あたりの追加スタミナ */
  distanceCost: number;
  /** スタート候補 (地上から取り付けるホールド) */
  starts: SolvableHold[];
  /** ゴール候補 (トップアウトできるホールド) */
  goals: SolvableHold[];
  /** 使えるスタミナ */
  maxStamina: number;
  /** ロープなどによるコスト倍率 */
  costScale?: number;
}

export interface SolverResult {
  feasible: boolean;
  /** 休憩(ledge)を挟んで到達できるルート */
  path: string[];
  /** そのルートの総消費 */
  totalCost: number;
  /** ledge から ledge までの区間の最大消費 */
  maxSegment: number;
  /** 上に繋がらない行き止まりホールド */
  deadEnds: string[];
}

export function moveCost(
  from: SolvableHold,
  to: SolvableHold,
  distanceCost: number,
  scale = 1,
): number {
  return (to.baseStaminaCost + from.position.distanceTo(to.position) * distanceCost) * scale;
}

interface Edge {
  to: number;
  cost: number;
}

function buildGraph(
  holds: SolvableHold[],
  reach: number,
  distanceCost: number,
  scale: number,
): Edge[][] {
  const graph: Edge[][] = holds.map(() => []);
  for (let i = 0; i < holds.length; i++) {
    for (let j = 0; j < holds.length; j++) {
      if (i === j) continue;
      const d = holds[i].position.distanceTo(holds[j].position);
      if (d <= reach) graph[i].push({ to: j, cost: moveCost(holds[i], holds[j], distanceCost, scale) });
    }
  }
  return graph;
}

/**
 * ledge に着いたら「直近の ledge からの消費」が 0 に戻るモデルで、
 * どのスタート -> どのゴールへ到達できるかを調べる。
 * ledge のリセットで前任者がループし得るので、経路そのものを保持する。
 */
export function solveRoute(input: SolverInput): SolverResult {
  const { holds, reach, distanceCost, maxStamina } = input;
  const scale = input.costScale ?? 1;
  const graph = buildGraph(holds, reach, distanceCost, scale);
  const indexOf = new Map(holds.map((h, i) => [h, i]));
  const goalSet = new Set(input.goals.map((h) => indexOf.get(h)!));

  const label = holds.map(() => Infinity);
  const path: (string[] | null)[] = holds.map(() => null);
  const queue: number[] = [];
  for (const s of input.starts) {
    const i = indexOf.get(s);
    if (i === undefined) continue;
    label[i] = 0;
    path[i] = [s.id];
    queue.push(i);
  }

  let guard = 0;
  while (queue.length && guard++ < 400000) {
    const u = queue.shift()!;
    if (goalSet.has(u)) continue;
    const basePath = path[u]!;
    for (const e of graph[u]) {
      const after = label[u] + e.cost;
      if (after > maxStamina) continue;
      const next = holds[e.to];
      const value = next.type === 'ledge' ? 0 : after;
      if (value < label[e.to] - 1e-9 && !basePath.includes(next.id)) {
        label[e.to] = value;
        path[e.to] = [...basePath, next.id];
        queue.push(e.to);
      }
    }
  }

  let best: { idx: number; cost: number } | null = null;
  for (const g of goalSet) {
    if (path[g] === null) continue;
    if (!best || label[g] < best.cost) best = { idx: g, cost: label[g] };
  }

  const deadEnds: string[] = [];
  for (let i = 0; i < holds.length; i++) {
    if (goalSet.has(i)) continue;
    const up = graph[i].some((e) => holds[e.to].position.y > holds[i].position.y + 0.15);
    if (!up) deadEnds.push(holds[i].id);
  }

  if (!best) {
    return { feasible: false, path: [], totalCost: 0, maxSegment: Infinity, deadEnds };
  }

  const idPath = path[best.idx]!;
  const byId = new Map(holds.map((h) => [h.id, h]));
  let total = 0;
  let segment = 0;
  let maxSegment = 0;
  for (let i = 1; i < idPath.length; i++) {
    const a = byId.get(idPath[i - 1])!;
    const b = byId.get(idPath[i])!;
    const c = moveCost(a, b, distanceCost, scale);
    total += c;
    segment += c;
    maxSegment = Math.max(maxSegment, segment);
    if (b.type === 'ledge') segment = 0;
  }
  return { feasible: true, path: idPath, totalCost: total, maxSegment, deadEnds };
}
