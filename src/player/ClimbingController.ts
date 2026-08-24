/* ===========================================================
   登攀。このゲームの主要なルート選択要素。

   流れは「見て決める → 実行する」の2段階。
     1. 岩壁に取り付くと、下から見上げる視点になる (planning)
     2. ホールドを順にクリックしてルートを組み立てる。
        1手ごとの消費と残りスタミナの見込みが出る
     3. Space で実行 (executing)。あとは自動で登る
     4. 登り切れば抜けられる。スタミナが尽きれば落ちる

   岩棚 (ledge) はスタミナが戻る場所であり、そこで一度ルートを組み直せる。
   長い壁は「岩棚まで1ピッチ、そこからもう1ピッチ」と刻むことになる。

   正解ルートは表示しない。示すのは「そこへ手が届くか」と「いくら掛かるか」だけ。
   =========================================================== */

import * as THREE from 'three';
import { CLIMB, type PlayerAction } from '../core/types';
import type { ClimbWall } from '../mountain/cliff/ClimbWall';
import type { Hold } from '../mountain/cliff/Hold';
import { moveCost } from '../mountain/cliff/routeSolver';
import type { RopeSystem } from '../systems/RopeSystem';
import type { StaminaSystem } from '../systems/StaminaSystem';
import type { PlayerController } from './PlayerController';

export type ClimbMode = 'off' | 'planning' | 'executing';
export type ReleaseReason = 'stepdown' | 'letgo' | 'stamina' | 'topout' | 'stranded';

/** ルートの終わり方 */
export type PlanEnding = 'top' | 'ledge' | 'air';

export interface PlanStep {
  hold: Hold;
  /** この手の消費 */
  cost: number;
  /** この手を終えた時点の残りスタミナ (岩棚での回復込み) */
  staminaAfter: number;
  /** ここで休む (岩棚) */
  rest: boolean;
}

export interface PlanSummary {
  steps: number;
  totalCost: number;
  /** 登り終えた時点の残りスタミナ */
  endStamina: number;
  /** 力尽きる手の番号 (1始まり)。落ちないなら 0 */
  failsAt: number;
  ending: PlanEnding;
  useRope: boolean;
}

function anchorFor(hold: Hold, out = new THREE.Vector3()): THREE.Vector3 {
  const nx = hold.normal.x;
  const nz = hold.normal.z;
  const len = Math.hypot(nx, nz) || 1;
  if (hold.type === 'ledge') {
    return out.set(hold.position.x + (nx / len) * 0.34, hold.position.y + 0.12, hold.position.z + (nz / len) * 0.34);
  }
  return out.set(hold.position.x + (nx / len) * 0.42, hold.position.y - 0.95, hold.position.z + (nz / len) * 0.42);
}

const smoothstep = (t: number) => t * t * (3 - 2 * t);

export class ClimbingController {
  mode: ClimbMode = 'off';
  wall: ClimbWall | null = null;
  action: PlayerAction = 'CLIMB';

  /** 組み立て中のルート */
  readonly plan: PlanStep[] = [];
  /** 出発点。地上から取り付くなら null、岩棚から続けるならそのホールド */
  planStart: Hold | null = null;
  /** このピッチでロープを使うか */
  useRope = false;

  /** 検証用 */
  moveCount = 0;

  onEnterPlanning: ((wall: ClimbWall, from: Hold | null) => void) | null = null;
  onCommit: ((summary: PlanSummary) => void) | null = null;
  onExit: ((reason: ReleaseReason) => void) | null = null;
  onNotice: ((message: string) => void) | null = null;
  onRopeFixed: ((wall: ClimbWall) => void) | null = null;

  readonly helpers = new THREE.Group();

  private current: Hold | null = null;
  private execIndex = 0;
  private elapsed = 0;
  private duration = 0;
  private restTimer = 0;
  private readonly fromPos = new THREE.Vector3();
  private readonly toPos = new THREE.Vector3();
  private readonly basePos = new THREE.Vector3();

  private readonly reachSphere: THREE.Mesh;
  private readonly routeLine: THREE.Line;
  private readonly routeGeometry: THREE.BufferGeometry;
  private static readonly ROUTE_MAX = 64;

  constructor(
    private readonly player: PlayerController,
    private readonly stamina: StaminaSystem,
    private readonly ropes: RopeSystem,
  ) {
    this.reachSphere = new THREE.Mesh(
      new THREE.SphereGeometry(1, 20, 14),
      new THREE.MeshBasicMaterial({
        color: 0x8fd8ff,
        transparent: true,
        opacity: 0.06,
        depthWrite: false,
        side: THREE.BackSide,
      }),
    );
    this.reachSphere.visible = false;
    this.helpers.add(this.reachSphere);

    this.routeGeometry = new THREE.BufferGeometry();
    this.routeGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(ClimbingController.ROUTE_MAX * 3), 3),
    );
    this.routeGeometry.setDrawRange(0, 0);
    this.routeLine = new THREE.Line(
      this.routeGeometry,
      new THREE.LineBasicMaterial({ color: 0xffd24a, transparent: true, opacity: 0.9, depthTest: false }),
    );
    this.routeLine.visible = false;
    this.routeLine.renderOrder = 4;
    this.routeLine.frustumCulled = false;
    this.helpers.add(this.routeLine);
  }

  get isClimbing(): boolean {
    return this.mode !== 'off';
  }

  get isPlanning(): boolean {
    return this.mode === 'planning';
  }

  get currentHold(): Hold | null {
    return this.current;
  }

  get reach(): number {
    return this.wall?.reach ?? CLIMB.grabRange;
  }

  /** ロープによるコスト倍率 */
  get costScale(): number {
    if (!this.wall) return 1;
    if (this.ropes.hasRope(this.wall.id)) return CLIMB.ropeCostScale;
    return this.useRope ? CLIMB.ropeCostScale : 1;
  }

  /** ルートの先端 (次にどこへ手を伸ばせるかの基準) */
  get tip(): Hold | null {
    return this.plan.length ? this.plan[this.plan.length - 1].hold : this.planStart;
  }

  // --- 取り付き -----------------------------------------------------------

  /** 岩壁を見上げてルートを組み立て始める */
  startPlanning(wall: ClimbWall, from: Hold | null, playerPos: THREE.Vector3): boolean {
    if (this.mode !== 'off') return false;
    if (this.stamina.stamina <= 1) {
      this.onNotice?.('スタミナが尽きている');
      return false;
    }
    if (!from) {
      // 地上から取り付けるホールドが近くにあるか
      const reachable = wall.startHolds.some(
        (h) => h.position.distanceTo(playerPos) <= CLIMB.grabRange + 2.0,
      );
      if (!reachable) {
        this.onNotice?.('取り付ける手がかりが見つからない');
        return false;
      }
    }

    this.mode = 'planning';
    this.wall = wall;
    this.planStart = from;
    this.plan.length = 0;
    this.useRope = false;
    this.current = from;
    this.action = 'REST';
    this.player.enabled = false;
    this.player.velocity.set(0, 0, 0);
    if (from) this.player.setPosition(anchorFor(from));
    this.basePos.copy(this.player.position);
    this.reachSphere.scale.setScalar(wall.reach);
    this.onEnterPlanning?.(wall, from);
    return true;
  }

  // --- ルートの組み立て ---------------------------------------------------

  /** その手を足せるか */
  canAppend(hold: Hold): boolean {
    if (this.mode !== 'planning' || !this.wall) return false;
    if (this.plan.some((s) => s.hold === hold)) return false;
    const tip = this.tip;
    if (!tip) {
      // 地上からの1手目は取り付けるホールドだけ
      return hold.ground;
    }
    return hold !== tip && tip.position.distanceTo(hold.position) <= this.reach;
  }

  /** その手の消費 */
  costTo(hold: Hold): number {
    const tip = this.tip;
    if (!tip) return hold.baseStaminaCost * this.costScale;
    return moveCost(tip, hold, CLIMB.distanceCost, this.costScale);
  }

  append(hold: Hold): boolean {
    if (!this.canAppend(hold)) {
      if (this.plan.some((s) => s.hold === hold)) this.onNotice?.('すでにルートに入っている');
      else if (!this.tip) this.onNotice?.('地上から取り付けるホールドを選ぶ');
      else this.onNotice?.('そこまでは手が届かない');
      return false;
    }
    this.plan.push({ hold, cost: 0, staminaAfter: 0, rest: false });
    this.recalculate();
    return true;
  }

  undo(): void {
    if (this.mode !== 'planning' || this.plan.length === 0) return;
    this.plan.pop();
    this.recalculate();
  }

  clearPlan(): void {
    if (this.mode !== 'planning') return;
    this.plan.length = 0;
    this.recalculate();
  }

  toggleRope(): void {
    if (this.mode !== 'planning' || !this.wall) return;
    if (this.ropes.hasRope(this.wall.id)) {
      this.onNotice?.('この岩壁にはすでにロープがある');
      return;
    }
    if (!this.useRope && this.ropes.carried <= 0) {
      this.onNotice?.('ロープを使い切っている');
      return;
    }
    this.useRope = !this.useRope;
    this.recalculate();
    this.onNotice?.(this.useRope ? `ロープを使う (残り ${this.ropes.carried})` : 'ロープを使わない');
  }

  /** 各手の消費と残りスタミナの見込みを計算し直す */
  private recalculate(): void {
    let cur = this.stamina.stamina;
    let prev = this.planStart;
    const scale = this.costScale;
    for (const step of this.plan) {
      const cost = prev
        ? moveCost(prev, step.hold, CLIMB.distanceCost, scale)
        : step.hold.baseStaminaCost * scale;
      step.cost = cost;
      cur -= cost;
      // 岩棚に着いたら最大まで戻る
      step.rest = step.hold.type === 'ledge' && cur > 0;
      if (step.rest) cur = this.stamina.maxStamina;
      step.staminaAfter = cur;
      prev = step.hold;
    }
    this.updateRouteLine();
  }

  /** ルート全体の見込み */
  summary(): PlanSummary {
    let failsAt = 0;
    for (let i = 0; i < this.plan.length; i++) {
      if (this.plan[i].staminaAfter <= 0) {
        failsAt = i + 1;
        break;
      }
    }
    const last = this.plan.length ? this.plan[this.plan.length - 1].hold : null;
    let ending: PlanEnding = 'air';
    if (last) {
      if (last.topOut && this.wall?.topOutPoint(last)) ending = 'top';
      else if (last.type === 'ledge') ending = 'ledge';
    }
    return {
      steps: this.plan.length,
      totalCost: this.plan.reduce((a, s) => a + s.cost, 0),
      endStamina: this.plan.length ? this.plan[this.plan.length - 1].staminaAfter : this.stamina.stamina,
      failsAt,
      ending,
      useRope: this.useRope || (this.wall ? this.ropes.hasRope(this.wall.id) : false),
    };
  }

  // --- 実行 ---------------------------------------------------------------

  /** 組み立てたルートを登り始める */
  commit(): boolean {
    if (this.mode !== 'planning' || !this.wall) return false;
    if (this.plan.length === 0) {
      this.onNotice?.('ルートを組み立ててから登る');
      return false;
    }
    const summary = this.summary();
    if (this.useRope && !this.ropes.hasRope(this.wall.id)) {
      const rope = this.ropes.fix(this.wall, 'you');
      if (rope) this.onRopeFixed?.(this.wall);
    }
    this.mode = 'executing';
    this.execIndex = 0;
    this.elapsed = 0;
    this.duration = 0;
    this.restTimer = 0;
    this.moveCount = 0;
    this.action = 'CLIMB';
    if (!this.planStart) this.player.setPosition(this.basePos);
    this.beginStep();
    this.onCommit?.(summary);
    return true;
  }

  /** 組み立てをやめて壁から離れる */
  cancel(): void {
    if (this.mode !== 'planning') return;
    this.finish('stepdown');
  }

  /** 手を放す (実行中の中断) */
  letGo(): void {
    if (this.mode === 'planning') {
      this.cancel();
      return;
    }
    if (this.mode !== 'executing') return;
    this.finish(this.current?.ground ? 'stepdown' : 'letgo');
  }

  private beginStep(): void {
    const step = this.plan[this.execIndex];
    if (!step) return;
    const from = this.current;
    const cost = from
      ? moveCost(from, step.hold, CLIMB.distanceCost, this.costScale)
      : step.hold.baseStaminaCost * this.costScale;

    if (!this.stamina.canAfford(cost)) {
      // この一手が出せない
      this.finish('stamina');
      return;
    }
    this.stamina.consume(cost);

    const dist = from ? from.position.distanceTo(step.hold.position) : 1.5;
    const dy = from ? step.hold.position.y - from.position.y : 1.5;
    this.action = Math.abs(dy) / Math.max(0.01, dist) < CLIMB.traverseSlope ? 'TRAVERSE' : 'CLIMB';
    this.elapsed = 0;
    this.duration = CLIMB.moveBaseDuration + dist * CLIMB.moveDurationPerUnit;
    this.fromPos.copy(this.player.position);
    anchorFor(step.hold, this.toPos);
  }

  private arriveStep(): void {
    const step = this.plan[this.execIndex];
    this.current = step.hold;
    this.moveCount += 1;
    anchorFor(step.hold, this.toPos);
    this.player.position.copy(this.toPos);

    if (this.stamina.stamina <= 0) {
      this.finish('stamina');
      return;
    }

    if (step.hold.type === 'ledge') {
      // 岩棚に乗った。息を整える
      this.restTimer = Math.max(0, (this.stamina.maxStamina - this.stamina.stamina) / CLIMB.ledgeRecoveryPerSec);
      this.action = 'REST';
      return;
    }
    this.advance();
  }

  /** 次の手へ、または終了処理へ */
  private advance(): void {
    if (this.execIndex < this.plan.length - 1) {
      this.execIndex += 1;
      this.beginStep();
      return;
    }
    // ルートの終端に着いた
    const last = this.current;
    if (last?.topOut && this.wall?.topOutPoint(last)) {
      this.topOut();
      return;
    }
    if (last?.type === 'ledge') {
      // 岩棚。ここでもう一度ルートを組み直す
      const wall = this.wall!;
      this.mode = 'off';
      this.startPlanning(wall, last, this.player.position);
      this.onNotice?.('岩棚に着いた。ここから次のルートを組み立てる');
      return;
    }
    // 抜け口でも岩棚でもない場所で手が尽きた
    this.finish('stranded');
  }

  private topOut(): void {
    const wall = this.wall!;
    const point = wall.topOutPoint(this.current!);
    this.clearVisuals();
    this.mode = 'off';
    this.wall = null;
    this.current = null;
    this.plan.length = 0;
    this.planStart = null;
    this.reachSphere.visible = false;
    this.routeLine.visible = false;
    this.player.enabled = true;
    if (!point || !this.player.beginMantle(point, this.stamina)) {
      this.player.grounded = false;
      this.player.velocity.set(wall.frame.outward.x * 1.6, 0.3, wall.frame.outward.z * 1.6);
      this.onNotice?.('引き上げる力が残っていない');
      this.onExit?.('stamina');
      return;
    }
    this.onExit?.('topout');
  }

  private finish(reason: ReleaseReason): void {
    const wall = this.wall;
    this.clearVisuals();
    this.mode = 'off';
    this.wall = null;
    this.current = null;
    this.plan.length = 0;
    this.planStart = null;
    this.useRope = false;
    this.reachSphere.visible = false;
    this.routeLine.visible = false;
    this.player.enabled = true;
    if (reason === 'stepdown') {
      this.player.velocity.set(0, 0, 0);
      this.player.grounded = false;
    } else {
      const n = wall?.frame.outward;
      this.player.grounded = false;
      this.player.velocity.set((n?.x ?? 0) * 1.6, 0.4, (n?.z ?? 1) * 1.6);
    }
    this.onExit?.(reason);
  }

  // --- 更新 ---------------------------------------------------------------

  update(dt: number, hovered: Hold | null): void {
    if (this.mode === 'off' || !this.wall) return;

    if (this.mode === 'planning') {
      this.stamina.exertion = 0.1;
      this.action = 'REST';
      if (this.current) {
        this.reachSphere.position.copy(this.tip?.position ?? this.current.position);
        this.reachSphere.visible = true;
      } else if (this.tip) {
        this.reachSphere.position.copy(this.tip.position);
        this.reachSphere.visible = true;
      } else {
        this.reachSphere.visible = false;
      }
      this.updatePlanVisuals(hovered);
      return;
    }

    // --- 実行中 ---
    if (this.restTimer > 0) {
      this.restTimer -= dt;
      this.stamina.recover(CLIMB.ledgeRecoveryPerSec, dt);
      this.stamina.exertion = 0.15;
      this.action = 'REST';
      if (this.restTimer <= 0) this.advance();
      return;
    }

    if (this.duration > 0) {
      this.elapsed += dt;
      const t = Math.min(1, this.elapsed / this.duration);
      const p = this.player.position;
      p.lerpVectors(this.fromPos, this.toPos, smoothstep(t));
      const n = this.wall.frame.outward;
      const bulge = Math.sin(Math.PI * t) * 0.18;
      p.x += n.x * bulge;
      p.z += n.z * bulge;
      this.stamina.exertion = 1;
      if (t >= 1) {
        this.duration = 0;
        this.arriveStep();
      }
    }

    if (this.current) {
      this.reachSphere.position.copy(this.current.position);
      this.reachSphere.visible = false;
    }
    this.updateExecVisuals();
  }

  // --- 見た目 -------------------------------------------------------------

  private clearVisuals(): void {
    if (!this.wall) return;
    for (const h of this.wall.holds) h.setVisual('idle');
  }

  private updatePlanVisuals(hovered: Hold | null): void {
    const wall = this.wall;
    if (!wall) return;
    const planned = new Set(this.plan.map((s) => s.hold));
    const tip = this.tip;
    for (const h of wall.holds) {
      if (planned.has(h)) {
        h.setVisual('planned');
        continue;
      }
      if (h === tip) {
        h.setVisual('current');
        continue;
      }
      const ok = this.canAppend(h);
      if (!ok) {
        h.setVisual('idle');
        continue;
      }
      if (h === hovered) h.setVisual('hover');
      else if (this.projectedStaminaAt(h) <= 0) h.setVisual('tooExpensive');
      else h.setVisual('reachable');
    }
  }

  /** その手を足したときの残りスタミナ見込み */
  projectedStaminaAt(hold: Hold): number {
    const base = this.plan.length ? this.plan[this.plan.length - 1].staminaAfter : this.stamina.stamina;
    return base - this.costTo(hold);
  }

  private updateExecVisuals(): void {
    const wall = this.wall;
    if (!wall) return;
    const remaining = new Set(this.plan.slice(this.execIndex).map((s) => s.hold));
    for (const h of wall.holds) {
      if (h === this.current) h.setVisual('current');
      else if (remaining.has(h)) h.setVisual('planned');
      else h.setVisual('idle');
    }
  }

  private updateRouteLine(): void {
    const attr = this.routeGeometry.attributes.position as THREE.BufferAttribute;
    const pts: THREE.Vector3[] = [];
    if (this.planStart) pts.push(this.planStart.position);
    else if (this.plan.length) pts.push(this.basePos);
    for (const s of this.plan) pts.push(s.hold.position);
    const count = Math.min(pts.length, ClimbingController.ROUTE_MAX);
    for (let i = 0; i < count; i++) {
      attr.setXYZ(i, pts[i].x, pts[i].y, pts[i].z + 0.12);
    }
    attr.needsUpdate = true;
    this.routeGeometry.setDrawRange(0, count);
    this.routeLine.visible = count >= 2;
  }
}
