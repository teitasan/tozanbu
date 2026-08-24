/* ===========================================================
   登攀。岩肌を見てルートを見つける。

   流れは「見て決める → 実行する」の2段階。
     1. 岩壁に取り付くと、下から見上げる視点になる (planning)
     2. 岩肌を観察し、通るセルを順に指定してルートを組み立てる
     3. Space で実行 (executing)。指定したルートを自動で登る
     4. 登り切れば抜けられる。スタミナが尽きれば落ちる

   グリッドはプレイヤーに見せない。判断材料は岩肌の見た目と、
   指したセルの消費・残りスタミナだけ。

   岩棚はスタミナが戻る場所であり、そこで一度ルートを組み直せる。
   手足や個々のホールド位置はここでは扱わない。
   =========================================================== */

import * as THREE from 'three';
import { CLIMB, type PlayerAction } from '../core/types';
import type { ClimbWall } from '../mountain/cliff/ClimbWall';
import { cellMoveCost, passable, type Cell } from '../mountain/cliff/grid';
import type { RopeSystem } from '../systems/RopeSystem';
import type { StaminaSystem } from '../systems/StaminaSystem';
import type { PlayerController } from './PlayerController';

export type ClimbMode = 'off' | 'planning' | 'executing';
export type ReleaseReason = 'stepdown' | 'letgo' | 'stamina' | 'topout' | 'stranded';
export type PlanEnding = 'top' | 'ledge' | 'air';

export interface PlanStep {
  cell: Cell;
  cost: number;
  /** この手を終えた時点の残りスタミナ (岩棚での回復込み) */
  staminaAfter: number;
  rest: boolean;
}

export interface PlanSummary {
  steps: number;
  totalCost: number;
  endStamina: number;
  /** 力尽きる手の番号 (1始まり)。落ちないなら 0 */
  failsAt: number;
  ending: PlanEnding;
  useRope: boolean;
}

/** そのセルに取り付いているときのプレイヤーの位置 */
function anchorFor(wall: ClimbWall, cell: Cell, out = new THREE.Vector3()): THREE.Vector3 {
  const n = wall.frame.outward;
  const p = cell.pos!;
  if (cell.rest) return out.set(p.x + n.x * 0.34, p.y + 0.12, p.z + n.z * 0.34);
  return out.set(p.x + n.x * 0.42, p.y - 0.75, p.z + n.z * 0.42);
}

const smoothstep = (t: number) => t * t * (3 - 2 * t);

export class ClimbingController {
  mode: ClimbMode = 'off';
  wall: ClimbWall | null = null;
  action: PlayerAction = 'CLIMB';

  readonly plan: PlanStep[] = [];
  /** 出発点。地上から取り付くなら null、岩棚から続けるならそのセル */
  planStart: Cell | null = null;
  useRope = false;
  moveCount = 0;

  onEnterPlanning: ((wall: ClimbWall, from: Cell | null) => void) | null = null;
  onCommit: ((summary: PlanSummary) => void) | null = null;
  onExit: ((reason: ReleaseReason) => void) | null = null;
  onNotice: ((message: string) => void) | null = null;
  onRopeFixed: ((wall: ClimbWall) => void) | null = null;

  readonly helpers = new THREE.Group();

  private current: Cell | null = null;
  private execIndex = 0;
  private elapsed = 0;
  private duration = 0;
  private restTimer = 0;
  private readonly fromPos = new THREE.Vector3();
  private readonly toPos = new THREE.Vector3();
  private readonly basePos = new THREE.Vector3();

  private readonly routeLine: THREE.Line;
  private readonly routeGeometry: THREE.BufferGeometry;
  private static readonly ROUTE_MAX = 80;

  constructor(
    private readonly player: PlayerController,
    private readonly stamina: StaminaSystem,
    private readonly ropes: RopeSystem,
  ) {
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

  get currentCell(): Cell | null {
    return this.current;
  }

  get reach(): number {
    return this.wall?.reach ?? CLIMB.grabRange;
  }

  get costScale(): number {
    if (!this.wall) return 1;
    if (this.ropes.hasRope(this.wall.id)) return CLIMB.ropeCostScale;
    return this.useRope ? CLIMB.ropeCostScale : 1;
  }

  /** ルートの先端 */
  get tip(): Cell | null {
    return this.plan.length ? this.plan[this.plan.length - 1].cell : this.planStart;
  }

  // --- 取り付き -----------------------------------------------------------

  startPlanning(wall: ClimbWall, from: Cell | null, playerPos: THREE.Vector3): boolean {
    if (this.mode !== 'off') return false;
    if (this.stamina.stamina <= 1) {
      this.onNotice?.('スタミナが尽きている');
      return false;
    }
    if (!from) {
      const reachable = wall.groundCells.some(
        (c) => c.pos!.distanceTo(playerPos) <= CLIMB.grabRange + 2.0,
      );
      if (!reachable) {
        this.onNotice?.('取り付ける場所が見つからない');
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
    if (from) this.player.setPosition(anchorFor(wall, from));
    this.basePos.copy(this.player.position);
    wall.clearMarkers();
    this.onEnterPlanning?.(wall, from);
    return true;
  }

  // --- ルートの組み立て ---------------------------------------------------

  canAppend(cell: Cell): boolean {
    if (this.mode !== 'planning' || !this.wall) return false;
    if (!passable(cell)) return false;
    if (this.plan.some((s) => s.cell === cell)) return false;
    const tip = this.tip;
    if (!tip) return cell.ground;
    return cell !== tip && tip.pos!.distanceTo(cell.pos!) <= this.reach;
  }

  costTo(cell: Cell): number {
    const tip = this.tip;
    if (!passable(cell)) return Infinity;
    if (!tip) return cellMoveCost(cell, cell, 0, this.costScale);
    return cellMoveCost(tip, cell, CLIMB.distanceCost, this.costScale);
  }

  append(cell: Cell): boolean {
    if (!this.canAppend(cell)) {
      if (!passable(cell)) this.onNotice?.('そこは手がかりが無い');
      else if (this.plan.some((s) => s.cell === cell)) this.onNotice?.('すでにルートに入っている');
      else if (!this.tip) this.onNotice?.('地上から取り付ける場所を選ぶ');
      else this.onNotice?.('そこまでは手が届かない');
      return false;
    }
    this.plan.push({ cell, cost: 0, staminaAfter: 0, rest: false });
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

  private recalculate(): void {
    let cur = this.stamina.stamina;
    let prev = this.planStart;
    const scale = this.costScale;
    for (const step of this.plan) {
      const cost = prev
        ? cellMoveCost(prev, step.cell, CLIMB.distanceCost, scale)
        : cellMoveCost(step.cell, step.cell, 0, scale);
      step.cost = cost;
      cur -= cost;
      step.rest = step.cell.rest && cur > 0;
      if (step.rest) cur = this.stamina.maxStamina;
      step.staminaAfter = cur;
      prev = step.cell;
    }
    this.updateRouteLine();
    this.wall?.markRoute(this.plan.map((s) => s.cell));
  }

  summary(): PlanSummary {
    let failsAt = 0;
    for (let i = 0; i < this.plan.length; i++) {
      if (this.plan[i].staminaAfter <= 0) {
        failsAt = i + 1;
        break;
      }
    }
    const last = this.plan.length ? this.plan[this.plan.length - 1].cell : null;
    let ending: PlanEnding = 'air';
    if (last) {
      if (last.topOut && this.wall?.topOutPoint(last)) ending = 'top';
      else if (last.rest) ending = 'ledge';
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

  /** そのセルを足したときの残りスタミナ見込み */
  projectedStaminaAt(cell: Cell): number {
    const base = this.plan.length ? this.plan[this.plan.length - 1].staminaAfter : this.stamina.stamina;
    return base - this.costTo(cell);
  }

  // --- 実行 ---------------------------------------------------------------

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
    this.wall.setHover(null);
    if (!this.planStart) this.player.setPosition(this.basePos);
    this.beginStep();
    this.onCommit?.(summary);
    return true;
  }

  cancel(): void {
    if (this.mode !== 'planning') return;
    this.finish('stepdown');
  }

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
    if (!step || !this.wall) return;
    const from = this.current;
    const cost = from
      ? cellMoveCost(from, step.cell, CLIMB.distanceCost, this.costScale)
      : cellMoveCost(step.cell, step.cell, 0, this.costScale);

    if (!this.stamina.canAfford(cost)) {
      this.finish('stamina');
      return;
    }
    this.stamina.consume(cost);

    const dist = from ? from.pos!.distanceTo(step.cell.pos!) : 1.5;
    const dy = from ? step.cell.pos!.y - from.pos!.y : 1.5;
    this.action = Math.abs(dy) / Math.max(0.01, dist) < CLIMB.traverseSlope ? 'TRAVERSE' : 'CLIMB';
    this.elapsed = 0;
    this.duration = CLIMB.moveBaseDuration + dist * CLIMB.moveDurationPerUnit;
    this.fromPos.copy(this.player.position);
    anchorFor(this.wall, step.cell, this.toPos);
  }

  private arriveStep(): void {
    const step = this.plan[this.execIndex];
    this.current = step.cell;
    this.moveCount += 1;
    anchorFor(this.wall!, step.cell, this.toPos);
    this.player.position.copy(this.toPos);

    if (this.stamina.stamina <= 0) {
      this.finish('stamina');
      return;
    }
    if (step.cell.rest) {
      // 岩棚に乗った。息を整える
      this.restTimer = Math.max(0, (this.stamina.maxStamina - this.stamina.stamina) / CLIMB.ledgeRecoveryPerSec);
      this.action = 'REST';
      return;
    }
    this.advance();
  }

  private advance(): void {
    if (this.execIndex < this.plan.length - 1) {
      this.execIndex += 1;
      this.beginStep();
      return;
    }
    const last = this.current;
    if (last?.topOut && this.wall?.topOutPoint(last)) {
      this.topOut();
      return;
    }
    if (last?.rest) {
      const wall = this.wall!;
      this.mode = 'off';
      this.startPlanning(wall, last, this.player.position);
      this.onNotice?.('岩棚に着いた。ここから次のルートを組み立てる');
      return;
    }
    this.finish('stranded');
  }

  private topOut(): void {
    const wall = this.wall!;
    const point = wall.topOutPoint(this.current!);
    this.reset(wall);
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
    this.reset(wall);
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

  private reset(wall: ClimbWall | null): void {
    wall?.clearMarkers();
    this.mode = 'off';
    this.wall = null;
    this.current = null;
    this.plan.length = 0;
    this.planStart = null;
    this.useRope = false;
    this.routeLine.visible = false;
    this.routeGeometry.setDrawRange(0, 0);
  }

  // --- 更新 ---------------------------------------------------------------

  update(dt: number, hovered: Cell | null): void {
    if (this.mode === 'off' || !this.wall) return;

    if (this.mode === 'planning') {
      this.stamina.exertion = 0.1;
      this.action = 'REST';
      this.wall.setHover(hovered && this.canAppend(hovered) ? hovered : null);
      return;
    }

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
  }

  private updateRouteLine(): void {
    const attr = this.routeGeometry.attributes.position as THREE.BufferAttribute;
    const pts: THREE.Vector3[] = [];
    if (this.planStart?.pos) pts.push(this.planStart.pos);
    else if (this.plan.length) pts.push(this.basePos);
    for (const s of this.plan) if (s.cell.pos) pts.push(s.cell.pos);
    const count = Math.min(pts.length, ClimbingController.ROUTE_MAX);
    const n = this.wall?.frame.outward;
    for (let i = 0; i < count; i++) {
      attr.setXYZ(i, pts[i].x + (n?.x ?? 0) * 0.2, pts[i].y, pts[i].z + (n?.z ?? 0) * 0.2);
    }
    attr.needsUpdate = true;
    this.routeGeometry.setDrawRange(0, count);
    this.routeLine.visible = count >= 2;
  }
}
