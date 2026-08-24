/* ===========================================================
   岩壁上の1つの登攀可能箇所。
   掴みやすさ (type) / 必要到達距離 (位置) / スタミナ消費 (baseStaminaCost)
   を持つ。
   =========================================================== */

import * as THREE from 'three';
import { HOLD_BASE_COST, HOLD_COLOR, type HoldData, type HoldType } from '../../core/types';

export type HoldVisual =
  | 'idle' // 通常表示 (射程外 / 選択不可)
  | 'reachable' // 射程内かつスタミナが足りる = 次の手にできる
  | 'tooExpensive' // 射程内だがスタミナが尽きる
  | 'hover' // マウスオーバー中
  | 'planned' // 組み立てたルートに入っている
  | 'current'; // 現在の手 / ルートの先端

const HALO_COLOR: Record<HoldVisual, number> = {
  idle: 0x000000,
  reachable: 0x76ff9c,
  tooExpensive: 0xff5555,
  hover: 0xffffff,
  planned: 0xffd24a,
  current: 0xffffff,
};

const GEOMETRY: Partial<Record<HoldType, THREE.BufferGeometry>> = {};

function geometryFor(type: HoldType): THREE.BufferGeometry {
  let g = GEOMETRY[type];
  if (g) return g;
  switch (type) {
    case 'large':
      g = new THREE.BoxGeometry(0.62, 0.4, 0.34);
      break;
    case 'normal':
      g = new THREE.BoxGeometry(0.44, 0.28, 0.26);
      break;
    case 'small':
      g = new THREE.BoxGeometry(0.26, 0.18, 0.17);
      break;
    case 'bad':
      g = new THREE.IcosahedronGeometry(0.23, 0);
      break;
    case 'ledge':
      g = new THREE.BoxGeometry(1.6, 0.22, 0.75);
      break;
  }
  GEOMETRY[type] = g;
  return g;
}

let HALO_GEO_SMALL: THREE.TorusGeometry | null = null;
let HALO_GEO_LEDGE: THREE.TorusGeometry | null = null;
let PICK_GEO_SMALL: THREE.SphereGeometry | null = null;
let PICK_GEO_LEDGE: THREE.SphereGeometry | null = null;

export interface HoldInit {
  id: string;
  type: HoldType;
  position: THREE.Vector3;
  /** 壁の外向き法線 (水平) */
  normal: THREE.Vector3;
  /** 壁の上端。ここから Space でマントリングして地形へ抜けられる */
  topOut?: boolean;
  /** 地上から取り付けるホールド */
  ground?: boolean;
}

export class Hold implements HoldData {
  readonly id: string;
  readonly type: HoldType;
  readonly position: THREE.Vector3;
  readonly baseStaminaCost: number;
  readonly normal: THREE.Vector3;
  readonly topOut: boolean;
  readonly ground: boolean;

  readonly group = new THREE.Group();
  readonly pickTarget: THREE.Mesh;

  private readonly material: THREE.MeshStandardMaterial;
  private readonly halo: THREE.Mesh;
  private readonly haloMaterial: THREE.MeshBasicMaterial;
  private visual: HoldVisual = 'idle';
  private pulse = 0;

  constructor(init: HoldInit) {
    this.id = init.id;
    this.type = init.type;
    this.position = init.position.clone();
    this.normal = init.normal.clone().normalize();
    this.baseStaminaCost = HOLD_BASE_COST[init.type];
    this.topOut = init.topOut === true;
    this.ground = init.ground === true;

    this.material = new THREE.MeshStandardMaterial({
      color: HOLD_COLOR[init.type],
      roughness: 0.85,
      metalness: 0,
      emissive: new THREE.Color(0x000000),
    });

    const mesh = new THREE.Mesh(geometryFor(init.type), this.material);
    mesh.castShadow = true;
    this.group.add(mesh);

    HALO_GEO_SMALL ??= new THREE.TorusGeometry(0.48, 0.05, 8, 24);
    HALO_GEO_LEDGE ??= new THREE.TorusGeometry(0.95, 0.06, 8, 28);
    this.haloMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthTest: false,
    });
    this.halo = new THREE.Mesh(init.type === 'ledge' ? HALO_GEO_LEDGE : HALO_GEO_SMALL, this.haloMaterial);
    this.halo.position.z = 0.3;
    this.halo.renderOrder = 3;
    this.halo.visible = false;
    this.group.add(this.halo);

    PICK_GEO_SMALL ??= new THREE.SphereGeometry(0.46, 8, 6);
    PICK_GEO_LEDGE ??= new THREE.SphereGeometry(0.8, 8, 6);
    this.pickTarget = new THREE.Mesh(
      init.type === 'ledge' ? PICK_GEO_LEDGE : PICK_GEO_SMALL,
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    this.pickTarget.userData.holdId = this.id;
    this.group.add(this.pickTarget);

    // 壁の法線を向ける (ローカル +Z を法線に合わせる)
    this.group.position.copy(this.position);
    this.group.lookAt(this.position.clone().add(this.normal));
  }

  setVisual(visual: HoldVisual): void {
    if (this.visual === visual) return;
    this.visual = visual;
    switch (visual) {
      case 'idle':
        this.material.emissive.setHex(0x000000);
        this.material.emissiveIntensity = 0;
        break;
      case 'tooExpensive':
        this.material.emissive.setHex(0xff3020);
        this.material.emissiveIntensity = 0.3;
        break;
      case 'current':
        this.material.emissive.setHex(0xffffff);
        this.material.emissiveIntensity = 0.5;
        break;
      case 'planned':
        this.material.emissive.setHex(HALO_COLOR.planned);
        this.material.emissiveIntensity = 0.7;
        break;
      case 'reachable':
        this.material.emissive.setHex(HOLD_COLOR[this.type]);
        this.material.emissiveIntensity = 0.4;
        break;
      case 'hover':
        this.material.emissive.setHex(HOLD_COLOR[this.type]);
        this.material.emissiveIntensity = 0.75;
        break;
    }
    this.haloMaterial.color.setHex(HALO_COLOR[visual]);
  }

  update(dt: number): void {
    this.pulse = (this.pulse + dt) % 10;
    let target = 0;
    switch (this.visual) {
      case 'idle':
        target = 0;
        break;
      case 'tooExpensive':
        target = 0.34;
        break;
      case 'reachable':
        target = 0.5 + Math.sin(this.pulse * 4) * 0.14;
        break;
      case 'hover':
        target = 1;
        break;
      case 'current':
        target = 0.9;
        break;
      case 'planned':
        target = 0.85;
        break;
    }
    this.haloMaterial.opacity += (target - this.haloMaterial.opacity) * Math.min(1, dt * 14);
    this.halo.visible = this.haloMaterial.opacity > 0.02;
  }

  distanceTo(other: Hold): number {
    return this.position.distanceTo(other.position);
  }

  dispose(): void {
    this.material.dispose();
    this.haloMaterial.dispose();
    (this.pickTarget.material as THREE.Material).dispose();
  }
}
