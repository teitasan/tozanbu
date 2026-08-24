/* ===========================================================
   他プレイヤーの表示。受信は 10Hz 程度なので補間して滑らかに動かす。
   =========================================================== */

import * as THREE from 'three';
import { damp, dampAngle } from '../core/math';
import { ACTION_LABEL, type PlayerAction } from '../core/types';
import type { RemoteSnapshot } from './NetClient';

const COLORS = [0x4a90d9, 0x50b87a, 0xd9a441, 0xa96ed1, 0x4bbfc4, 0xd96e8a, 0x8fa84f];

interface Remote {
  id: string;
  name: string;
  group: THREE.Group;
  label: THREE.Sprite;
  target: THREE.Vector3;
  targetYaw: number;
  action: string;
  cur: number;
  max: number;
}

function makeLabel(text: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(10,14,20,0.65)';
  ctx.roundRect(4, 8, 248, 48, 10);
  ctx.fill();
  ctx.font = 'bold 30px "Hiragino Kaku Gothic ProN", sans-serif';
  ctx.fillStyle = '#eef2f7';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text.slice(0, 10), 128, 33);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sprite.scale.set(2.2, 0.55, 1);
  sprite.position.y = 2.4;
  sprite.renderOrder = 5;
  return sprite;
}

export class RemotePlayers {
  readonly group = new THREE.Group();
  private readonly players = new Map<string, Remote>();

  upsert(s: RemoteSnapshot): void {
    let r = this.players.get(s.id);
    if (!r) {
      const color = COLORS[this.players.size % COLORS.length];
      const g = new THREE.Group();
      const body = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.34, 0.86, 4, 10),
        new THREE.MeshStandardMaterial({ color, roughness: 0.75 }),
      );
      body.position.y = 0.87;
      body.castShadow = true;
      const head = new THREE.Mesh(
        new THREE.SphereGeometry(0.19, 10, 8),
        new THREE.MeshStandardMaterial({ color: 0xe8c49a, roughness: 0.9 }),
      );
      head.position.y = 1.63;
      g.add(body, head);
      const label = makeLabel(s.name);
      g.add(label);
      g.position.set(s.x, s.y, s.z);
      this.group.add(g);
      r = {
        id: s.id,
        name: s.name,
        group: g,
        label,
        target: new THREE.Vector3(s.x, s.y, s.z),
        targetYaw: s.yaw,
        action: s.a,
        cur: s.cur,
        max: s.max,
      };
      this.players.set(s.id, r);
    }
    r.target.set(s.x, s.y, s.z);
    r.targetYaw = s.yaw;
    r.action = s.a;
    r.cur = s.cur;
    r.max = s.max;
    if (s.name && s.name !== r.name) r.name = s.name;
  }

  remove(id: string): void {
    const r = this.players.get(id);
    if (!r) return;
    r.group.removeFromParent();
    (r.label.material as THREE.SpriteMaterial).map?.dispose();
    this.players.delete(id);
  }

  clear(): void {
    for (const id of [...this.players.keys()]) this.remove(id);
  }

  update(dt: number): void {
    for (const r of this.players.values()) {
      r.group.position.x = damp(r.group.position.x, r.target.x, 12, dt);
      r.group.position.y = damp(r.group.position.y, r.target.y, 12, dt);
      r.group.position.z = damp(r.group.position.z, r.target.z, 12, dt);
      r.group.rotation.y = dampAngle(r.group.rotation.y, r.targetYaw, 10, dt);
    }
  }

  get count(): number {
    return this.players.size;
  }

  /** HUD のパーティー表示用 */
  roster(): { name: string; altitude: number; stamina: number; maxStamina: number; action: string }[] {
    return [...this.players.values()].map((r) => ({
      name: r.name,
      altitude: r.target.y,
      stamina: r.cur,
      maxStamina: r.max,
      action: ACTION_LABEL[r.action as PlayerAction] ?? r.action,
    }));
  }
}
