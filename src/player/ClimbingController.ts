/* ===========================================================
   登攀。岩肌を見てルートを見つける。

   操作はリアルタイム。
     WASD  壁を基準にした方向を選ぶ (斜めも可)
     Space その方向の1セルへ登る
   1手ずつ進むので、次にどこへ手を出すかを岩肌を見ながら決め続ける。

   セルには Easy / Medium / Hard / Impossible の難易度があり、
   Impossible には入れない。だから方向キーがあってもルートは自明にならない。
   消費は「セル難易度 × 移動方向 + 移動距離」。

   岩棚に乗っている間はスタミナが戻る。
   スタミナが尽きれば落ちる。
   手足や個々のホールド位置はここでは扱わない。
   =========================================================== */

import * as THREE from 'three';
import { CLIMB, type PlayerAction } from '../core/types';
import type { ClimbWall } from '../mountain/cliff/ClimbWall';
import {
  aimBlocker,
  aimedCell,
  cellMoveCost,
  type Cell,
  type CellGrade,
} from '../mountain/cliff/grid';
import type { RopeSystem } from '../systems/RopeSystem';
import type { StaminaSystem } from '../systems/StaminaSystem';
import type { PlayerController } from './PlayerController';

export type ClimbMode = 'off' | 'climbing';
export type ReleaseReason = 'stepdown' | 'letgo' | 'stamina' | 'topout';

/** 次の一手の見込み。HUD に出す */
export interface NextMove {
  /** 方向の矢印 */
  arrow: string;
  grade: CellGrade | null;
  cost: number;
  staminaAfter: number;
  rest: boolean;
  /** 進める状態か */
  ok: boolean;
  /** 進めない理由 */
  reason: string;
  /** この一手で壁の上へ抜ける */
  topOut: boolean;
  /** この一手で地面へ降りる */
  stepDown: boolean;
}

const ARROWS: Record<string, string> = {
  '0,1': '↑',
  '1,1': '↗',
  '1,0': '→',
  '1,-1': '↘',
  '0,-1': '↓',
  '-1,-1': '↙',
  '-1,0': '←',
  '-1,1': '↖',
};

const _right = new THREE.Vector3();
const _wallUp = new THREE.Vector3();

/**
 * そのセルに取り付いているときのプレイヤーの位置 (足元)。
 * 掴んでいるセルが胸の高さに来るように下げる。
 * 下げる方向はワールドの真下ではなく壁面に沿った下向きにする。
 * 真下に下げると、寝た壁では岩にめり込んでしまう。
 */
function anchorFor(cell: Cell, out = new THREE.Vector3()): THREE.Vector3 {
  const n = cell.normal;
  const p = cell.pos!;
  if (cell.rest) return out.set(p.x + n.x * 0.36, p.y + 0.14, p.z + n.z * 0.36);
  _right.set(-n.z, 0, n.x).normalize();
  _wallUp.crossVectors(_right, n).normalize();
  return out.copy(p).addScaledVector(_wallUp, -1.15).addScaledVector(n, 0.42);
}

const smoothstep = (t: number) => t * t * (3 - 2 * t);

/** S を押し続けて手を放すまでの時間 (秒) */
const LET_GO_SEC = 1;

export class ClimbingController {
  mode: ClimbMode = 'off';
  wall: ClimbWall | null = null;
  action: PlayerAction = 'CLIMB';
  moveCount = 0;

  onEnter: ((wall: ClimbWall, from: Cell) => void) | null = null;
  onExit: ((reason: ReleaseReason) => void) | null = null;
  onNotice: ((message: string) => void) | null = null;
  onRopeFixed: ((wall: ClimbWall) => void) | null = null;

  readonly helpers = new THREE.Group();

  private current: Cell | null = null;
  private target: Cell | null = null;
  private aimX = 0;
  private aimY = 0;
  /** 画面の右が壁のどちら向きか (+1 / -1) */
  private tangentSign = 1;
  private elapsed = 0;
  private duration = 0;
  private letGoHold = 0;
  private readonly fromPos = new THREE.Vector3();
  private readonly toPos = new THREE.Vector3();

  private readonly trail: THREE.Line;
  private readonly trailGeometry: THREE.BufferGeometry;
  private readonly trailPoints: THREE.Vector3[] = [];
  private static readonly TRAIL_MAX = 64;

  constructor(
    private readonly player: PlayerController,
    private readonly stamina: StaminaSystem,
    private readonly ropes: RopeSystem,
  ) {
    this.trailGeometry = new THREE.BufferGeometry();
    this.trailGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(ClimbingController.TRAIL_MAX * 3), 3),
    );
    this.trailGeometry.setDrawRange(0, 0);
    this.trail = new THREE.Line(
      this.trailGeometry,
      new THREE.LineBasicMaterial({ color: 0xffd24a, transparent: true, opacity: 0.55, depthTest: false }),
    );
    this.trail.visible = false;
    this.trail.renderOrder = 4;
    this.trail.frustumCulled = false;
    this.helpers.add(this.trail);
  }

  get isClimbing(): boolean {
    return this.mode === 'climbing';
  }

  get currentCell(): Cell | null {
    return this.current;
  }

  get isMoving(): boolean {
    return this.duration > 0;
  }

  get costScale(): number {
    if (!this.wall) return 1;
    return this.ropes.hasRope(this.wall.id) ? CLIMB.ropeCostScale : 1;
  }

  // --- 取り付き -----------------------------------------------------------

  start(wall: ClimbWall, from: Cell | null, playerPos: THREE.Vector3): boolean {
    if (this.mode !== 'off') return false;
    if (this.stamina.stamina <= 1) {
      this.onNotice?.('スタミナが尽きている');
      return false;
    }
    let cell = from;
    if (!cell) {
      // 地上から取り付ける、いちばん近いセル
      let best: Cell | null = null;
      let bestD = Infinity;
      for (const c of wall.groundCells) {
        const d = c.pos!.distanceTo(playerPos);
        if (d < bestD && d <= CLIMB.grabRange + 2.0) {
          bestD = d;
          best = c;
        }
      }
      cell = best;
    }
    if (!cell) {
      this.onNotice?.('取り付ける場所が見つからない');
      return false;
    }

    this.mode = 'climbing';
    this.wall = wall;
    this.current = cell;
    this.target = null;
    this.duration = 0;
    this.letGoHold = 0;
    this.moveCount = 0;
    this.action = 'CLIMB';
    this.player.enabled = false;
    this.player.velocity.set(0, 0, 0);
    this.player.setPosition(anchorFor(cell));
    this.trailPoints.length = 0;
    this.pushTrail(cell);
    wall.clearMarkers();
    wall.setCurrent(cell);
    this.onEnter?.(wall, cell);
    return true;
  }

  // --- 方向と次の一手 -----------------------------------------------------

  /** 方向入力。dx は画面基準、内部で壁の向きへ直す */
  setAim(dx: number, dy: number, tangentSign: number): void {
    this.tangentSign = tangentSign || 1;
    this.aimX = Math.sign(dx);
    this.aimY = Math.sign(dy);
  }

  /**
   * いま狙っているセル。
   * 隣が平滑なら同じ方向へ手を伸ばす。判定は経路探索と同じものを使う。
   */
  get aimedCell(): Cell | null {
    if (!this.wall || !this.current) return null;
    return aimedCell(
      this.wall,
      this.current,
      this.aimX * this.tangentSign,
      this.aimY,
      CLIMB.distanceCost,
      this.costScale,
    );
  }

  /** 上へ抜けようとしているか (これ以上は壁が続いていない) */
  private get aimingOut(): boolean {
    if (!this.wall || !this.current) return false;
    if (this.aimY <= 0 || !this.current.topOut) return false;
    if (this.aimedCell) return false;
    return !!this.wall.topOutPoint(this.current);
  }

  /** 地面へ降りようとしているか */
  private get aimingDown(): boolean {
    if (!this.current) return false;
    return this.aimY < 0 && this.current.row === 0 && this.current.ground;
  }

  /** そちらへ行けない理由 */
  private blockedReason(): string {
    const wall = this.wall;
    const cur = this.current;
    if (!wall || !cur) return 'そちらに壁が無い';
    const blocked = aimBlocker(wall, cur, this.aimX * this.tangentSign, this.aimY);
    if (blocked) return '手がかりが無い';
    return this.aimY > 0 ? 'これ以上は登れない' : 'そちらに壁が無い';
  }

  /** 次の一手の見込み */
  nextMove(): NextMove {
    const blank: NextMove = {
      arrow: '・',
      grade: null,
      cost: 0,
      staminaAfter: this.stamina.stamina,
      rest: false,
      ok: false,
      reason: '方向を選ぶ',
      topOut: false,
      stepDown: false,
    };
    if (!this.current || this.isMoving) return blank;
    if (this.aimX === 0 && this.aimY === 0) return blank;

    const arrow = ARROWS[`${this.aimX},${this.aimY}`] ?? '・';
    if (this.aimingOut) {
      return { ...blank, arrow, ok: true, reason: '壁の上へ抜ける', topOut: true };
    }
    if (this.aimingDown) {
      return { ...blank, arrow, ok: true, reason: '地面へ降りる', stepDown: true };
    }

    const cell: Cell | null = this.aimedCell;
    if (!cell) return { ...blank, arrow, reason: this.blockedReason() };

    const cost = cellMoveCost(this.current, cell, CLIMB.distanceCost, this.costScale);
    const after = this.stamina.stamina - cost;
    if (!this.stamina.canAfford(cost)) {
      return { ...blank, arrow, grade: cell.grade, cost, staminaAfter: after, reason: 'スタミナが足りない' };
    }
    return {
      arrow,
      grade: cell.grade,
      cost,
      staminaAfter: after,
      rest: cell.rest,
      ok: true,
      reason: after <= 0 ? 'この一手で力尽きる' : '',
      topOut: false,
      stepDown: false,
    };
  }

  // --- 一手進む -----------------------------------------------------------

  /** Space。選んだ方向へ1セル登る */
  step(): boolean {
    if (this.mode !== 'climbing' || !this.current || !this.wall) return false;
    if (this.isMoving) return false;

    if (this.aimX === 0 && this.aimY === 0) {
      this.onNotice?.('WASD で方向を選ぶ');
      return false;
    }
    if (this.aimingOut) {
      this.topOut();
      return true;
    }
    if (this.aimingDown) {
      this.finish('stepdown');
      return true;
    }

    const cell = this.aimedCell;
    if (!cell) {
      this.onNotice?.(this.blockedReason());
      return false;
    }
    const cost = cellMoveCost(this.current, cell, CLIMB.distanceCost, this.costScale);
    if (!this.stamina.canAfford(cost)) {
      this.onNotice?.(`スタミナが足りない (必要 ${cost.toFixed(0)})`);
      return false;
    }

    this.stamina.consume(cost);
    const dist = this.current.pos!.distanceTo(cell.pos!);
    const dy = cell.pos!.y - this.current.pos!.y;
    this.action = Math.abs(dy) / Math.max(0.01, dist) < CLIMB.traverseSlope ? 'TRAVERSE' : 'CLIMB';
    this.target = cell;
    this.elapsed = 0;
    this.duration = CLIMB.moveBaseDuration + dist * CLIMB.moveDurationPerUnit;
    this.fromPos.copy(this.player.position);
    anchorFor(cell, this.toPos);
    this.wall.setTarget(cell);
    return true;
  }

  /** 手を放しかけている度合い (0..1)。HUD の警告に使う */
  get letGoRatio(): number {
    return Math.min(1, this.letGoHold / LET_GO_SEC);
  }

  /** S 長押しで手を放す。下端では降りるだけなので効かない */
  holdLetGo(dt: number, held: boolean): void {
    if (this.mode !== 'climbing' || !held || this.current?.row === 0) {
      this.letGoHold = 0;
      return;
    }
    this.letGoHold += dt;
    if (this.letGoHold >= LET_GO_SEC) {
      this.letGoHold = 0;
      this.finish('letgo');
    }
  }

  /** 右クリック。この岩壁にロープを固定する */
  fixRope(by: string): boolean {
    if (this.mode !== 'climbing' || !this.wall) return false;
    if (this.ropes.hasRope(this.wall.id)) {
      this.onNotice?.('この岩壁にはすでにロープがある');
      return false;
    }
    if (this.ropes.carried <= 0) {
      this.onNotice?.('ロープを使い切っている');
      return false;
    }
    this.ropes.fix(this.wall, by);
    this.onRopeFixed?.(this.wall);
    this.onNotice?.(`ロープを固定した (残り ${this.ropes.carried})`);
    return true;
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
    this.target = null;
    this.duration = 0;
    this.aimX = 0;
    this.aimY = 0;
    this.trail.visible = false;
    this.trailGeometry.setDrawRange(0, 0);
    this.trailPoints.length = 0;
  }

  // --- 更新 ---------------------------------------------------------------

  update(dt: number): void {
    if (this.mode !== 'climbing' || !this.wall) return;

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
        this.arrive();
      }
      return;
    }

    // 掴まって止まっている間
    if (this.current?.rest) {
      this.stamina.recover(CLIMB.ledgeRecoveryPerSec, dt);
      this.stamina.exertion = 0.15;
      this.action = 'REST';
    } else {
      this.stamina.exertion = 0.5;
      if (this.action === 'REST') this.action = 'CLIMB';
    }

    // 狙っているセルを示す
    this.wall.setTarget(this.aimedCell);
  }

  private arrive(): void {
    const cell = this.target!;
    this.current = cell;
    this.target = null;
    this.moveCount += 1;
    anchorFor(cell, this.toPos);
    this.player.position.copy(this.toPos);
    this.wall!.setCurrent(cell);
    this.pushTrail(cell);

    if (this.stamina.stamina <= 0) this.finish('stamina');
  }

  /** 登ってきた跡を線で残す (どこを通ったか分かるように) */
  private pushTrail(cell: Cell): void {
    if (!cell.pos) return;
    const n = cell.normal;
    this.trailPoints.push(new THREE.Vector3(cell.pos.x + n.x * 0.2, cell.pos.y + n.y * 0.2, cell.pos.z + n.z * 0.2));
    if (this.trailPoints.length > ClimbingController.TRAIL_MAX) this.trailPoints.shift();
    const attr = this.trailGeometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < this.trailPoints.length; i++) {
      const p = this.trailPoints[i];
      attr.setXYZ(i, p.x, p.y, p.z);
    }
    attr.needsUpdate = true;
    this.trailGeometry.setDrawRange(0, this.trailPoints.length);
    this.trail.visible = this.trailPoints.length >= 2;
  }
}
