/* 開発用: seed・難易度を変えて地形図を確認する */

import { difficultyProfile, type DifficultyLevel } from './mountain/difficulty';
import { Heightfield } from './mountain/Heightfield';
import { TopoMap } from './mountain/TopoMap';

const seedEl = document.getElementById('seed') as HTMLInputElement;
const diffEl = document.getElementById('diff') as HTMLSelectElement;
const genBtn = document.getElementById('gen') as HTMLButtonElement;
const statsEl = document.getElementById('stats')!;
const stage = document.getElementById('stage')!;

let mapCanvas: HTMLCanvasElement | null = null;

function render(): void {
  const seed = (Number(seedEl.value) || 0) >>> 0;
  const level = Number(diffEl.value) as DifficultyLevel;
  const profile = difficultyProfile(level);
  const t0 = performance.now();
  const field = new Heightfield(seed, profile);
  const map = new TopoMap(field, profile, 900);
  const ms = (performance.now() - t0).toFixed(0);

  if (mapCanvas) mapCanvas.remove();
  mapCanvas = map.canvas;
  stage.appendChild(mapCanvas);

  const sk = field.skeleton;
  statsEl.textContent =
    `生成 ${ms}ms · 山頂 ${Math.round(field.summit.y)}m @ (${Math.round(field.summit.x)}, ${Math.round(field.summit.z)}) · ` +
    `登山口 (${Math.round(field.trailhead.x)}, ${Math.round(field.trailhead.z)}) · ` +
    `副峰 ${field.secondaryPeaks.length} · 稜 ${sk.ridges.length} · 谷 ${sk.valleys.length} · 鞍部 ${sk.saddles.length} · ` +
    `格子 ${field.n}×${field.n} @ ${field.step}m (${field.size}m 四方)`;
}

genBtn.addEventListener('click', render);
seedEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') render();
});
diffEl.addEventListener('change', render);
render();
