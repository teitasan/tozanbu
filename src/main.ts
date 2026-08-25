/* ===========================================================
   3D登山ゲーム 本体。
   Seed から生成された山を登り、山頂を目指す。
   =========================================================== */

import * as THREE from 'three';
import './style.css';
import { CameraRig } from './core/CameraRig';
import { Input } from './core/Input';
import { clamp01 } from './core/math';
import { hashString } from './core/rng';
import { STAMINA, type PlayerAction } from './core/types';
import { difficultyProfile } from './mountain/difficulty';
import { Mountain, newRecord, type MountainRecord } from './mountain/Mountain';
import { MountainRegistry } from './mountain/MountainRegistry';
import { TopoMap } from './mountain/TopoMap';
import { checkReachability } from './mountain/reachability';
import type { ClimbWall } from './mountain/cliff/ClimbWall';
import { NetClient } from './net/NetClient';
import { RemotePlayers } from './net/RemotePlayers';
import { ClimbingController } from './player/ClimbingController';
import { PlayerController } from './player/PlayerController';
import { RopeSystem } from './systems/RopeSystem';
import { StaminaSystem } from './systems/StaminaSystem';
import { Briefing } from './ui/Briefing';
import { HUD, type PartyMember } from './ui/HUD';
import { TitleScreen, type StartConfig } from './ui/TitleScreen';

type GameState = 'title' | 'briefing' | 'playing' | 'summit';


class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly rig: CameraRig;
  private readonly input: Input;
  private readonly hud = new HUD();
  private readonly briefing = new Briefing();
  private readonly registry = new MountainRegistry();
  private readonly title: TitleScreen;

  private readonly sun: THREE.DirectionalLight;

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

  private wallScanTimer = 0;
  /** 画面の右が壁のどちら向きか (+1 / -1)。横向きでばたつかないよう保持する */
  private tangentSign = 1;
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
    this.syncReticle();
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

    this.climb.onEnter = () => {
      // 登攀中はレティクルを消す。自分を画面中央に置くので重なるうえ、
      // 狙う先は方向キーで決めるので使わない
      this.syncReticle();
      this.hud.toast('岩壁に取り付いた — WASD で方向、Space で登る', true);
    };
    this.climb.onRopeFixed = (wall) => {
      this.stats.ropesFixed += 1;
      const rope = this.ropes.fixed.get(wall.id);
      if (rope) this.net.sendRope(rope);
    };
    this.climb.onExit = (reason) => {
      this.hud.setClimb(null);
      this.syncReticle();
      this.stats.climbMoves += this.climb.moveCount;
      if (reason === 'stamina') {
        this.stats.falls += 1;
        this.hud.toast('スタミナが尽きて落ちた');
      } else if (reason === 'letgo') {
        this.stats.falls += 1;
        this.hud.toast('手を放した');
      }
    };

    this.hud.nameBtn.addEventListener('click', () => void this.submitName());
    this.hud.nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void this.submitName();
    });
    this.hud.backBtn.addEventListener('click', () => this.returnToTitle());

    // ブリーフィングの書き込みはパーティー全員で共有する
    this.briefing.onMark = (mark) => this.net.sendMark(mark);
    this.briefing.onClear = () => this.net.sendUnmark();

    this.wireNet();

    this.input.onModeChange = () => this.syncReticle();
  }

  /** マルチプレイ。静的な山は同期せず、動的な状態だけを同期する */
  private wireNet(): void {
    this.net.onNotice = (text) => this.hud.toast(text, true);
    this.net.onWelcome = ({ players, ropes, marks, trail, record }) => {
      for (const p of players) this.remotes.upsert(p);
      this.mountain?.snow.applyRemote(trail);
      this.ropes.applyRemote(ropes, (id) => this.mountain?.walls.get(id));
      this.briefing.applyMarks(marks);
      this.syncParty();
      if (record && this.mountain) Object.assign(this.mountain.record, record);
      this.hud.toast(`パーティーに参加した (${players.length + 1}人)`, true);
    };
    this.net.onJoin = (p) => {
      this.remotes.upsert(p);
      this.syncParty();
      this.hud.toast(`${p.name} が合流した`, true);
    };
    this.net.onLeave = (id) => {
      this.remotes.remove(id);
      this.syncParty();
    };
    this.net.onMark = (mark) => this.briefing.applyMark(mark);
    this.net.onUnmark = (by) => this.briefing.clearBy(by);
    this.net.onState = (p) => this.remotes.upsert(p);
    this.net.onTrail = (cells) => this.mountain?.snow.applyRemote(cells);
    this.net.onRope = (rope) => this.ropes.applyRemote([rope], (id) => this.mountain?.walls.get(id));
    this.net.onRecord = (record) => {
      if (this.mountain) Object.assign(this.mountain.record, record);
    };
    this.net.onClose = () => this.remotes.clear();
  }

  /** ブリーフィングに出すパーティーの顔ぶれ */
  private syncParty(): void {
    const names = [this.config?.playerName ?? 'you', ...this.remotes.roster().map((p) => p.name)];
    this.briefing.setParty(names);
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
    this.state = 'briefing';
    this.config = cfg;
    this.title.hide();
    this.hud.setVisible(false);
    // ローディング画面の代わりに地形図を出す。
    // 生成が早く終わってもブリーフィングは 30 秒続く
    this.briefing.open('山を生成中', cfg.playerName, hashString(cfg.playerName) % 6);

    if (this.mountain) {
      this.scene.remove(this.mountain.group);
      this.mountain.dispose();
      this.mountain = null;
    }

    const record: MountainRecord = await this.registry
      .get(cfg.seed, cfg.difficulty)
      .catch(() => newRecord(cfg.seed, cfg.difficulty));

    const profile0 = difficultyProfile(record.difficulty);
    this.briefing.setTitle(
      `${record.name ?? `未踏峰 ${record.id}`} / ${profile0.level}級 ${profile0.label}`,
    );
    const mountain = await Mountain.create(record, (label) => this.briefing.setStatus(label));
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

    // 地形図。3Dの山と同じ Heightfield から等高線を引く
    this.briefing.setMap(new TopoMap(mountain.field, mountain.profile));
    this.briefing.setParty([cfg.playerName]);

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

    // ここまでが「ローディング」。残りのブリーフィング時間は地図を読む時間
    await this.briefing.wait();
    this.briefing.close();
    if (this.state !== 'briefing') return; // 待っている間にタイトルへ戻された

    this.hud.setVisible(true);
    this.state = 'playing';
    this.prevTime = performance.now();
    this.syncReticle();
    this.input.requestLock(true);
    this.hud.toast(`${mountain.displayName} / 標高 ${Math.round(mountain.summitHeight)}m`, true);
  }

  private returnToTitle(): void {
    this.briefing.close();
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
    this.handleActions(dt);
    this.climb.update(dt);

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
      const wall = this.nearWall;
      if (this.climb.start(wall, null, this.player.position)) {
        this.player.blockedTime = 0;
        this.rig.faceWall(wall.frame.outward);
      }
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

  /** レティクルは通常移動のときだけ出す */
  private syncReticle(): void {
    this.hud.setReticle(this.input.mode === 'pointerlock' && !this.climb.isClimbing);
  }

  /**
   * 画面の右が壁のどちら向きか。方向キーを見た目どおりに効かせる。
   *
   * 壁を横から見る向き (内積が 0 付近) では符号が毎フレーム反転しうるので、
   * はっきり向きを変えたときだけ切り替える。
   */
  private wallTangentSign(): number {
    const wall = this.climb.wall;
    if (!wall) return 1;
    const rx = Math.cos(this.rig.yaw);
    const rz = -Math.sin(this.rig.yaw);
    const dot = rx * wall.frame.tangent.x + rz * wall.frame.tangent.z;
    if (Math.abs(dot) > 0.35) this.tangentSign = dot >= 0 ? 1 : -1;
    return this.tangentSign;
  }

  private handleActions(dt: number): void {
    if (!this.climb.isClimbing) return;

    // WASD で壁を基準にした方向を選ぶ (斜めも可)
    let dx = 0;
    let dy = 0;
    if (this.input.isDown('KeyW')) dy += 1;
    if (this.input.isDown('KeyS')) dy -= 1;
    if (this.input.isDown('KeyA')) dx -= 1;
    if (this.input.isDown('KeyD')) dx += 1;
    this.climb.setAim(dx, dy, this.wallTangentSign());

    if (this.input.wasPressed('Space')) this.climb.step();
    if (this.input.rightClicked) this.climb.fixRope(this.config?.playerName ?? 'you');
    // S 長押しで手を放す (下端では降りるだけ)
    this.climb.holdLetGo(dt, this.input.isDown('KeyS'));
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

    if (this.climb.isClimbing) {
      const m = this.climb.nextMove();
      this.hud.setClimb({
        arrow: m.arrow,
        grade: m.grade,
        cost: m.cost,
        staminaAfter: m.staminaAfter,
        rest: m.rest,
        ok: m.ok,
        reason: m.reason,
        topOut: m.topOut,
        stepDown: m.stepDown,
        moves: this.climb.moveCount,
        ropesLeft: this.ropes.carried,
        roped: this.climb.wall ? this.ropes.hasRope(this.climb.wall.id) : false,
        letGo: this.climb.letGoRatio,
      });
    } else {
      this.hud.setClimb(null);
    }

    this.hud.setHint(this.currentHint(snow.russelling));
  }

  private currentHint(russelling: boolean): string | null {
    if (this.input.needsClickToLock) return 'クリックで視点を操作する';
    if (this.climb.isClimbing) return null; // 操作は登攀パネルに出している
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
