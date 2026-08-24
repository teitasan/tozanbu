/* ===========================================================
   タイトル / 山選択。
   Seed と難易度から Mountain ID が決まる。
   記録済みの山を選べば、同じ地形にもう一度登れる。
   =========================================================== */

import { DIFFICULTY_LEVELS, difficultyProfile, type DifficultyLevel } from '../mountain/difficulty';
import { mountainId, type MountainRecord } from '../mountain/Mountain';
import type { MountainRegistry } from '../mountain/MountainRegistry';
import { escapeHtml } from './HUD';

const PREF_KEY = 'tozanbu.pref.v1';

export interface StartConfig {
  playerName: string;
  seed: number;
  difficulty: DifficultyLevel;
  room: string;
}

interface Pref {
  name: string;
  difficulty: DifficultyLevel;
  room: string;
}

function loadPref(): Pref {
  try {
    const p = JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}') as Partial<Pref>;
    return {
      name: p.name ?? '登山者',
      difficulty: (p.difficulty ?? 2) as DifficultyLevel,
      room: p.room ?? '',
    };
  } catch {
    return { name: '登山者', difficulty: 2, room: '' };
  }
}

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`UI要素が見つかりません: #${id}`);
  return found as T;
}

export class TitleScreen {
  private readonly root = el('title');
  private readonly nameInput = el<HTMLInputElement>('player-name');
  private readonly seedInput = el<HTMLInputElement>('seed-input');
  private readonly randomBtn = el<HTMLButtonElement>('seed-random');
  private readonly diffRow = el('difficulty-row');
  private readonly roomInput = el<HTMLInputElement>('room-input');
  private readonly previewId = el('preview-id');
  private readonly previewState = el('preview-state');
  private readonly startBtn = el<HTMLButtonElement>('start-btn');
  private readonly recordsList = el('records-list');

  private difficulty: DifficultyLevel;
  private records = new Map<string, MountainRecord>();

  onStart: ((cfg: StartConfig) => void) | null = null;

  constructor(private readonly registry: MountainRegistry) {
    const pref = loadPref();
    this.nameInput.value = pref.name;
    this.roomInput.value = pref.room;
    this.difficulty = pref.difficulty;
    this.seedInput.value = String(randomSeed());

    for (const level of DIFFICULTY_LEVELS) {
      const p = difficultyProfile(level);
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = `${level} ${p.label}`;
      b.title = p.summary;
      b.addEventListener('click', () => {
        this.difficulty = level;
        this.syncDifficulty();
        void this.refreshPreview();
      });
      this.diffRow.appendChild(b);
    }
    this.syncDifficulty();

    this.randomBtn.addEventListener('click', () => {
      this.seedInput.value = String(randomSeed());
      void this.refreshPreview();
    });
    this.seedInput.addEventListener('input', () => void this.refreshPreview());
    this.startBtn.addEventListener('click', () => this.start());

    void this.refreshPreview();
    void this.refreshRecords();
  }

  private syncDifficulty(): void {
    [...this.diffRow.children].forEach((b, i) => {
      b.classList.toggle('on', DIFFICULTY_LEVELS[i] === this.difficulty);
    });
  }

  private get seed(): number {
    const raw = this.seedInput.value.trim();
    const n = Number(raw);
    if (Number.isFinite(n) && raw !== '') return Math.abs(Math.floor(n)) >>> 0;
    // 数字でなければ文字列から作る
    let h = 2166136261 >>> 0;
    for (let i = 0; i < raw.length; i++) {
      h ^= raw.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  private async refreshPreview(): Promise<void> {
    const id = mountainId(this.seed, this.difficulty);
    this.previewId.textContent = id;
    const known = this.records.get(id) ?? (await this.registry.get(this.seed, this.difficulty));
    if (known.firstAscentAt) {
      this.previewState.textContent = `${known.name ?? id}（登頂 ${known.ascents}）`;
      this.previewState.style.color = 'var(--text)';
    } else {
      this.previewState.textContent = '未踏峰';
      this.previewState.style.color = 'var(--gold)';
    }
  }

  async refreshRecords(): Promise<void> {
    const list = await this.registry.list();
    this.records = new Map(list.map((r) => [r.id, r]));
    if (list.length === 0) {
      this.recordsList.innerHTML = '<div class="rm">まだ記録がない。最初の登頂者になれる。</div>';
      return;
    }
    this.recordsList.innerHTML = '';
    for (const r of list) {
      const div = document.createElement('div');
      div.className = 'record';
      const when = r.firstAscentAt ? new Date(r.firstAscentAt).toLocaleDateString('ja-JP') : '-';
      div.innerHTML =
        `<span class="rn">${escapeHtml(r.name ?? '未踏峰')}</span>` +
        `<span>${escapeHtml(String(r.difficulty))}級 / 登頂 ${r.ascents}</span>` +
        `<span class="rm">${r.id} ・ 初登頂 ${escapeHtml(r.firstAscentBy ?? '-')} (${when})</span>`;
      div.addEventListener('click', () => {
        this.seedInput.value = String(r.seed);
        this.difficulty = r.difficulty;
        this.syncDifficulty();
        void this.refreshPreview();
      });
      this.recordsList.appendChild(div);
    }
  }

  private start(): void {
    const cfg: StartConfig = {
      playerName: (this.nameInput.value.trim() || '登山者').slice(0, 16),
      seed: this.seed,
      difficulty: this.difficulty,
      room: this.roomInput.value.trim().slice(0, 24),
    };
    localStorage.setItem(
      PREF_KEY,
      JSON.stringify({ name: cfg.playerName, difficulty: cfg.difficulty, room: cfg.room }),
    );
    this.onStart?.(cfg);
  }

  show(): void {
    this.root.classList.remove('hidden');
    void this.refreshRecords();
    void this.refreshPreview();
  }

  hide(): void {
    this.root.classList.add('hidden');
  }
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 0xffffff);
}
