/* ===========================================================
   山全体の到達可能性チェック (開発用)。

   2通りで探索する。
     walk  : 歩行とマントリングだけ。登攀を使わない
     climb : 岩壁を登ることも許す

   walk だけで山頂に着けてしまう山は、
   「W を押しているだけで登頂できる」山なので、難易度が成立していない。
   岩壁1枚ごとの突破可能ルートは保証しない。
   ここでは壁の上に出られる前提で山体としての連結性を見る。
   =========================================================== */

import { MOVE } from '../core/types';
import type { Mountain } from './Mountain';

export interface ReachabilityReport {
  /** 登攀を使えば山頂に着けるか */
  reachable: boolean;
  /** 歩行とマントリングだけで山頂に着けてしまうか */
  walkOnlyReachable: boolean;
  /** 歩きだけで到達できる最高地点 (m) */
  walkOnlyHighest: number;
  summit: number;
  /** 山頂までに越える必要があった岩壁の数 (最短経路上) */
  climbs: number;
  /** 歩ける面積の割合 */
  walkableRatio: number;
}

/** 探索の解像度 (m) */
const CELL = 4;
/** 1回の登攀で越えられる高さの上限 */
const MAX_CLIMB = 45;
/** これを超える段差は登れない扱い (生成側で出ないようにする) */

interface Flood {
  reached: boolean;
  highest: number;
  climbs: number;
}

function flood(mountain: Mountain, allowClimb: boolean): Flood {
  const f = mountain.field;
  const n = Math.floor(f.size / CELL);
  const toX = (i: number) => -f.half + i * CELL;
  const toZ = (j: number) => -f.half + j * CELL;
  const idx = (i: number, j: number) => j * n + i;

  const visited = new Uint8Array(n * n);
  const climbCount = new Int16Array(n * n).fill(-1);

  const start = idx(
    Math.round((f.trailhead.x + f.half) / CELL),
    Math.round((f.trailhead.z + f.half) / CELL),
  );
  const goal = idx(
    Math.round((f.summit.x + f.half) / CELL),
    Math.round((f.summit.z + f.half) / CELL),
  );

  const queue: number[] = [start];
  visited[start] = 1;
  climbCount[start] = 0;
  let highest = f.trailhead.y;

  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ];
  const maxStep = CELL * Math.tan(MOVE.maxWalkSlope);

  while (queue.length) {
    const cur = queue.shift()!;
    const cj = Math.floor(cur / n);
    const ci = cur - cj * n;
    const cx = toX(ci);
    const cz = toZ(cj);
    const ch = f.heightAt(cx, cz);
    if (ch > highest) highest = ch;

    for (const [di, dj] of dirs) {
      const ni = ci + di;
      const nj = cj + dj;
      if (ni < 1 || nj < 1 || ni >= n - 1 || nj >= n - 1) continue;
      const key = idx(ni, nj);
      if (visited[key]) continue;
      const nx = toX(ni);
      const nz = toZ(nj);
      if (!f.inside(nx, nz)) continue;
      const nh = f.heightAt(nx, nz);
      const dh = nh - ch;
      const slope = f.slopeAt(nx, nz);

      let climbs = climbCount[cur];
      if (dh <= maxStep && slope <= MOVE.maxWalkSlope) {
        // 歩ける
      } else if (dh <= MOVE.mantleMax && slope <= MOVE.maxWalkSlope) {
        // マントリングで越えられる段差 (上が乗れる面であること)
      } else if (dh <= 0) {
        // 下りは進める (落ちてもよい)
      } else if (allowClimb && dh <= MAX_CLIMB) {
        // マントリングで越えられない段差は壁。
        // 目標セルの斜度ではなく段差そのもので判定する
        // (上面が平らな岩塔は、横は壁でも斜度が緩く出るため)
        climbs += 1;
      } else {
        continue;
      }

      visited[key] = 1;
      climbCount[key] = climbs;
      queue.push(key);
    }
  }

  return {
    reached: visited[goal] === 1,
    highest,
    climbs: climbCount[goal] >= 0 ? climbCount[goal] : -1,
  };
}

export function checkReachability(mountain: Mountain): ReachabilityReport {
  const f = mountain.field;
  const withClimb = flood(mountain, true);
  const walkOnly = flood(mountain, false);

  // 歩ける面積の割合
  let walkable = 0;
  let total = 0;
  for (let j = 4; j < f.n - 4; j += 3) {
    for (let i = 4; i < f.n - 4; i += 3) {
      const x = -f.half + i * f.step;
      const z = -f.half + j * f.step;
      if (Math.hypot(x - f.summit.x, z - f.summit.z) > mountain.profile.radius) continue;
      total++;
      if (f.slopeAt(x, z) <= MOVE.maxWalkSlope) walkable++;
    }
  }

  return {
    reachable: withClimb.reached,
    walkOnlyReachable: walkOnly.reached,
    walkOnlyHighest: walkOnly.highest,
    summit: f.summit.y,
    climbs: withClimb.climbs,
    walkableRatio: total ? walkable / total : 0,
  };
}
