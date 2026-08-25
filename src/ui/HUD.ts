/* ===========================================================
   画面表示。DOM の更新だけを担当する。
   =========================================================== */

import { ACTION_LABEL, type PlayerAction } from '../core/types';

export interface PartyMember {
  name: string;
  altitude: number;
  stamina: number;
  maxStamina: number;
  self?: boolean;
}

export interface ClimbView {
  /** 選んでいる方向 */
  arrow: string;
  grade: 'easy' | 'medium' | 'hard' | 'impossible' | null;
  cost: number;
  staminaAfter: number;
  rest: boolean;
  ok: boolean;
  reason: string;
  topOut: boolean;
  stepDown: boolean;
  moves: number;
  ropesLeft: number;
  roped: boolean;
  /** 手を放しかけている度合い (0..1) */
  letGo: number;
}

const GRADE_TEXT: Record<string, string> = {
  easy: '易しい岩',
  medium: '並の岩',
  hard: '難しい岩',
  impossible: '取り付けない',
};

export interface HudData {
  action: PlayerAction;
  stamina: number;
  maxStamina: number;
  initialMax: number;
  recovering: boolean;
  altitude: number;
  temperature: number;
  ropes: number;
  snowLabel: string;
  mountainName: string;
  mountainId: string;
  difficultyLabel: string;
  summitHeight: number;
  progress: number;
  rockLabel: string;
  party: PartyMember[];
}

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`UI要素が見つかりません: #${id}`);
  return found as T;
}

export class HUD {
  private readonly root = el('hud');
  private readonly reticle = el('reticle');
  private readonly actionEl = el('action');
  private readonly staminaText = el('stamina-text');
  private readonly staminaBar = el('stamina-bar');
  private readonly maxBar = el('max-bar');
  private readonly envAlt = el('env-alt');
  private readonly envTemp = el('env-temp');
  private readonly ropeCount = el('rope-count');
  private readonly snowState = el('snow-state');
  private readonly mtnName = el('mtn-name');
  private readonly mtnId = el('mtn-id');
  private readonly mtnDiff = el('mtn-diff');
  private readonly mtnRemain = el('mtn-remain');
  private readonly mtnRock = el('mtn-rock');
  private readonly progressBar = el('progress-bar');
  private readonly partyEl = el('party');
  private readonly climbPanel = el('climb-panel');
  private readonly climbArrow = el('climb-arrow');
  private readonly climbGrade = el('climb-grade');
  private readonly climbCost = el('climb-cost');
  private readonly climbNote = el('climb-note');
  private readonly climbMoves = el('climb-moves');
  private readonly climbRope = el('climb-rope');
  private readonly hintEl = el('hint');
  private readonly toastEl = el('toast');


  private readonly summit = el('summit');
  private readonly summitTitle = el('summit-title');
  private readonly summitKicker = el('summit-kicker');
  private readonly summitStats = el('summit-stats');
  private readonly naming = el('naming');
  private readonly summitNamed = el('summit-named');
  readonly nameInput = el<HTMLInputElement>('mountain-name');
  readonly nameBtn = el<HTMLButtonElement>('name-btn');
  readonly backBtn = el<HTMLButtonElement>('back-btn');

  private toastTimer = 0;

  private reticleWanted = true;

  setVisible(v: boolean): void {
    this.root.classList.toggle('hidden', !v);
    this.reticle.style.display = v && this.reticleWanted ? 'grid' : 'none';
  }

  /** 画面中央のレティクルを出すか (カーソルで狙う場面では消す) */
  setReticle(v: boolean): void {
    this.reticleWanted = v;
    if (!this.root.classList.contains('hidden')) {
      this.reticle.style.display = v ? 'grid' : 'none';
    }
  }

  update(d: HudData): void {
    this.actionEl.textContent = ACTION_LABEL[d.action];
    this.actionEl.className = `badge ${d.action.toLowerCase()}`;

    this.staminaText.textContent = `${Math.round(d.stamina)} / ${Math.round(d.maxStamina)}`;
    const ratio = d.stamina / Math.max(1, d.maxStamina);
    this.staminaBar.style.width = `${Math.max(0, ratio) * 100}%`;
    this.staminaBar.className =
      'bar-fill' + (d.recovering ? ' recovering' : ratio < 0.2 ? ' critical' : ratio < 0.45 ? ' low' : '');
    this.maxBar.style.width = `${(d.maxStamina / d.initialMax) * 100}%`;

    this.envAlt.textContent = `標高 ${Math.round(d.altitude)}m`;
    this.envTemp.textContent = `${d.temperature.toFixed(1)}℃`;
    this.ropeCount.textContent = `ロープ ${d.ropes}`;
    this.snowState.textContent = d.snowLabel;

    this.mtnName.textContent = d.mountainName;
    this.mtnId.textContent = d.mountainId;
    this.mtnDiff.textContent = d.difficultyLabel;
    this.mtnRemain.textContent = `${Math.max(0, Math.round(d.summitHeight - d.altitude))}m`;
    this.progressBar.style.width = `${Math.min(1, Math.max(0, d.progress)) * 100}%`;
    this.mtnRock.textContent = d.rockLabel;

    if (d.party.length > 1) {
      this.partyEl.innerHTML = d.party
        .map(
          (p) =>
            `<div><span>${p.self ? '▶ ' : ''}${escapeHtml(p.name)}</span><span>${Math.round(p.altitude)}m / ${Math.round(
              p.stamina,
            )}</span></div>`,
        )
        .join('');
    } else {
      this.partyEl.textContent = '';
    }
  }

  /** 登攀中の表示。null で閉じる */
  setClimb(c: ClimbView | null): void {
    if (!c) {
      this.climbPanel.classList.add('hidden');
      return;
    }
    this.climbPanel.classList.remove('hidden');
    this.climbArrow.textContent = c.arrow;
    this.climbMoves.textContent = `${c.moves}手`;
    this.climbRope.textContent = c.roped ? 'ロープ有効' : `ロープ ${c.ropesLeft}`;

    if (c.letGo > 0.12) {
      this.climbGrade.textContent = '手を放そうとしている';
      this.climbCost.textContent = `${'▮'.repeat(Math.round(c.letGo * 8)).padEnd(8, '▯')}`;
      this.climbNote.textContent = '離せば掴んだまま';
      this.climbNote.className = 'climb-note warn';
      return;
    }

    if (c.topOut) {
      this.climbGrade.textContent = '壁の上へ';
      this.climbCost.textContent = 'Space で抜ける';
      this.climbNote.textContent = 'ここから乗り越えられる';
      this.climbNote.className = 'climb-note ok';
      return;
    }
    if (c.stepDown) {
      this.climbGrade.textContent = '地面へ';
      this.climbCost.textContent = 'Space で降りる';
      this.climbNote.textContent = '';
      this.climbNote.className = 'climb-note';
      return;
    }
    if (!c.grade) {
      this.climbGrade.textContent = c.reason || '方向を選ぶ';
      this.climbCost.textContent = 'WASD で方向 ／ Space で1手';
      this.climbNote.textContent = '';
      this.climbNote.className = 'climb-note';
      return;
    }

    this.climbGrade.textContent = GRADE_TEXT[c.grade] + (c.rest ? '（岩棚）' : '');
    this.climbCost.textContent = c.ok
      ? `消費 ${c.cost.toFixed(0)} → 残り ${Math.max(0, Math.round(c.staminaAfter))}`
      : c.reason;
    if (!c.ok) {
      this.climbNote.textContent = c.reason;
      this.climbNote.className = 'climb-note';
    } else if (c.staminaAfter <= 0) {
      this.climbNote.textContent = 'この一手で力尽きる';
      this.climbNote.className = 'climb-note';
    } else if (c.rest) {
      this.climbNote.textContent = '乗れば息を整えられる';
      this.climbNote.className = 'climb-note ok';
    } else {
      this.climbNote.textContent = '';
      this.climbNote.className = 'climb-note';
    }
  }

  setHint(text: string | null): void {
    if (!text) {
      this.hintEl.classList.remove('show');
      return;
    }
    this.hintEl.innerHTML = text;
    this.hintEl.classList.add('show');
  }

  toast(message: string, good = false): void {
    this.toastEl.textContent = message;
    this.toastEl.className = `toast show${good ? ' good' : ''}`;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('show'), 2000);
  }

  showSummit(opts: {
    first: boolean;
    title: string;
    stats: string;
    namedText?: string;
  }): void {
    this.summit.classList.remove('hidden');
    this.summitKicker.textContent = opts.first ? 'FIRST ASCENT' : 'SUMMIT';
    this.summitTitle.textContent = opts.title;
    this.summitStats.innerHTML = opts.stats;
    this.naming.classList.toggle('hidden', !opts.first);
    this.summitNamed.classList.toggle('hidden', opts.first || !opts.namedText);
    if (opts.namedText) this.summitNamed.textContent = opts.namedText;
    if (opts.first) this.nameInput.focus();
  }

  markNamed(text: string): void {
    this.naming.classList.add('hidden');
    this.summitNamed.classList.remove('hidden');
    this.summitNamed.textContent = text;
  }

  hideSummit(): void {
    this.summit.classList.add('hidden');
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
