import type { CharacterId } from '../engine/index.js';

export const AI_GRADE = {
  NOVICE: 'NOVICE',
  SORCERER: 'SORCERER',
  ELITE: 'ELITE',
  SPECIAL: 'SPECIAL',
} as const;
export type AiGrade = (typeof AI_GRADE)[keyof typeof AI_GRADE];

export interface AiGradeProfile {
  readonly grade: AiGrade;
  readonly label: string;
  /** Character the bot plays with at this grade. */
  readonly characterId: CharacterId;
  /** Chance that a card seen face-up is committed to memory. */
  readonly memoryRetention: number;
  /** Simulated human thinking time before each move. */
  readonly moveDelayMs: number;
  /** Chance that a move ignores known pairs and guesses at random. */
  readonly blindGuessRate: number;
  /** Uses its 50-CE skill once cursed energy reaches this value; null = never. */
  readonly skillCeThreshold: number | null;
  /** Casts its 100-CE ultimate once cursed energy reaches this value; null = never. */
  readonly ultimateCeThreshold: number | null;
  /**
   * Chance that a Deadly Sentencing pick names the target. A miss names a wrong slot, so
   * this is the hit rate.
   */
  readonly courtroomAccuracy: number;
}

export const AI_GRADE_PROFILES: Readonly<Record<AiGrade, AiGradeProfile>> = {
  NOVICE: {
    grade: AI_GRADE.NOVICE,
    label: 'Grade 4 · Novice',
    characterId: 'yuji_itadori',
    memoryRetention: 0.3,
    moveDelayMs: 1800,
    blindGuessRate: 0.3,
    skillCeThreshold: null,
    ultimateCeThreshold: null,
    courtroomAccuracy: 0.25,
  },
  SORCERER: {
    grade: AI_GRADE.SORCERER,
    label: 'Grade 2 · Sorcerer',
    characterId: 'nobara_kugisaki',
    memoryRetention: 0.6,
    moveDelayMs: 1200,
    blindGuessRate: 0.15,
    skillCeThreshold: 50,
    ultimateCeThreshold: null,
    courtroomAccuracy: 0.5,
  },
  ELITE: {
    grade: AI_GRADE.ELITE,
    label: 'Grade 1 · Elite',
    characterId: 'kento_nanami',
    memoryRetention: 0.85,
    moveDelayMs: 800,
    blindGuessRate: 0.05,
    skillCeThreshold: 50,
    ultimateCeThreshold: 100,
    courtroomAccuracy: 0.75,
  },
  SPECIAL: {
    grade: AI_GRADE.SPECIAL,
    label: 'Special Grade · Sukuna',
    characterId: 'sukuna',
    memoryRetention: 0.98,
    moveDelayMs: 450,
    blindGuessRate: 0,
    skillCeThreshold: null,
    ultimateCeThreshold: 100,
    courtroomAccuracy: 0.85,
  },
};

export const AI_GRADE_ORDER: readonly AiGrade[] = [AI_GRADE.NOVICE, AI_GRADE.SORCERER, AI_GRADE.ELITE, AI_GRADE.SPECIAL];
