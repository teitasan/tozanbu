/* ===========================================================
   難易度。
   「敵が強くなる」のではなく「山そのものが難しくなる」ように、
   地形生成・登攀生成・環境負荷のパラメータをまとめて変える。
   =========================================================== */

export type DifficultyLevel = 1 | 2 | 3 | 4 | 5;

export interface DifficultyProfile {
  level: DifficultyLevel;
  label: string;
  summary: string;

  // --- 山体 ---
  /** 山頂の標高 (m) */
  peakHeight: number;
  /** 山体の半径 (m) */
  radius: number;
  /** 尾根の鋭さ */
  ridgeAmp: number;
  /** 谷の深さ */
  valleyAmp: number;

  // --- 崖バンド ---
  /** 崖の出やすさ 0..1 */
  cliffiness: number;
  /** 1バンドの高さ (= 1回の登攀の長さ) */
  bandHeight: number;
  /** 小さいほど壁が垂直に近くなる */
  cliffFracBase: number;
  cliffFracVar: number;

  // --- 積雪 ---
  /** 雪線 (山頂高さに対する比率) */
  snowLine: number;
  /** 最深積雪 (m) */
  snowMax: number;

  // --- 登攀生成 ---
  climb: {
    /** ホールド密度 (1平方m あたり) */
    density: number;
    /** 到達可能距離 (m) */
    reach: number;
    /** 高コストホールド (small/bad) の比率 */
    hardRatio: number;
    /** 行き止まりの比率 */
    deadEndRatio: number;
    /** 休憩地点 (ledge) の比率 */
    restRatio: number;
  };

  // --- 装備・環境 ---
  /** 携行できるロープの本数 */
  ropes: number;
  /** 最大スタミナが削れる速さの倍率 */
  fatigueScale: number;
}

const PROFILES: Record<DifficultyLevel, DifficultyProfile> = {
  1: {
    level: 1,
    label: 'ハイキング',
    summary: '歩行中心。ときどき小さな段差。',
    peakHeight: 108,
    radius: 300,
    ridgeAmp: 9,
    valleyAmp: 5,
    cliffiness: 0.08,
    bandHeight: 9,
    cliffFracBase: 0.3,
    cliffFracVar: 0.06,
    snowLine: 1.6,
    snowMax: 0,
    climb: { density: 0.26, reach: 2.6, hardRatio: 0.1, deadEndRatio: 0.05, restRatio: 0.3 },
    ropes: 0,
    fatigueScale: 0.4,
  },
  2: {
    level: 2,
    label: '一般登山',
    summary: '急斜面と岩場。短い登攀と浅い雪。',
    peakHeight: 145,
    radius: 320,
    ridgeAmp: 14,
    valleyAmp: 8,
    cliffiness: 0.34,
    bandHeight: 14,
    cliffFracBase: 0.26,
    cliffFracVar: 0.07,
    snowLine: 0.82,
    snowMax: 0.35,
    climb: { density: 0.24, reach: 2.7, hardRatio: 0.2, deadEndRatio: 0.1, restRatio: 0.24 },
    ropes: 1,
    fatigueScale: 0.7,
  },
  3: {
    level: 3,
    label: '岩稜',
    summary: '長い登攀と積雪。ルートファインディングが要る。',
    peakHeight: 178,
    radius: 340,
    ridgeAmp: 19,
    valleyAmp: 11,
    cliffiness: 0.6,
    bandHeight: 20,
    cliffFracBase: 0.22,
    cliffFracVar: 0.07,
    snowLine: 0.62,
    snowMax: 0.7,
    climb: { density: 0.227, reach: 2.8, hardRatio: 0.32, deadEndRatio: 0.16, restRatio: 0.18 },
    ropes: 2,
    fatigueScale: 1.0,
  },
  4: {
    level: 4,
    label: '高難度',
    summary: '深雪と連続する岩壁。ロープの使いどころを誤ると届かない。',
    peakHeight: 200,
    radius: 355,
    ridgeAmp: 24,
    valleyAmp: 14,
    cliffiness: 0.8,
    bandHeight: 26,
    cliffFracBase: 0.18,
    cliffFracVar: 0.06,
    snowLine: 0.45,
    snowMax: 1.05,
    climb: { density: 0.21, reach: 2.9, hardRatio: 0.44, deadEndRatio: 0.22, restRatio: 0.13 },
    ropes: 3,
    fatigueScale: 1.35,
  },
  5: {
    level: 5,
    label: '最高難度',
    summary: 'どのルートを選ぶかが登頂可否を決める。',
    peakHeight: 222,
    radius: 370,
    ridgeAmp: 28,
    valleyAmp: 17,
    cliffiness: 0.94,
    bandHeight: 32,
    cliffFracBase: 0.14,
    cliffFracVar: 0.05,
    snowLine: 0.3,
    snowMax: 1.4,
    climb: { density: 0.198, reach: 3.0, hardRatio: 0.55, deadEndRatio: 0.28, restRatio: 0.1 },
    ropes: 4,
    fatigueScale: 1.75,
  },
};

export function difficultyProfile(level: DifficultyLevel): DifficultyProfile {
  return PROFILES[level];
}

export const DIFFICULTY_LEVELS: DifficultyLevel[] = [1, 2, 3, 4, 5];
