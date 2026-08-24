/* ===========================================================
   3D登山ゲーム 本体。
   Seed から生成された山を登り、山頂を目指す。
   =========================================================== */

import * as THREE from 'three';
import './style.css';
import { CameraRig } from './core/CameraRig';
import { Input } from './core/Input';
import { clamp01 } from './core/math';
import { CLIMB, STAMINA, type PlayerAction } from './core/types';
import { difficultyProfile } from './mountain/difficulty';
import { Mountain, newRecord, type MountainRecord } from './mountain/Mountain';
import { MountainRegistry } from './mountain/MountainRegistry';
import { checkReachability } from './mountain/reachability';
import type { ClimbWall } from './mountain/cliff/ClimbWall';
import type { Hold } from './mountain/cliff/Hold';
import { NetClient } from './net/NetClient';
import { RemotePlayers } from './net/RemotePlayers';
import { ClimbingController } from './player/ClimbingController';
import { PlayerController } from './player/PlayerController';
import { RopeSystem } from './systems/RopeSystem';
import { StaminaSystem } from './systems/StaminaSystem';
import { HUD, type PartyMember } from './ui/HUD';
import { TitleScreen, type StartConfig } from './ui/TitleScreen';

type GameState = 'title' | 'loading' | 'playing' | 'summit';

const CENTER = new THREE.Vector2(0, 0);
const AIM = new THREE.Vector2(0, 0);
const _proj = new THREE.Vector3();

class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly rig: CameraRig;
  private readonly input: Input;
  private readonly hud = new HUD();
  private readonly registry = new MountainRegistry();
  private readonly title: TitleScreen;

  private readonly sun: THREE.DirectionalLight;
  private readonly raycaster = new THREE.Raycaster();

  private state: GameState = 'title';
  mountain: Mountain | null = null;
  private config: StartConfig | null = null;

  readonly stamina = new StaminaSystem(STAMINA.max);
  readonly ropes = new RopeSystem(0);
  readonly player = new PlayerController();
  readonly climb: ClimbingController;

  readonly net = new NetClient();
  readonly remotes = new RemotePlayers();
  private trailSyncTimer = 0;

  private hovered: Hold | null = null;
  private wallScanTimer = 0;
  /** 正面にある岩壁 (ヒント表示と取り付き判定で共用) */
  private nearWall: ClimbWall | null = null;
  private elapsed = 0;
  private prevTime = performance.now();

  /** 記録用 */
  private stats = { falls: 0, climbMoves: 0, ropesFixed: 0, maxAltitude: 0 };

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.rig = new CameraRig(this.aspect());
    this.input = new Input(canvas);
    this.title = new TitleScreen(this.registry);
    this.climb = new ClimbingController(this.player, this.stamina, this.ropes);

    this.sun = this.buildEnvironment();
    this.scene.add(this.player.object);
    this.scene.add(this.climb.helpers);
    this.scene.add(this.ropes.group);
    this.scene.add(this.remotes.group);

    this.wireEvents();
    this.hud.setVisible(false);
    this.hud.setReticle(this.input.mode === 'pointerlock');
    this.onResize();
    window.addEventListener('resize', this.onResize);
    requestAnimationFrame(this.loop);
  }

  private aspect(): number {
    const c = this.renderer?.domElement;
    const w = Math.max(1, c?.clientWidth || window.innerWidth);
    const h = Math.max(1, c?.clientHeight || window.innerHeight);
    return w / h;
  }

  // --- セットアップ -------------------------------------------------------

  private buildEnvironment(): THREE.DirectionalLight {
    this.scene.fog = new THREE.Fog(0xa8c4dc, 420, 1700);

    // 空 (大きな内向き球のグラデーション)
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(1600, 24, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: {
          top: { value: new THREE.Color(0x3f7fc4) },
          bottom: { value: new THREE.Color(0xc8d9e6) },
        },
        vertexShader: 'varying float vY;\nvoid main(){ vY = normalize(position).y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader:
          'uniform vec3 top; uniform vec3 bottom; varying float vY;\nvoid main(){ gl_FragColor = vec4(mix(bottom, top, smoothstep(-0.06, 0.55, vY)), 1.0); }',
      }),
    );
    sky.frustumCulled = false;
    this.scene.add(sky);

    this.scene.add(new THREE.HemisphereLight(0xbcd8ff, 0x584f3c, 0.85));

    const sun = new THREE.DirectionalLight(0xfff4e2, 2.6);
    sun.position.set(120, 200, 160);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const c = sun.shadow.camera;
    c.left = -70;
    c.right = 70;
    c.top = 70;
    c.bottom = -70;
    c.near = 1;
    c.far = 700;
    sun.shadow.bias = -0.0012;
    this.scene.add(sun);
    this.scene.add(sun.target);
    return sun;
  }

  private wireEvents(): void {
    this.title.onStart = (cfg) => void this.begin(cfg);

    this.climb.onNotice = (m) => this.hud.toast(m);

    this.climb.onEnterPlanning = (wall, from) => {
      // 岩壁全体を下から見上げてルートを決める
      this.input.setLookMode('cursor');
      this.hud.setReticle(false);
      this.rig.setPlanView(wall.frame.base, wall.frame.outward, wall.frame.height);
      this.hud.toast(from ? '岩棚から次のルートを組み立てる' : '岩壁を見上げてルートを組み立てる', true);
    };
    this.climb.onCommit = (summary) => {
      this.rig.clearPlanView();
      this.stats.climbMoves += summary.steps;
      this.hud.setPlan(null);
      this.hud.toast(`${summary.steps}手のルートを登る`, true);
    };
    this.climb.onRopeFixed = (wall) => {
      this.stats.ropesFixed += 1;
      const rope = this.ropes.fixed.get(wall.id);
      if (rope) this.net.sendRope(rope);
    };
    this.climb.onExit = (reason) => {
      this.rig.clearPlanView();
      this.hud.setPlan(null);
      this.input.setLookMode('pointerlock');
      // 壁から離れたら視点操作を元に戻す (拒否されたら次のクリックで掛け直す)
      this.input.requestLock(true);
      this.hud.setReticle(this.input.mode === 'pointerlock');
      if (reason === 'stamina') {
        this.stats.falls += 1;
        this.hud.toast('スタミナが尽きて落ちた');
      } else if (reason === 'letgo') {
        this.stats.falls += 1;
        this.hud.toast('手を放した');
      } else if (reason === 'stranded') {
        this.stats.falls += 1;
        this.hud.toast('ルートが尽きた。掴まる場所が無い');
      }
    };

    this.hud.nameBtn.addEventListener('click', () => void this.submitName());
    this.hud.nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void this.submitName();
    });
    this.hud.backBtn.addEventListener('click', () => this.returnToTitle());

    this.wireNet();

    this.input.onModeChange = (mode) => this.hud.setReticle(mode === 'pointerlock');
  }

  /** マルチプレイ。静的な山は同期せず、動的な状態だけを同期する */
  private wireNet(): void {
    this.net.onNotice = (text) => this.hud.toast(text, true);
    this.net.onWelcome = ({ players, ropes, trail, record }) => {
      for (const p of players) this.remotes.upsert(p);
      this.mountain?.snow.applyRemote(trail);
      this.ropes.applyRemote(ropes, (id) => this.mountain?.walls.get(id));
      if (record && this.mountain) Object.assign(this.mountain.record, record);
      this.hud.toast(`パーティーに参加した (${players.length + 1}人)`, true);
    };
    this.net.onJoin = (p) => {
      this.remotes.upsert(p);
      this.hud.toast(`${p.name} が合流した`, true);
    };
    this.net.onLeave = (id) => this.remotes.remove(id);
    this.net.onState = (p) => this.remotes.upsert(p);
    this.net.onTrail = (cells) => this.mountain?.snow.applyRemote(cells);
    this.net.onRope = (rope) => this.ropes.applyRemote([rope], (id) => this.mountain?.walls.get(id));
    this.net.onRecord = (record) => {
      if (this.mountain) Object.assign(this.mountain.record, record);
    };
    this.net.onClose = () => this.remotes.clear();
  }

  private onResize = (): void => {
    const canvas = this.renderer.domElement;
    const w = Math.max(1, canvas.clientWidth || window.innerWidth);
    const h = Math.max(1, canvas.clientHeight || window.innerHeight);
    this.renderer.setSize(w, h, false);
    this.rig.resize(w / h);
  };

  // --- 登山の開始 ---------------------------------------------------------

  async begin(cfg: StartConfig): Promise<void> {
    this.state = 'loading';
    this.config = cfg;
    this.title.hide();
    this.hud.setVisible(false);
    this.hud.showLoading('山を生成中', 0.02);

    if (this.mountain) {
      this.scene.remove(this.mountain.group);
      this.mountain.dispose();
      this.mountain = null;
    }

    const record: MountainRecord = await this.registry
      .get(cfg.seed, cfg.difficulty)
      .catch(() => newRecord(cfg.seed, cfg.difficulty));

    const mountain = await Mountain.create(record, (label, ratio) => this.hud.showLoading(label, ratio));
    this.mountain = mountain;
    this.scene.add(mountain.group);
    // カメラが樹木や転石にめり込まないようにする。
    // 地形はハイトフィールドで別に処理するので、レイキャスト対象には入れない
    // (16万ポリゴンのメッシュへ毎フレーム飛ばすと重い)
    const colliders: THREE.Object3D[] = [];
    mountain.group.traverse((o) => {
      if ((o as THREE.InstancedMesh).isInstancedMesh) colliders.push(o);
    });
    this.rig.setColliders(colliders);

    // 登山口から山頂まで到達できるかを確認する (開発時の保証)
    if (import.meta.env.DEV) {
      const r = checkReachability(mountain);
      console.log(
        `[Reachability] ${mountain.record.id} 山頂到達=${r.reachable ? 'OK' : 'NG'} / 要登攀 ${r.climbs} 箇所 / ` +
          `歩きだけ=${r.walkOnlyReachable ? '登頂できてしまう' : `${Math.round(r.walkOnlyHighest)}m 止まり`} ` +
          `(山頂 ${Math.round(r.summit)}m) / 歩ける面積 ${Math.round(r.walkableRatio * 100)}%`,
      );
      if (!r.reachable) console.warn('[Reachability] 山頂へ到達できるルートが見つからない');
      if (r.walkOnlyReachable && mountain.profile.level >= 3) {
        console.warn('[Reachability] 歩行だけで登頂できてしまう。難易度が成立していない');
      }
    }

    const profile = difficultyProfile(cfg.difficulty);
    this.stamina.reset();
    this.stamina.fatigueScale = profile.fatigueScale;
    this.ropes.reset(profile.ropes);
    this.stats = { falls: 0, climbMoves: 0, ropesFixed: 0, maxAltitude: 0 };
    this.elapsed = 0;

    const t = mountain.field.trailhead;
    this.player.reset(t.x, t.y, t.z);
    // 山頂の方を向いて開始する
    const s = mountain.field.summit;
    this.rig.yaw = Math.atan2(-(s.x - t.x), -(s.z - t.z));
    this.rig.pitch = -0.02;
    this.rig.snap(this.player.position, mountain.field);

    this.remotes.clear();
    this.net.close();
    if (cfg.room) {
      this.net.connect({
        mountainId: mountain.record.id,
        room: cfg.room,
        name: cfg.playerName,
        x: t.x,
        y: t.y,
        z: t.z,
      });
    }

    this.hud.hideLoading();
    this.hud.setVisible(true);
    this.state = 'playing';
    this.input.requestLock(true);
    this.hud.toast(`${mountain.displayName} / 標高 ${Math.round(mountain.summitHeight)}m`, true);
  }

  private returnToTitle(): void {
    this.net.close();
    this.remotes.clear();
    this.hud.hideSummit();
    this.hud.setVisible(false);
    this.input.releaseLock();
    this.state = 'title';
    this.title.show();
  }

  // --- ループ -------------------------------------------------------------

  private loop = (now: number): void => {
    const dt = Math.min(0.05, Math.max(0, (now - this.prevTime) / 1000));
    this.prevTime = now;

    if (this.state === 'playing') this.step(dt);
    else if (this.state === 'summit' && this.mountain) this.mountain.update(dt);

    this.input.endFrame();
    this.syncSize();
    this.renderer.render(this.scene, this.rig.camera);
    requestAnimationFrame(this.loop);
  };

  private step(dt: number): void {
    const mountain = this.mountain;
    if (!mountain) return;
    this.elapsed += dt;

    this.rig.update(dt, this.player.position, this.climb.isClimbing, this.input, mountain.field);

    const forward = this.rig.forward();
    this.player.update(dt, this.input, this.rig.yaw, {
      field: mountain.field,
      snow: mountain.snow,
      stamina: this.stamina,
    });

    this.updateWalls(dt, forward);
    this.updateAim();
    this.handleActions();
    this.climb.update(dt, this.hovered);

    // 環境と疲労
    this.stamina.setAltitude(this.player.position.y);
    this.stamina.tickFatigue(dt);
    this.stats.maxAltitude = Math.max(this.stats.maxAltitude, this.player.position.y);

    mountain.update(dt);
    this.remotes.update(dt);
    this.syncNet(dt);
    this.updateSun();
    this.updateHud();
    this.checkSummit();
  }

  /** 位置と踏み跡をサーバへ送る */
  private syncNet(dt: number): void {
    if (!this.net.connected) return;
    const p = this.player.position;
    const action = this.climb.isClimbing ? this.climb.action : this.player.action;
    this.net.sendState(p.x, p.y, p.z, this.player.facing, action, this.stamina.stamina, this.stamina.maxStamina);

    this.trailSyncTimer -= dt;
    if (this.trailSyncTimer <= 0) {
      this.trailSyncTimer = 0.5;
      const delta = this.mountain?.snow.takeDelta() ?? [];
      if (delta.length) this.net.sendTrail(delta);
    }
  }

  /** 近くの岩壁を見つけて表示し、押し続けていれば取り付く */
  private updateWalls(dt: number, forward: THREE.Vector3): void {
    const mountain = this.mountain;
    if (!mountain) return;
    if (this.climb.isClimbing) {
      this.nearWall = null;
      return;
    }

    // 少し離れた壁も見つけて、ホールドを見えるようにしておく
    this.wallScanTimer -= dt;
    if (this.wallScanTimer <= 0) {
      this.wallScanTimer = 0.15;
      const far = this.probeFan(mountain, forward, 14);
      if (far) {
        const wall = mountain.walls.acquire(far);
        if (!wall.group.parent) mountain.group.add(wall.group);
      }
      mountain.walls.prune(this.player.position, 60, null);
    }

    // 取り付ける距離にある壁
    const near = this.probeFan(mountain, forward, 4.2);
    if (near) {
      const wall = mountain.walls.acquire(near);
      if (!wall.group.parent) mountain.group.add(wall.group);
      this.nearWall = wall;
    } else {
      this.nearWall = null;
    }

    // 壁に正面から押し当て続けると登攀へ移行する (専用キーなし)
    if (this.nearWall && this.player.grounded && this.player.blockedTime > 0.25) {
      if (this.climb.startPlanning(this.nearWall, null, this.player.position)) this.player.blockedTime = 0;
    }
  }

  /** 正面と左右すこしずつを探す。まっすぐ壁に当てなくても取り付けるように */
  private probeFan(mountain: Mountain, forward: THREE.Vector3, range: number) {
    for (const a of [0, 0.3, -0.3]) {
      const c = Math.cos(a);
      const s = Math.sin(a);
      const fx = forward.x * c - forward.z * s;
      const fz = forward.x * s + forward.z * c;
      const frame = mountain.walls.probe(this.player.position, fx, fz, range);
      if (frame) return frame;
    }
    return null;
  }

  /** 照準の先にあるホールド */
  private updateAim(): void {
    const mountain = this.mountain;
    if (!mountain) {
      this.hovered = null;
      return;
    }

    // 見上げ視点ではホールドが小さく重なるので、レイキャストではなく
    // 「カーソルにいちばん近いホールド」を拾う。狙いやすさを優先する
    if (this.climb.isPlanning && this.climb.wall) {
      this.hovered = this.pickNearestHold(this.climb.wall.holds);
      this.describeAim();
      return;
    }

    const targets: THREE.Object3D[] = [];
    if (this.climb.wall) targets.push(...this.climb.wall.pickTargets);
    else for (const w of mountain.walls.active) targets.push(...w.pickTargets);
    if (targets.length === 0) {
      this.hovered = null;
      this.hud.setAim(null);
      return;
    }

    if (this.input.mode === 'pointerlock') AIM.copy(CENTER);
    else AIM.set(this.input.cursor.x, this.input.cursor.y);
    this.raycaster.setFromCamera(AIM, this.rig.camera);
    // 見上げ視点では壁全体が入るまでカメラを引くので、その分まで届かせる
    this.raycaster.far = this.climb.isClimbing ? 200 : 40;
    const hits = this.raycaster.intersectObjects(targets, false);
    const id = hits.length ? (hits[0].object.userData.holdId as string) : null;
    let hold: Hold | null = null;
    if (id) {
      for (const w of mountain.walls.active) {
        const h = w.getHold(id);
        if (h) {
          hold = h;
          break;
        }
      }
    }
    this.hovered = hold;
    this.describeAim();
  }

  /** カーソルにいちばん近いホールドを拾う (画面上の距離で判定) */
  private pickNearestHold(holds: Hold[]): Hold | null {
    const canvas = this.renderer.domElement;
    const w = Math.max(1, canvas.clientWidth || window.innerWidth);
    const h = Math.max(1, canvas.clientHeight || window.innerHeight);
    const cx = this.input.mode === 'pointerlock' ? 0 : this.input.cursor.x;
    const cy = this.input.mode === 'pointerlock' ? 0 : this.input.cursor.y;
    let best: Hold | null = null;
    let bestScore = Infinity;
    for (const hold of holds) {
      _proj.copy(hold.position).project(this.rig.camera);
      if (_proj.z > 1) continue;
      const dx = ((_proj.x - cx) * w) / 2;
      const dy = ((_proj.y - cy) * h) / 2;
      const dist = Math.hypot(dx, dy);
      if (dist > 34) continue;
      // 繋げられる手を優先して拾う
      const score = dist + (this.climb.canAppend(hold) ? 0 : 14);
      if (score < bestScore) {
        bestScore = score;
        best = hold;
      }
    }
    return best;
  }

  /** 照準に入っているホールドの説明 */
  private describeAim(): void {
    const hold = this.hovered;
    if (!hold) {
      this.hud.setAim(null);
      return;
    }
    if (!this.climb.isClimbing) {
      const d = hold.position.distanceTo(this.player.position);
      const near = hold.ground && d < CLIMB.grabRange + 1.4;
      this.hud.setAim({ text: near ? 'ここから取り付ける' : `${hold.type} ホールド`, state: near ? 'ok' : 'warn' });
      return;
    }
    if (!this.climb.isPlanning) {
      this.hud.setAim(null);
      return;
    }
    if (!this.climb.canAppend(hold)) {
      this.hud.setAim({
        text: this.climb.plan.some((s) => s.hold === hold) ? 'ルートに入っている' : '手が届かない',
        state: 'ng',
      });
      return;
    }
    const cost = this.climb.costTo(hold);
    const after = this.climb.projectedStaminaAt(hold);
    if (after <= 0) this.hud.setAim({ text: `消費 ${cost.toFixed(0)} — ここで力尽きる`, state: 'ng' });
    else this.hud.setAim({ text: `消費 ${cost.toFixed(0)} → 残り ${Math.round(after)}`, state: 'ok' });
  }

  private handleActions(): void {
    if (!this.climb.isClimbing) return;

    if (this.climb.isPlanning) {
      if (this.input.clicked && this.hovered) this.climb.append(this.hovered);
      if (this.input.rightClicked) this.climb.undo();
      if (this.input.wasPressed('ShiftLeft') || this.input.wasPressed('ShiftRight')) this.climb.toggleRope();
      if (this.input.wasPressed('Space')) this.climb.commit();
      if (this.input.wasPressed('KeyS')) this.climb.cancel();
      return;
    }
    // 実行中は手を放すことだけできる
    if (this.input.wasPressed('KeyS')) this.climb.letGo();
  }

  private updateSun(): void {
    const p = this.player.position;
    this.sun.position.set(p.x + 90, p.y + 150, p.z + 120);
    this.sun.target.position.copy(p);
    this.sun.target.updateMatrixWorld();
  }

  private checkSummit(): void {
    const mountain = this.mountain;
    if (!mountain || this.state !== 'playing') return;
    if (!mountain.atSummit(this.player.position)) return;
    void this.finishSummit();
  }

  private async finishSummit(): Promise<void> {
    const mountain = this.mountain;
    const cfg = this.config;
    if (!mountain || !cfg) return;
    this.state = 'summit';
    this.input.releaseLock();

    const first = mountain.isUnclimbed;
    const stats =
      `所要 <b>${formatTime(this.elapsed)}</b> ／ 標高 <b>${Math.round(mountain.summitHeight)}m</b><br>` +
      `最大スタミナ <b>${Math.round(this.stamina.maxStamina)}</b> / ${this.stamina.initialMax}` +
      ` ／ 登攀 <b>${this.stats.climbMoves}</b> 手<br>` +
      `落下 ${this.stats.falls} 回 ／ ロープ ${this.stats.ropesFixed} 本 ／ 踏み跡 ${Math.round(
        mountain.snow.trailCoverage * 100,
      )}%`;

    if (first) {
      this.hud.showSummit({ first: true, title: `${cfg.playerName} が初登頂した`, stats });
      this.hud.nameInput.value = '';
    } else {
      const updated = await this.registry.recordAscent(mountain.record, cfg.playerName);
      Object.assign(mountain.record, updated);
      this.net.sendRecord(updated);
      this.hud.showSummit({
        first: false,
        title: mountain.displayName,
        stats,
        namedText: `初登頂 ${updated.firstAscentBy ?? '-'} ／ 登頂者 ${updated.ascents} 人目`,
      });
    }
  }

  private async submitName(): Promise<void> {
    const mountain = this.mountain;
    const cfg = this.config;
    if (!mountain || !cfg) return;
    const name = this.hud.nameInput.value.trim().slice(0, 20);
    if (!name) {
      this.hud.toast('山名を入力してください');
      return;
    }
    const party = [cfg.playerName, ...this.remotes.roster().map((r) => r.name)];
    const updated = await this.registry.claim(mountain.record, name, cfg.playerName, party);
    Object.assign(mountain.record, updated);
    this.net.sendRecord(updated);
    this.hud.markNamed(`「${updated.name}」と命名した`);
    void this.title.refreshRecords();
  }

  // --- HUD ----------------------------------------------------------------

  private updateHud(): void {
    const mountain = this.mountain;
    if (!mountain) return;
    const snow = mountain.snow.evaluate(this.player.position.x, this.player.position.z);
    const action: PlayerAction = this.climb.isClimbing ? this.climb.action : this.player.action;

    const party: PartyMember[] = [
      {
        name: this.config?.playerName ?? '登山者',
        altitude: this.player.position.y,
        stamina: this.stamina.stamina,
        maxStamina: this.stamina.maxStamina,
        self: true,
      },
      ...this.remotes.roster(),
    ];

    this.hud.update({
      action,
      stamina: this.stamina.stamina,
      maxStamina: this.stamina.maxStamina,
      initialMax: this.stamina.initialMax,
      recovering: action === 'REST',
      altitude: this.player.position.y,
      temperature: this.stamina.env.temperature,
      ropes: this.ropes.carried,
      snowLabel: snow.depth > 0.05 ? `積雪 ${(snow.depth * 100).toFixed(0)}cm` : '',
      mountainName: mountain.displayName,
      mountainId: mountain.record.id,
      difficultyLabel: `${mountain.profile.level}級 ${mountain.profile.label}`,
      summitHeight: mountain.summitHeight,
      progress: clamp01(this.player.position.y / Math.max(1, mountain.summitHeight)),
      rockLabel: mountain.surface.describe(),
      party,
    });

    if (this.climb.isPlanning) {
      const sum = this.climb.summary();
      this.hud.setPlan({
        steps: sum.steps,
        totalCost: sum.totalCost,
        endStamina: sum.endStamina,
        failsAt: sum.failsAt,
        ending: sum.ending,
        useRope: sum.useRope,
        ropesLeft: this.ropes.carried,
      });
    } else {
      this.hud.setPlan(null);
    }

    this.hud.setHint(this.currentHint(snow.russelling));
  }

  private currentHint(russelling: boolean): string | null {
    if (this.input.needsClickToLock) return 'クリックで視点を操作する';
    if (this.climb.isPlanning) {
      // 操作はルートパネルに出しているので、ここでは状況だけ
      return this.climb.plan.length === 0
        ? '岩壁を見上げている — 繋げるホールドをクリック'
        : `${this.climb.plan.length}手ぶん組み立てた — <kbd>Space</kbd> で登る`;
    }
    if (this.climb.isClimbing) return '登攀中 — <kbd>S</kbd> で手を放す';
    if (this.player.isMantling) return null;
    if (this.mountain && this.player.grounded) {
      const target = this.player.mantleTarget(this.mountain.field, this.rig.yaw);
      if (target) return '<kbd>Space</kbd> で乗り越える';
    }
    if (this.nearWall) {
      return this.player.blockedTime > 0.05
        ? '<kbd>W</kbd> を押し続けて岩壁に取り付く'
        : '目の前に岩壁がある';
    }
    if (this.player.blockedTime > 0.25) return 'ここは登れない — 回り込めるところを探す';
    if (russelling) return '深雪をラッセル中 — 踏み跡は後続の助けになる';
    if (this.stamina.maxStamina < this.stamina.initialMax * 0.4) return '最大スタミナが落ちている — 消耗が激しい';
    return null;
  }

  private syncSize(): void {
    const canvas = this.renderer.domElement;
    const w = Math.max(1, canvas.clientWidth || window.innerWidth);
    const h = Math.max(1, canvas.clientHeight || window.innerHeight);
    const ratio = this.renderer.getPixelRatio();
    if (canvas.width !== Math.floor(w * ratio) || canvas.height !== Math.floor(h * ratio)) {
      this.renderer.setSize(w, h, false);
      this.rig.resize(w / h);
    }
  }
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}分${String(s).padStart(2, '0')}秒`;
}

const game = new Game(document.getElementById('app') as HTMLCanvasElement);
(window as unknown as { game: Game }).game = game;

export type { Game };
