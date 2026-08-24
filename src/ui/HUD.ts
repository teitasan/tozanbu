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

export interface AimInfo {
  text: string;
  state: 'ok' | 'ng' | 'warn';
}

export interface PlanView {
  steps: number;
  totalCost: number;
  endStamina: number;
  /** 力尽きる手の番号 (1始まり)。落ちないなら 0 */
  failsAt: number;
  ending: 'top' | 'ledge' | 'air';
  useRope: boolean;
  ropesLeft: number;
}

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
  private readonly planPanel = el('plan-panel');
  private readonly planSteps = el('plan-steps');
  private readonly planCost = el('plan-cost');
  private readonly planEnd = el('plan-end');
  private readonly planEnding = el('plan-ending');
  private readonly planRope = el('plan-rope');
  private readonly planWarn = el('plan-warn');
  private readonly hintEl = el('hint');
  private readonly aimEl = el('aim');
  private readonly toastEl = el('toast');

  private readonly loading = el('loading');
  private readonly loadingTitle = el('loading-title');
  private readonly loadingBar = el('loading-bar');

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

  /** ルート組み立ての表示。null で閉じる */
  setPlan(p: PlanView | null): void {
    if (!p) {
      this.planPanel.classList.add('hidden');
      return;
    }
    this.planPanel.classList.remove('hidden');
    this.planSteps.textContent = `${p.steps}`;
    this.planCost.textContent = p.totalCost.toFixed(0);
    this.planEnd.textContent = `${Math.max(0, Math.round(p.endStamina))}`;
    this.planRope.textContent = p.useRope ? `ロープ使用 (残 ${p.ropesLeft})` : `ロープ ${p.ropesLeft}`;

    const endingText =
      p.ending === 'top' ? '終点: 壁の上へ抜けられる' : p.ending === 'ledge' ? '終点: 岩棚で一息つける' : '終点: 掴まる場所が無い';
    this.planEnding.textContent = p.steps === 0 ? 'ホールドをクリックして繋ぐ' : endingText;

    if (p.steps === 0) {
      this.planWarn.textContent = '';
      this.planWarn.className = 'plan-warn';
    } else if (p.failsAt > 0) {
      this.planWarn.textContent = `${p.failsAt}手目で力尽きて落ちる`;
      this.planWarn.className = 'plan-warn';
    } else if (p.ending === 'air') {
      this.planWarn.textContent = '登り切っても抜けられない';
      this.planWarn.className = 'plan-warn warn';
    } else if (p.ending === 'ledge') {
      this.planWarn.textContent = '岩棚まで登れる（そこで組み直せる）';
      this.planWarn.className = 'plan-warn ok';
    } else {
      this.planWarn.textContent = 'この壁を抜けられる';
      this.planWarn.className = 'plan-warn ok';
    }
  }

  setAim(info: AimInfo | null): void {
    if (!info) {
      this.aimEl.classList.remove('show');
      this.reticle.classList.remove('aiming', 'blocked');
      return;
    }
    this.aimEl.innerHTML = `<span class="${info.state}">${info.text}</span>`;
    this.aimEl.classList.add('show');
    this.reticle.classList.toggle('aiming', info.state === 'ok');
    this.reticle.classList.toggle('blocked', info.state === 'ng');
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

  showLoading(label: string, ratio: number): void {
    this.loading.classList.remove('hidden');
    this.loadingTitle.textContent = label;
    this.loadingBar.style.width = `${ratio * 100}%`;
  }

  hideLoading(): void {
    this.loading.classList.add('hidden');
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
