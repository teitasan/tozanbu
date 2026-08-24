/* ===========================================================
   通常時のプレイヤー。
   歩行 / ダッシュ / ジャンプ / マントリング / 落下 / ラッセル を担当する。
   専用キーは作らず、地形との関係で同じ入力の意味が変わる。
   =========================================================== */

import * as THREE from 'three';
import { clamp, dampAngle } from '../core/math';
import type { Input } from '../core/Input';
import { MOVE, STAMINA, type PlayerAction } from '../core/types';
import type { Heightfield } from '../mountain/Heightfield';
import type { SnowSystem } from '../systems/SnowSystem';
import type { StaminaSystem } from '../systems/StaminaSystem';

/** 歩いて登れる上昇率 (tan)。岩壁の判定と同じ値を使う */
const WALK_GRADIENT = Math.tan(MOVE.maxWalkSlope);
/** 立っていられる上昇率 */
const STAND_GRADIENT = Math.tan(MOVE.maxStandSlope);
/**
 * 斜度を測る距離。
 * ハイトフィールドは2m格子の補間なので、中心差分の斜度はテラスの縁で
 * 実際より急に出てしまう。進行方向へ実際にどれだけ上がるかで判定する。
 */
const SLOPE_PROBE = 1.2;

export interface MoveContext {
  field: Heightfield;
  snow: SnowSystem;
  stamina: StaminaSystem;
}

interface MantleState {
  active: boolean;
  t: number;
  from: THREE.Vector3;
  to: THREE.Vector3;
}

export class PlayerController {
  /** 足元の位置 */
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  readonly object = new THREE.Group();

  /** 登攀中は false になり ClimbingController が位置を持つ */
  enabled = true;
  grounded = true;
  action: PlayerAction = 'WALK';
  /** 進行方向の向き (表示用) */
  facing = 0;

  /** 正面が壁に阻まれている時間 (登攀への移行判定に使う) */
  blockedTime = 0;
  /** 前進入力が入っているか */
  pushingForward = false;
  /** 直近フレームの実効速度 */
  speed = 0;

  private readonly mantle: MantleState = {
    active: false,
    t: 0,
    from: new THREE.Vector3(),
    to: new THREE.Vector3(),
  };
  private readonly body: THREE.Group;
  private stepPhase = 0;

  constructor() {
    this.body = buildClimberMesh();
    this.object.add(this.body);
  }

  get isMantling(): boolean {
    return this.mantle.active;
  }

  reset(x: number, y: number, z: number): void {
    this.position.set(x, y, z);
    this.velocity.set(0, 0, 0);
    this.enabled = true;
    this.grounded = true;
    this.action = 'WALK';
    this.mantle.active = false;
    this.blockedTime = 0;
  }

  setPosition(v: THREE.Vector3): void {
    this.position.copy(v);
  }

  /** 正面ベクトル (水平) */
  forwardVector(yaw: number, out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(-Math.sin(yaw), 0, -Math.cos(yaw));
  }

  update(dt: number, input: Input, yaw: number, ctx: MoveContext): void {
    this.syncVisual(dt);
    if (!this.enabled) return;

    if (this.mantle.active) {
      this.updateMantle(dt, ctx);
      return;
    }

    const { field, snow, stamina } = ctx;

    // --- 入力 ---
    let ix = 0;
    let iz = 0;
    if (input.isDown('KeyW')) iz -= 1;
    if (input.isDown('KeyS')) iz += 1;
    if (input.isDown('KeyA')) ix -= 1;
    if (input.isDown('KeyD')) ix += 1;
    this.pushingForward = iz < 0;

    const len = Math.hypot(ix, iz);
    let dirX = 0;
    let dirZ = 0;
    if (len > 0) {
      const sy = Math.sin(yaw);
      const cy = Math.cos(yaw);
      // 前方 = (-sin yaw, -cos yaw) / 右 = (cos yaw, -sin yaw)
      // W は iz = -1 なので、前方成分は iz をそのまま掛ける
      dirX = (iz * sy + ix * cy) / len;
      dirZ = (iz * cy - ix * sy) / len;
    }

    // --- 積雪 ---
    // 自分が踏み固めた足元ではなく、これから踏み込む少し先の雪で判定する。
    // そうしないとラッセルの先頭が自分の踏み跡で楽をしてしまう
    const probeX = this.position.x + dirX * 1.3;
    const probeZ = this.position.z + dirZ * 1.3;
    const snowState = len > 0 ? snow.evaluate(probeX, probeZ) : snow.evaluate(this.position.x, this.position.z);

    // --- 速度 ---
    const wantDash = input.isDown('ShiftLeft') || input.isDown('ShiftRight');
    const canDash = wantDash && stamina.stamina > 1 && len > 0 && this.grounded;
    let speed = canDash ? MOVE.dashSpeed : MOVE.walkSpeed;
    speed *= snowState.speedScale;

    // 上り坂は遅くなる
    if (len > 0) {
      const g = field.gradientAt(this.position.x, this.position.z);
      const up = g.gx * dirX + g.gz * dirZ;
      if (up > 0) speed *= 1 / (1 + up * 0.9);
    }
    this.speed = len > 0 ? speed : 0;

    // --- ジャンプ / マントリング (同じ Space) ---
    if (input.wasPressed('Space') && this.grounded) {
      const target = this.mantleTarget(field, yaw);
      if (target) {
        this.beginMantle(target, stamina);
      } else if (stamina.canAfford(STAMINA.jumpCost)) {
        stamina.consume(STAMINA.jumpCost);
        this.velocity.y = MOVE.jumpSpeed;
        this.grounded = false;
        this.action = 'JUMP';
      }
    }

    // --- 水平移動 ---
    // 空中では操作が効きにくくなり、代わりに慣性 (velocity) で流される
    let dx = dirX * speed * dt;
    let dz = dirZ * speed * dt;
    if (!this.grounded) {
      dx = dirX * speed * 0.5 * dt + this.velocity.x * dt;
      dz = dirZ * speed * 0.5 * dt + this.velocity.z * dt;
      const drag = Math.exp(-1.5 * dt);
      this.velocity.x *= drag;
      this.velocity.z *= drag;
    }

    let blocked = false;
    if (dx !== 0 || dz !== 0) {
      const mx = dx === 0 ? 0 : Math.sign(dx);
      const mz = dz === 0 ? 0 : Math.sign(dz);
      if (!this.tryMove(this.position.x + dx, this.position.z + dz, field, dirX || mx, dirZ || mz)) {
        // 正面が塞がっている = 壁。横滑りはさせるが「押し当てている」判定は立てる
        blocked = true;
        if (!this.tryMove(this.position.x + dx, this.position.z, field, dirX || mx, 0)) {
          this.tryMove(this.position.x, this.position.z + dz, field, 0, dirZ || mz);
        }
      }
    }
    if (len > 0) this.facing = Math.atan2(dirX, dirZ);
    this.blockedTime = blocked && this.pushingForward && this.grounded ? this.blockedTime + dt : 0;

    // --- 重力と接地 ---
    const ground = field.heightAt(this.position.x, this.position.z);
    if (!this.grounded) {
      this.velocity.y -= MOVE.gravity * dt;
      this.position.y += this.velocity.y * dt;
      if (this.position.y <= ground) {
        this.position.y = ground;
        if (this.canStandAt(this.position.x, this.position.z, field)) {
          this.velocity.y = 0;
          this.grounded = true;
        } else {
          // 立てない急斜面。掴まらずに落ちるので、そのまま下へ流される。
          // これが無いと、壁に向かってジャンプを繰り返すだけで崖を登れてしまう
          const g = field.gradientAt(this.position.x, this.position.z);
          const gl = Math.hypot(g.gx, g.gz) || 1;
          this.velocity.x = (-g.gx / gl) * 4.5;
          this.velocity.z = (-g.gz / gl) * 4.5;
          this.velocity.y = -1.5;
          this.position.y = ground + 0.02;
        }
      }
    } else {
      this.position.y = ground;
    }

    // --- スタミナと状態 ---
    let exertion = 0;
    if (!this.grounded) {
      this.action = this.velocity.y > 0 ? 'JUMP' : 'FALL';
      exertion = 0.2;
    } else if (snowState.russelling && len > 0) {
      this.action = 'RUSSELL';
      stamina.drain(snowState.drain, dt);
      exertion = 0.9;
    } else if (canDash) {
      this.action = 'DASH';
      stamina.drain(STAMINA.dashDrain, dt);
      exertion = 1;
    } else if (len > 0) {
      this.action = 'WALK';
      stamina.recover(STAMINA.walkRecovery, dt);
      exertion = 0.3;
    } else {
      this.action = 'REST';
      stamina.recover(STAMINA.restRecovery, dt);
      exertion = 0;
    }
    stamina.exertion = exertion;

    // --- 踏み跡 ---
    if (this.grounded && len > 0 && snowState.depth > 0.05) {
      snow.stamp(this.position.x, this.position.z, dt * 2.2);
    }

    // 足音まわりの位相 (見た目の上下動に使う)
    this.stepPhase += dt * (this.speed * 1.6);
  }

  /**
   * そこに立てるか。
   * 「歩いて登れる」より「立っていられる」の方が緩い。
   * 急斜面は登れないが、立って横切ったり下ったりはできる。
   * 周囲の実際の高低差で測る (中心差分だとテラスの縁で誤判定する)。
   */
  private canStandAt(x: number, z: number, field: Heightfield): boolean {
    const h = field.heightAt(x, z);
    const r = 0.8;
    for (const [dx, dz] of [
      [r, 0],
      [-r, 0],
      [0, r],
      [0, -r],
    ]) {
      if (!field.inside(x + dx, z + dz)) continue;
      if (Math.abs(field.heightAt(x + dx, z + dz) - h) / r > STAND_GRADIENT) return false;
    }
    return true;
  }

  /**
   * 移動できるか。段差と斜度で判定する。
   * 斜度は足元だけでなく少し先も見る。ハイトフィールドの補間のせいで
   * 足元だけ見ると壁の直前でも緩く出てしまい、壁を登れてしまうため。
   */
  private tryMove(nx: number, nz: number, field: Heightfield, dirX: number, dirZ: number): boolean {
    if (!field.inside(nx, nz)) return false;
    const h = field.heightAt(nx, nz);
    const dh = h - this.position.y;
    if (this.grounded) {
      if (dh > MOVE.stepUp) return false;
      // 進行方向の実際の上昇率で判定する。
      // 岩壁の検出 (WallFinder.probe) と同じ尺度なので、
      // 「歩けないのに登れもしない」斜面ができない
      // 起点は現在地。岩壁の検出と同じ原点・同じ距離で測る
      const ax = this.position.x + dirX * SLOPE_PROBE;
      const az = this.position.z + dirZ * SLOPE_PROBE;
      if (field.inside(ax, az)) {
        const rise = field.heightAt(ax, az) - this.position.y;
        if (rise / SLOPE_PROBE > WALK_GRADIENT) return false;
      }
    } else if (dh > 0.05) {
      // 空中でも岩には潜り込めない (足より高い岩には入れない)
      return false;
    }
    this.position.x = nx;
    this.position.z = nz;
    if (this.grounded && dh < -0.7) {
      // 崖から踏み外した
      this.grounded = false;
      this.velocity.y = 0;
    }
    return true;
  }

  /**
   * 正面にマントリングできる段差があるか。
   * 段差の上が「棚」になっている (先まで平らで歩ける) ことを条件にする。
   * これが無いと、崖の途中でも Space の連打で梯子のように登れてしまう。
   */
  mantleTarget(field: Heightfield, yaw: number, out = new THREE.Vector3()): THREE.Vector3 | null {
    const f = this.forwardVector(yaw);
    for (let d = 0.5; d <= 1.9; d += 0.2) {
      const x = this.position.x + f.x * d;
      const z = this.position.z + f.z * d;
      if (!field.inside(x, z)) return null;
      const h = field.heightAt(x, z);
      const dh = h - this.position.y;
      if (dh < MOVE.mantleMin || dh > MOVE.mantleMax) continue;

      // 縁の先が平らに続いているか
      let shelf = true;
      let landing = h;
      for (const ahead of [0.9, 1.6, 2.4]) {
        const px = this.position.x + f.x * (d + ahead);
        const pz = this.position.z + f.z * (d + ahead);
        if (!field.inside(px, pz)) {
          shelf = false;
          break;
        }
        const ph = field.heightAt(px, pz);
        if (Math.abs(ph - h) > 0.7 || field.slopeAt(px, pz) > 0.7) {
          shelf = false;
          break;
        }
        if (ahead === 0.9) landing = ph;
      }
      if (!shelf) continue;

      return out.set(this.position.x + f.x * (d + 0.9), landing, this.position.z + f.z * (d + 0.9));
    }
    return null;
  }

  beginMantle(target: THREE.Vector3, stamina: StaminaSystem): boolean {
    if (!stamina.canAfford(STAMINA.mantleCost)) return false;
    stamina.consume(STAMINA.mantleCost);
    this.mantle.active = true;
    this.mantle.t = 0;
    this.mantle.from.copy(this.position);
    this.mantle.to.copy(target);
    this.velocity.set(0, 0, 0);
    this.grounded = false;
    this.action = 'MANTLE';
    this.enabled = true;
    return true;
  }

  private updateMantle(dt: number, ctx: MoveContext): void {
    const m = this.mantle;
    m.t += dt / MOVE.mantleDuration;
    const t = clamp(m.t, 0, 1);
    // 先に上へ、あとから前へ
    const up = Math.min(1, t * 1.7);
    const fwd = Math.max(0, (t - 0.35) / 0.65);
    this.position.x = m.from.x + (m.to.x - m.from.x) * fwd;
    this.position.z = m.from.z + (m.to.z - m.from.z) * fwd;
    this.position.y = m.from.y + (m.to.y + 0.25 - m.from.y) * up;
    ctx.stamina.exertion = 1;
    if (t >= 1) {
      m.active = false;
      this.grounded = true;
      this.position.copy(m.to);
      this.action = 'WALK';
    }
  }

  /** 見た目の追従 */
  private syncVisual(dt: number): void {
    this.object.position.copy(this.position);
    this.object.rotation.y = dampAngle(this.object.rotation.y, this.facing, 12, dt);
    const bob = this.action === 'REST' ? 0 : Math.sin(this.stepPhase * 6) * 0.045;
    // カプセル (半径 0.34 / 円柱部 0.86) の中心は足元から 0.77m
    this.body.position.y = 0.77 + bob;
  }

  setVisible(v: boolean): void {
    this.body.visible = v;
  }
}

/** 簡単な人型 (カプセル + 頭 + ザック) */
function buildClimberMesh(): THREE.Group {
  const g = new THREE.Group();
  const jacket = new THREE.MeshStandardMaterial({ color: 0xd94f30, roughness: 0.75 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xe8c49a, roughness: 0.9 });
  const pack = new THREE.MeshStandardMaterial({ color: 0x3a4a63, roughness: 0.9 });

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.34, 0.86, 4, 10), jacket);
  torso.castShadow = true;
  g.add(torso);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.19, 10, 8), skin);
  head.position.y = 0.76;
  head.castShadow = true;
  g.add(head);

  const bag = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.62, 0.28), pack);
  bag.position.set(0, 0.16, 0.34);
  bag.castShadow = true;
  g.add(bag);

  return g;
}
