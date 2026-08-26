/* 地形生成テスト本体 (vite-node で実行) */

import { difficultyProfile } from '../src/mountain/difficulty';
import { Heightfield } from '../src/mountain/Heightfield';
import { Mountain, newRecord } from '../src/mountain/Mountain';
import { checkReachability } from '../src/mountain/reachability';
import { MOVE } from '../src/core/types';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  const mark = ok ? 'ok  ' : 'FAIL';
  if (!ok) failures++;
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ''}`);
}

const seeds = [1, 42, 12345, 99991, 7777777];
const levels = [1, 2, 3, 4, 5] as const;

console.log('--- 決定論性 ---');
{
  const a = new Heightfield(4242, difficultyProfile(3));
  const b = new Heightfield(4242, difficultyProfile(3));
  check('同一 seed で標高一致', a.height[1000] === b.height[1000] && a.summit.y === b.summit.y);
}

console.log('--- 骨格メトリクス (難易度3) ---');
for (const seed of seeds) {
  const f = new Heightfield(seed, difficultyProfile(3));
  const offCenter = Math.hypot(f.skeleton.peaks[0].x, f.skeleton.peaks[0].z);
  check(`seed ${seed}: 主峰が中心から離れている`, offCenter > 40, `${offCenter.toFixed(0)}m`);
  check(`seed ${seed}: 副峰または稜が存在`, f.skeleton.peaks.length >= 3 && f.skeleton.ridges.length >= 3);
  check(`seed ${seed}: 谷が存在`, f.skeleton.valleys.length >= 1);
  check(`seed ${seed}: 鞍部が存在`, f.skeleton.saddles.length >= 1);
  check(`seed ${seed}: 地図に載せる副峰が存在`, f.secondaryPeaks.length >= 1);
}

console.log('--- 前山・外周起伏 (難易度3) ---');
for (const seed of seeds) {
  const f = new Heightfield(seed, difficultyProfile(3));
  const profile = f.profile;
  const outerHeights: number[] = [];
  const outerSlopes: number[] = [];
  const innerR = profile.radius * 0.74;
  const outerR = f.half - 70;
  for (let k = 0; k < 96; k++) {
    const a = (k / 96) * Math.PI * 2;
    const ringT = 0.25 + ((k * 17) % 61) / 80;
    const r = innerR + (outerR - innerR) * ringT;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    if (!f.inside(x, z)) continue;
    outerHeights.push(f.heightAt(x, z));
    outerSlopes.push(f.slopeAt(x, z));
  }
  const minH = Math.min(...outerHeights);
  const maxH = Math.max(...outerHeights);
  const rangeH = maxH - minH;
  const meanH = outerHeights.reduce((a, b) => a + b, 0) / outerHeights.length;
  const minSlopeDeg = (2 * Math.PI) / 180;
  const slopeFrac =
    outerSlopes.filter((s) => s >= minSlopeDeg).length / Math.max(1, outerSlopes.length);
  check(
    `seed ${seed}: 外周帯に標高のばらつき`,
    rangeH >= 8,
    `range=${rangeH.toFixed(1)}m min=${minH.toFixed(1)}m max=${maxH.toFixed(1)}m`,
  );
  check(
    `seed ${seed}: 外周が完全な平坦帯ではない`,
    maxH >= 4.5 && meanH >= 2.2,
    `mean=${meanH.toFixed(1)}m`,
  );
  check(
    `seed ${seed}: 外周リングに傾斜が分布`,
    slopeFrac >= 0.2,
    `${(slopeFrac * 100).toFixed(0)}% が 2° 以上`,
  );
  check(`seed ${seed}: 前山骨格が存在`, f.skeleton.foothillRidges.length >= 2 && f.skeleton.foothillValleys.length >= 2);

  const th = f.trailhead;
  const thSlope = f.slopeAt(th.x, th.z);
  check(
    `seed ${seed}: 登山口は歩き出せる`,
    thSlope <= MOVE.maxWalkSlope * 1.08,
    `slope=${((thSlope / Math.PI) * 180).toFixed(1)}° h=${th.y.toFixed(1)}m`,
  );
  check(
    `seed ${seed}: 登山口は低地`,
    th.y <= profile.peakHeight * 0.24,
    `${th.y.toFixed(1)}m / peak ${profile.peakHeight}m`,
  );

  const awayA = Math.atan2(
    f.skeleton.peaks[0].z - th.z,
    f.skeleton.peaks[0].x - th.x,
  );
  const probeHeights: number[] = [];
  for (let d = 140; d <= 460; d += 35) {
    const px = th.x + Math.cos(awayA) * d;
    const pz = th.z + Math.sin(awayA) * d;
    if (!f.inside(px, pz)) continue;
    probeHeights.push(f.heightAt(px, pz));
  }
  const probeRange =
    probeHeights.length >= 3
      ? Math.max(...probeHeights) - Math.min(...probeHeights)
      : 0;
  check(
    `seed ${seed}: 登山口から数百 m 先にも起伏`,
    probeRange >= 4,
    `range=${probeRange.toFixed(1)}m (${probeHeights.length} 点)`,
  );
}

console.log('--- 到達可能性 (登攀あり) ---');
for (const level of levels) {
  for (const seed of seeds.slice(0, 3)) {
    const record = newRecord(seed, level);
    const mountain = await Mountain.create(record);
    const rep = checkReachability(mountain);
    check(`L${level} seed ${seed}: 山頂到達可能`, rep.reachable, `walkOnly=${rep.walkOnlyReachable}`);
    if (level >= 3) {
      check(`L${level} seed ${seed}: 歩行のみ登頂不可`, !rep.walkOnlyReachable, `最高=${rep.walkOnlyHighest.toFixed(0)}m`);
    }
    mountain.dispose();
  }
}

if (failures) {
  console.error(`\n${failures} 件失敗`);
  process.exit(1);
}
console.log('\nすべて OK');
