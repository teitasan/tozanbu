/* ===========================================================
   ハイトフィールドから山の見た目を作る。
   地形メッシュ (頂点色) + 樹木 + 転石。
   踏み跡テクスチャをシェーダに差し込んで、雪面の踏み固めを表示する。
   =========================================================== */

import * as THREE from 'three';
import { clamp01 } from '../core/math';
import { makeRng } from '../core/rng';
import type { Heightfield } from './Heightfield';
import type { SurfaceMap } from './SurfaceMap';

const _c = new THREE.Color();
const _q = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/**
 * カメラのすぐ手前にある樹木を、ディザで間引いて消す。
 * 三人称カメラが林の中に入ったときに視界が塞がるのを防ぐ。
 */
function applyNearFade(mat: THREE.Material, fadeStart = 0.9, fadeEnd = 2.6): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uFadeStart = { value: fadeStart };
    shader.uniforms.uFadeEnd = { value: fadeEnd };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vViewDist;')
      .replace('#include <project_vertex>', '#include <project_vertex>\n\tvViewDist = -mvPosition.z;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying float vViewDist;\nuniform float uFadeStart;\nuniform float uFadeEnd;',
      )
      .replace(
        '#include <clipping_planes_fragment>',
        '#include <clipping_planes_fragment>\n' +
          '\tfloat nearFade = smoothstep(uFadeStart, uFadeEnd, vViewDist);\n' +
          '\tif (nearFade < 1.0) {\n' +
          '\t\tfloat dither = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);\n' +
          '\t\tif (nearFade < dither) discard;\n' +
          '\t}',
      );
  };
}

export class MountainMesh {
  readonly group = new THREE.Group();
  readonly terrain: THREE.Mesh;

  constructor(
    private readonly field: Heightfield,
    private readonly surface: SurfaceMap,
    trailTexture: THREE.Texture,
    seed: number,
  ) {
    this.terrain = this.buildTerrain(trailTexture);
    this.group.add(this.terrain);
    this.buildScatter(seed);
  }

  private buildTerrain(trailTexture: THREE.Texture): THREE.Mesh {
    const { n, step, half } = this.field;
    const count = n * n;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);

    for (let j = 0; j < n; j++) {
      const z = -half + j * step;
      for (let i = 0; i < n; i++) {
        const x = -half + i * step;
        const k = (j * n + i) * 3;
        const h = this.field.gridHeight(i, j);
        positions[k] = x;
        positions[k + 1] = h;
        positions[k + 2] = z;
        // 勾配はグリッドから直接求める (バイリニア補間を挟まないぶん速い)
        const gx = (this.field.gridHeight(i + 1, j) - this.field.gridHeight(i - 1, j)) / (2 * step);
        const gz = (this.field.gridHeight(i, j + 1) - this.field.gridHeight(i, j - 1)) / (2 * step);
        this.surface.colorFromGrid(x, z, h, gx, gz, this.field.gridCliff(i, j), _c);
        colors[k] = _c.r;
        colors[k + 1] = _c.g;
        colors[k + 2] = _c.b;
      }
    }

    const quads = (n - 1) * (n - 1);
    const index = new Uint32Array(quads * 6);
    let p = 0;
    for (let j = 0; j < n - 1; j++) {
      for (let i = 0; i < n - 1; i++) {
        const a = j * n + i;
        const b = a + 1;
        const c = a + n;
        const d = c + 1;
        index[p++] = a;
        index[p++] = c;
        index[p++] = b;
        index[p++] = b;
        index[p++] = c;
        index[p++] = d;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 1,
      metalness: 0,
      flatShading: true,
    });

    const worldSize = this.field.size;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTrail = { value: trailTexture };
      shader.uniforms.uWorldSize = { value: worldSize };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vTrailUv;\nuniform float uWorldSize;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvTrailUv = position.xz / uWorldSize + 0.5;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vTrailUv;\nuniform sampler2D uTrail;')
        .replace(
          '#include <color_fragment>',
          '#include <color_fragment>\n\tfloat packedSnow = texture2D(uTrail, vTrailUv).r;\n' +
            '\tdiffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.66, 0.73, 0.86), packedSnow * 0.9);',
        );
    };

    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.name = 'terrain';
    return mesh;
  }

  /** 樹木と転石。決定論的に配置する */
  private buildScatter(seed: number): void {
    const rng = makeRng(seed + 4201);
    const { half } = this.field;
    const treeTrunks: THREE.Matrix4[] = [];
    const treeCrowns: THREE.Matrix4[] = [];
    const treeTints: number[] = [];
    const rocks: THREE.Matrix4[] = [];
    const rockTints: number[] = [];

    const stepXZ = 5;
    for (let z = -half + 8; z < half - 8; z += stepXZ) {
      for (let x = -half + 8; x < half - 8; x += stepXZ) {
        const jx = x + (rng() - 0.5) * stepXZ * 0.9;
        const jz = z + (rng() - 0.5) * stepXZ * 0.9;
        const s = this.surface.surfaceAt(jx, jz);
        const slope = this.field.slopeAt(jx, jz);
        const y = this.field.heightAt(jx, jz);

        // 樹木
        if (s.vegetation > 0.32 && slope < 0.66 && s.snow < 0.12 && rng() < s.vegetation * 1.05) {
          const h = 3.2 + rng() * 4.4 * clamp01(s.vegetation);
          const r = h * (0.16 + rng() * 0.07);
          _pos.set(jx, y, jz);
          _q.identity();
          _scale.set(r, h, r);
          treeTrunks.push(new THREE.Matrix4().compose(_pos.clone().setY(y + h * 0.16), _q, _scale.clone().set(r * 0.28, h * 0.34, r * 0.28)));
          treeCrowns.push(new THREE.Matrix4().compose(_pos.clone().setY(y + h * 0.58), _q, _scale.clone().set(r, h * 0.82, r)));
          treeTints.push(0.75 + rng() * 0.5);
          continue;
        }

        // 転石
        if (s.rock > 0.2 && slope < 0.95 && rng() < 0.16 + s.rock * 0.22) {
          const r = 0.4 + rng() * (1.6 + s.rock * 2.2);
          _pos.set(jx, y + r * 0.35, jz);
          _q.setFromAxisAngle(_up, rng() * Math.PI * 2);
          _scale.set(r, r * (0.6 + rng() * 0.5), r * (0.8 + rng() * 0.4));
          rocks.push(new THREE.Matrix4().compose(_pos, _q, _scale));
          rockTints.push(0.8 + rng() * 0.45);
        }
      }
    }

    if (treeCrowns.length) {
      const trunkMesh = new THREE.InstancedMesh(
        new THREE.CylinderGeometry(0.6, 1, 1, 5),
        new THREE.MeshStandardMaterial({ color: 0x4a3826, roughness: 1, flatShading: true }),
        treeTrunks.length,
      );
      const crownMesh = new THREE.InstancedMesh(
        new THREE.ConeGeometry(1, 1, 6),
        // instanceColor が乗算されるので、マテリアル側は白にしておく
        new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, flatShading: true }),
        treeCrowns.length,
      );
      for (let i = 0; i < treeCrowns.length; i++) {
        trunkMesh.setMatrixAt(i, treeTrunks[i]);
        crownMesh.setMatrixAt(i, treeCrowns[i]);
        crownMesh.setColorAt(i, _c.setHSL(0.27 + (treeTints[i] - 1) * 0.05, 0.36, 0.19 + treeTints[i] * 0.11));
      }
      applyNearFade(trunkMesh.material as THREE.Material);
      applyNearFade(crownMesh.material as THREE.Material);
      trunkMesh.castShadow = true;
      crownMesh.castShadow = true;
      trunkMesh.instanceMatrix.needsUpdate = true;
      crownMesh.instanceMatrix.needsUpdate = true;
      if (crownMesh.instanceColor) crownMesh.instanceColor.needsUpdate = true;
      this.group.add(trunkMesh, crownMesh);
    }

    if (rocks.length) {
      const rockMesh = new THREE.InstancedMesh(
        new THREE.IcosahedronGeometry(1, 0),
        new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true }),
        rocks.length,
      );
      const base = this.surface.rockKind.color;
      for (let i = 0; i < rocks.length; i++) {
        rockMesh.setMatrixAt(i, rocks[i]);
        rockMesh.setColorAt(i, _c.copy(base).multiplyScalar(rockTints[i]));
      }
      rockMesh.castShadow = true;
      rockMesh.receiveShadow = true;
      rockMesh.instanceMatrix.needsUpdate = true;
      if (rockMesh.instanceColor) rockMesh.instanceColor.needsUpdate = true;
      this.group.add(rockMesh);
    }
  }

  /** 山頂の目印 */
  addSummitMarker(): THREE.Object3D {
    const g = new THREE.Group();
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.16, 3.2, 6),
      new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 0.8 }),
    );
    pole.position.y = 1.6;
    const plate = new THREE.Mesh(
      new THREE.BoxGeometry(1.5, 0.5, 0.08),
      new THREE.MeshStandardMaterial({ color: 0xd8c48a, emissive: 0x2a2415, roughness: 0.7 }),
    );
    plate.position.y = 2.9;
    g.add(pole, plate);
    g.position.set(this.field.summit.x, this.field.summit.y, this.field.summit.z);
    this.group.add(g);
    return g;
  }

  dispose(): void {
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    });
    this.group.clear();
  }
}
