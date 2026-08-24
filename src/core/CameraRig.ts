/* ===========================================================
   カメラ。三人称の肩越し視点ひとつで通常時と登攀時をまかなう。
   視点操作はマウス (ポインタロック)。画面中央のレティクルが
   そのままホールド選択のカーソルになる。
   =========================================================== */

import * as THREE from 'three';
import { clamp, damp } from './math';
import type { Input } from './Input';
import { MOVE } from './types';
import type { Heightfield } from '../mountain/Heightfield';

const LOOK_SENS = 0.0022;

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  yaw = 0;
  pitch = 0.02;

  /** 登攀中は壁が見えるように引く */
  private distance = 5.4;
  private targetDistance = 5.4;
  private lateral = 0;
  private readonly desired = new THREE.Vector3();
  private readonly focus = new THREE.Vector3();
  private readonly aim = new THREE.Vector3(0, 0, -1);
  private readonly lookTarget = new THREE.Vector3();
  /** ルートを組み立てる間、岩壁全体が見える位置に据える */
  private planCenter: THREE.Vector3 | null = null;
  private planDistance = 20;
  private readonly toCam = new THREE.Vector3();
  private readonly ray = new THREE.Raycaster();
  /** カメラがめり込むと困るもの (地形・樹木など) */
  private colliders: THREE.Object3D[] = [];

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(60, aspect, 0.12, 2200);
  }

  setColliders(objects: THREE.Object3D[]): void {
    this.colliders = objects;
  }

  /** 岩壁を下から見上げる視点にする */
  setPlanView(base: THREE.Vector3, outward: THREE.Vector3, height: number): void {
    this.planCenter = new THREE.Vector3(base.x, base.y + height * 0.45, base.z);
    // 壁全体が画面に収まる距離 (縦画角 60 度)
    this.planDistance = THREE.MathUtils.clamp(height * 1.25 + 8, 16, 60);
    this.yaw = Math.atan2(outward.x, outward.z);
    this.pitch = -0.26;
  }

  clearPlanView(): void {
    this.planCenter = null;
  }

  get isPlanView(): boolean {
    return this.planCenter !== null;
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** 水平の正面ベクトル */
  forward(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  update(dt: number, target: THREE.Vector3, climbing: boolean, input: Input, field: Heightfield): void {
    if (input.lookX || input.lookY) {
      this.yaw -= input.lookX * LOOK_SENS;
      this.pitch = clamp(this.pitch + input.lookY * LOOK_SENS, -0.9, 1.15);
    }

    const planning = this.planCenter !== null;
    if (planning && input.zoomDelta) {
      this.planDistance = THREE.MathUtils.clamp(this.planDistance + input.zoomDelta * 2.5, 8, 90);
    }
    this.targetDistance = planning ? this.planDistance : climbing ? 6.6 : 5.4;
    // 登攀中は肩越しの量を増やす。プレイヤーを画面中央から外して、
    // レティクルが自分ではなく壁のホールドを指すようにする
    const wantLateral = planning ? 0 : climbing ? 2.0 : 0.9;
    this.distance = damp(this.distance, this.targetDistance, planning ? 6 : 4, dt);
    this.lateral = damp(this.lateral, wantLateral, 4, dt);

    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    if (planning) this.focus.copy(this.planCenter!);
    else this.focus.set(target.x, target.y + MOVE.eyeHeight, target.z);

    // 照準方向 (プレイヤーが見ている向き)
    this.aim.set(-Math.sin(this.yaw) * cp, -sp, -Math.cos(this.yaw) * cp);
    const rightX = Math.cos(this.yaw);
    const rightZ = -Math.sin(this.yaw);

    this.desired.set(
      this.focus.x - this.aim.x * this.distance + rightX * this.lateral,
      this.focus.y - this.aim.y * this.distance + 0.25,
      this.focus.z - this.aim.z * this.distance + rightZ * this.lateral,
    );

    // 地形にめり込ませない
    if (field.inside(this.desired.x, this.desired.z)) {
      const ground = field.heightAt(this.desired.x, this.desired.z) + 0.55;
      if (this.desired.y < ground) this.desired.y = ground;
    }

    // 樹木などに遮られたら手前に寄せる
    if (this.colliders.length) {
      this.toCam.subVectors(this.desired, this.focus);
      const dist = this.toCam.length();
      if (dist > 0.2) {
        this.ray.set(this.focus, this.toCam.divideScalar(dist));
        this.ray.far = dist;
        const hit = this.ray.intersectObjects(this.colliders, false)[0];
        if (hit && hit.distance < dist) {
          const d = Math.max(1.1, hit.distance - 0.35);
          this.desired.copy(this.focus).addScaledVector(this.ray.ray.direction, d);
        }
      }
    }

    this.camera.position.lerp(this.desired, 1 - Math.exp(-16 * dt));
    // 注視点をプレイヤーではなく「照準の先」に置く。
    // プレイヤーを見てしまうと、画面中央のレティクルが常に自分に当たる
    this.lookTarget.copy(this.camera.position).addScaledVector(this.aim, 200);
    this.camera.lookAt(this.lookTarget);
  }

  /** 初期化時に即座に合わせる */
  snap(target: THREE.Vector3, field: Heightfield): void {
    this.update(1, target, false, { lookX: 0, lookY: 0 } as Input, field);
    this.camera.position.copy(this.desired);
    this.lookTarget.copy(this.camera.position).addScaledVector(this.aim, 200);
    this.camera.lookAt(this.lookTarget);
  }
}
