/* ===========================================================
   入力。操作キーは増やさない方針なので、
   WASD / Shift / Space / マウス (視点・左クリック・右クリック) だけを扱う。

   視点の方式は場面で切り替える。
     pointerlock : 通常移動。ポインタロックして視点を回す (画面中央のレティクル)
     cursor      : 登攀中。カーソルでホールドを直接指す。ドラッグで視点を回す

   軌道カメラは注視点の近くを画面中央に持ってこられないので、
   手の届く範囲のホールドはレティクルでは狙えない。だから登攀中はカーソルにする。
   ポインタロックが許可されない環境では通常移動も cursor になる。
   =========================================================== */

/** クリックとみなす移動量 (px) と時間 (ms) */
const CLICK_SLOP = 6;
const CLICK_MS = 500;

export type LookMode = 'pointerlock' | 'cursor';

export class Input {
  private readonly down = new Set<string>();
  private readonly pressed = new Set<string>();

  /** このフレームの視点移動量 */
  lookX = 0;
  lookY = 0;
  /** このフレームに左クリックされたか */
  clicked = false;
  /** このフレームに右クリックされたか */
  rightClicked = false;

  /** カーソル位置 (NDC)。cursor モードで有効 */
  readonly cursor = { x: 0, y: 0 };
  /** カーソルが画面内にあるか */
  cursorInside = false;
  /** このフレームのホイール量 (見上げ視点の寄り引き) */
  zoomDelta = 0;

  locked = false;
  /** ポインタロックが使えない環境か */
  lockUnavailable = false;
  /** 入力を無視する (メニュー表示中など) */
  blocked = false;

  onLockChange: ((locked: boolean) => void) | null = null;
  onModeChange: ((mode: LookMode) => void) | null = null;

  private desired: LookMode = 'pointerlock';
  private lastMode: LookMode | null = null;
  private dragButton = -1;
  private dragged = false;
  private downAt: { x: number; y: number; t: number } | null = null;
  private lastX = 0;
  private lastY = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    canvas.addEventListener('mousedown', this.onMouseDown);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.notifyMode();
    document.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mouseup', this.onMouseUp);
    document.addEventListener('pointerlockchange', this.onLockEvent);
  }

  /** 実際に使っている視点方式 */
  get mode(): LookMode {
    return this.locked ? 'pointerlock' : 'cursor';
  }

  /** 視点操作を受け付けている状態か */
  get active(): boolean {
    return this.locked || this.lockUnavailable || this.desired === 'cursor';
  }

  /** ポインタロックを使いたいのに、まだ掛かっていない状態か */
  get needsClickToLock(): boolean {
    return this.desired === 'pointerlock' && !this.locked && !this.lockUnavailable;
  }

  /** 場面に応じて視点方式を切り替える */
  setLookMode(mode: LookMode): void {
    if (this.desired === mode) return;
    this.desired = mode;
    if (mode === 'cursor' && this.locked) this.releaseLock();
    this.notifyMode();
  }

  private notifyMode(): void {
    const m = this.mode;
    if (m === this.lastMode) return;
    this.lastMode = m;
    this.canvas.style.cursor = m === 'pointerlock' ? 'none' : 'crosshair';
    this.onModeChange?.(m);
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return;
    if (e.code === 'Space' || e.code === 'Tab') e.preventDefault();
    if (this.blocked) return;
    this.down.add(e.code);
    this.pressed.add(e.code);
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.down.delete(e.code);
  };

  private onBlur = () => {
    this.down.clear();
    this.dragButton = -1;
  };

  private updateCursor(clientX: number, clientY: number): void {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    this.cursor.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.cursor.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.cursorInside =
      this.cursor.x >= -1 && this.cursor.x <= 1 && this.cursor.y >= -1 && this.cursor.y <= 1;
  }

  private onMouseDown = (e: MouseEvent) => {
    if (this.blocked) return;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.updateCursor(e.clientX, e.clientY);

    if (this.needsClickToLock) {
      this.requestLock();
      return; // ロックのためのクリックはゲーム入力にしない
    }
    if (this.locked) {
      if (e.button === 0) this.clicked = true;
      else if (e.button === 2) this.rightClicked = true;
      return;
    }
    // カーソルモード: 離した時にクリックかドラッグかを決める
    this.dragButton = e.button;
    this.dragged = false;
    this.downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
  };

  private onMouseUp = (e: MouseEvent) => {
    if (this.dragButton !== e.button) return;
    this.dragButton = -1;
    const start = this.downAt;
    this.downAt = null;
    if (this.blocked || !start || this.dragged) return;
    const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y);
    if (moved < CLICK_SLOP && performance.now() - start.t < CLICK_MS) {
      if (e.button === 0) this.clicked = true;
      else if (e.button === 2) this.rightClicked = true;
    }
  };

  private onMouseMove = (e: MouseEvent) => {
    if (this.blocked) return;
    if (this.locked) {
      this.lookX += e.movementX;
      this.lookY += e.movementY;
      return;
    }
    this.updateCursor(e.clientX, e.clientY);
    if (this.dragButton >= 0) {
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      if (Math.abs(dx) + Math.abs(dy) > 0) this.dragged = true;
      this.lookX += dx;
      this.lookY += dy;
    }
    this.lastX = e.clientX;
    this.lastY = e.clientY;
  };

  private onWheel = (e: WheelEvent) => {
    if (this.blocked) return;
    e.preventDefault();
    this.zoomDelta += Math.sign(e.deltaY);
  };

  private onLockEvent = () => {
    this.locked = document.pointerLockElement === this.canvas;
    if (this.locked) this.lockUnavailable = false;
    else this.down.clear();
    this.notifyMode();
    this.onLockChange?.(this.locked);
  };

  /**
   * ポインタロックを要求する。
   * silent = true はクリック以外の自動要求。失敗しても「使えない環境」とは判断しない
   * (ユーザー操作なしのロックはブラウザに拒否されることがあるだけなので)。
   */
  requestLock(silent = false): void {
    if (this.blocked || this.lockUnavailable || this.desired !== 'pointerlock') return;
    const onFail = () => {
      if (!silent) this.fallbackToDrag();
    };
    let result: unknown;
    try {
      result = this.canvas.requestPointerLock();
    } catch {
      onFail();
      return;
    }
    // 新しめのブラウザは Promise を返す。埋め込み等で拒否されることがある
    if (result && typeof (result as Promise<void>).catch === 'function') {
      void (result as Promise<void>).catch(onFail);
    }
  }

  /** ポインタロックが使えないので、ドラッグで視点を回す方式に切り替える */
  private fallbackToDrag(): void {
    if (this.lockUnavailable) return;
    this.lockUnavailable = true;
    console.info('[Input] ポインタロックが使えないため、ドラッグで視点を回します');
    this.notifyMode();
    this.onLockChange?.(false);
  }

  releaseLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  isDown(code: string): boolean {
    return !this.blocked && this.down.has(code);
  }

  wasPressed(code: string): boolean {
    return !this.blocked && this.pressed.has(code);
  }

  endFrame(): void {
    this.pressed.clear();
    this.clicked = false;
    this.rightClicked = false;
    this.lookX = 0;
    this.lookY = 0;
    this.zoomDelta = 0;
  }
}
