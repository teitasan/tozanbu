/* ===========================================================
   ゲーム全体で共有する型と調整値。
   バランス調整はまずここを見る。
   =========================================================== */

/** 採用する基本アクション7種 (+ 表示用の補助状態) */
export type PlayerAction =
  | 'WALK'
  | 'DASH'
  | 'JUMP'
  | 'MANTLE'
  | 'CLIMB'
  | 'TRAVERSE'
  | 'FALL'
  | 'RUSSELL'
  | 'REST';

export const ACTION_LABEL: Record<PlayerAction, string> = {
  WALK: '歩行',
  DASH: 'ダッシュ',
  JUMP: 'ジャンプ',
  MANTLE: 'マントリング',
  CLIMB: '登攀',
  TRAVERSE: 'トラバース',
  FALL: '落下',
  RUSSELL: 'ラッセル',
  REST: '休憩',
};




/** 登攀 */
export const CLIMB = {
  /** staminaCost = baseCost + distance * distanceCost */
  distanceCost: 1.0,
  moveBaseDuration: 0.16,
  moveDurationPerUnit: 0.085,
  /** 岩棚での毎秒回復 */
  ledgeRecoveryPerSec: 14,
  /** ロープが張られた区間のコスト倍率 */
  ropeCostScale: 0.32,
  /** 地上から取り付ける距離 */
  grabRange: 3.4,
  /** 横移動とみなす角度 (これより水平ならトラバース表示) */
  traverseSlope: 0.55,
} as const;

/** 通常移動 */
export const MOVE = {
  walkSpeed: 3.3,
  dashSpeed: 6.6,
  jumpSpeed: 6.2,
  gravity: 22,
  /** これ以下の段差は歩いて越える */
  stepUp: 0.55,
  /** マントリングできる段差 */
  mantleMin: 0.75,
  mantleMax: 2.7,
  mantleDuration: 0.8,
  /** 歩いて登れる最大斜度 (rad)。約38度。これより急だと登れない (横切る・下るのは可) */
  maxWalkSlope: 0.66,
  /** 立っていられる最大斜度 (rad)。約54度。これより急な面は岩壁扱いで、掴まらないと落ちる */
  maxStandSlope: 0.95,
  eyeHeight: 1.62,
  radius: 0.42,
  height: 1.75,
} as const;

/** スタミナ */
export const STAMINA = {
  max: 100,
  /** ダッシュの毎秒消費 */
  dashDrain: 8.5,
  jumpCost: 5,
  mantleCost: 11,
  /** 立ち止まっているときの毎秒回復 */
  restRecovery: 15,
  /** 歩行中の毎秒回復 */
  walkRecovery: 4.5,
  /** 最大スタミナの基礎減少 (毎秒) */
  fatigueBase: 0.055,
  /** 現在スタミナ0で登攀できず落下 */
} as const;

/** 環境 */
export const ENV = {
  /** この標高から高度の影響が出る (m) */
  altitudeStart: 150,
  /** 標高1000mあたりの気温低下 (℃) */
  lapseRate: 6.5,
  /** 麓の気温 (℃) */
  baseTemp: 14,
} as const;
