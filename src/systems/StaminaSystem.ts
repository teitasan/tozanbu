/* ===========================================================
   スタミナ。

   現在スタミナ : 短期的な運動能力。ダッシュ・登攀・ラッセルで減り、休憩で戻る。
   最大スタミナ : 登山全体を通した疲労・身体状態。時間と環境で減っていく。

   酸素・体温・疲労に独立したゲージは作らず、
   「最大スタミナの減少量」と「現在スタミナの回復速度」への補正として表現する。
   =========================================================== */

import { clamp, clamp01 } from '../core/math';
import { ENV, STAMINA } from '../core/types';

export interface EnvironmentState {
  /** 標高 (m) */
  altitude: number;
  /** 気温 (℃) */
  temperature: number;
  /** 酸素の効き 0.5..1 */
  oxygen: number;
  /** 寒さ 0..1 */
  cold: number;
}

export class StaminaSystem {
  /** 出発時の最大スタミナ */
  readonly initialMax: number;
  private _max: number;
  private _cur: number;

  /** 難易度による疲労倍率 */
  fatigueScale = 1;
  /** その瞬間の運動強度 0..1 (呼び出し側が毎フレーム設定する) */
  exertion = 0;

  readonly env: EnvironmentState = { altitude: 0, temperature: ENV.baseTemp, oxygen: 1, cold: 0 };

  /** 検証用の累計 */
  totalConsumed = 0;
  totalRecovered = 0;

  onDepleted: (() => void) | null = null;

  constructor(max = STAMINA.max) {
    this.initialMax = max;
    this._max = max;
    this._cur = max;
  }

  get stamina(): number {
    return this._cur;
  }

  get maxStamina(): number {
    return this._max;
  }

  get ratio(): number {
    return this._cur / Math.max(1, this._max);
  }

  get maxRatio(): number {
    return this._max / this.initialMax;
  }

  /** 現在スタミナの回復速度倍率 */
  get recoveryScale(): number {
    return this.env.oxygen * (1 - this.env.cold * 0.45);
  }

  /** 最大スタミナが毎秒削れる量 */
  get fatigueRate(): number {
    return (
      STAMINA.fatigueBase *
      this.fatigueScale *
      (1 + (1 - this.env.oxygen) * 1.8 + this.env.cold * 1.3 + this.exertion * 1.6)
    );
  }

  setAltitude(altitude: number): void {
    const e = this.env;
    e.altitude = altitude;
    e.temperature = ENV.baseTemp - (altitude * ENV.lapseRate) / 1000;
    e.oxygen = 1 - clamp01((altitude - ENV.altitudeStart) / 2500) * 0.5;
    e.cold = clamp01((2 - e.temperature) / 18);
  }

  canAfford(cost: number): boolean {
    return this._cur >= cost;
  }

  /** 一括消費。足りなければ false で何もしない */
  consume(cost: number): boolean {
    if (!this.canAfford(cost)) return false;
    this._cur = Math.max(0, this._cur - cost);
    this.totalConsumed += cost;
    if (this._cur <= 0) this.onDepleted?.();
    return true;
  }

  /** 継続消費 (ダッシュ・ラッセルなど) */
  drain(perSec: number, dt: number): void {
    if (perSec <= 0) return;
    const before = this._cur;
    this._cur = Math.max(0, this._cur - perSec * dt);
    this.totalConsumed += before - this._cur;
    if (before > 0 && this._cur <= 0) this.onDepleted?.();
  }

  /** 継続回復 */
  recover(perSec: number, dt: number): void {
    if (perSec <= 0) return;
    const before = this._cur;
    this._cur = Math.min(this._max, this._cur + perSec * this.recoveryScale * dt);
    this.totalRecovered += this._cur - before;
  }

  /** 最大スタミナの減少 */
  tickFatigue(dt: number): void {
    this._max = Math.max(20, this._max - this.fatigueRate * dt);
    if (this._cur > this._max) this._cur = this._max;
  }

  /** 補給などで最大スタミナを戻す (現状は未使用の拡張点) */
  restoreMax(amount: number): void {
    this._max = clamp(this._max + amount, 20, this.initialMax);
  }

  reset(): void {
    this._max = this.initialMax;
    this._cur = this.initialMax;
    this.totalConsumed = 0;
    this.totalRecovered = 0;
    this.exertion = 0;
  }

  /** ネット同期用 */
  snapshot(): { cur: number; max: number } {
    return { cur: this._cur, max: this._max };
  }
}
