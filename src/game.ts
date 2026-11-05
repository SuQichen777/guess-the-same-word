// 纯游戏逻辑：不依赖 Workers 运行时，方便单独理解和测试。

import type { ErrorCode, Phase, WinBy } from "./protocol";

export const MAX_WORD_LEN = 30;
export const MAX_NAME_LEN = 16;
export const MAX_PAST_GAMES = 20;

export interface PlayerInfo {
  id: string;
  name: string;
}

export interface Submission {
  word: string; // 展示用（去掉首尾空格）
  norm: string; // 比较用（归一化后）
}

export interface RoundRecord {
  round: number;
  words: Record<string, string>; // playerId -> 展示用的词
  votes?: Record<string, boolean>; // 结果页上双方的选择，两人都选完才写入
}

export interface GameResult {
  rounds: number;
  by: WinBy;
  words: Record<string, string>;
}

export interface PastGame {
  gameNo: number;
  rounds: number;
  by: WinBy;
  words: string[];
}

/** 存在 ctx.storage 里的整个房间状态 */
export interface RoomState {
  code: string;
  createdAt: number;
  lastActiveAt: number;
  players: PlayerInfo[]; // 最多 2 人，按加入顺序
  gameNo: number;
  phase: Phase;
  round: number; // 当前回合（从 1 开始）；reveal 阶段是正在看结果的那一轮
  submissions: Record<string, Submission>; // 本轮已提交但未揭晓的词
  used: string[]; // 已揭晓过的词（归一化后）
  history: RoundRecord[];
  votes: Record<string, boolean>; // reveal 阶段各自的选择（true=觉得一样）
  rematch: Record<string, boolean>;
  result: GameResult | null;
  pastGames: PastGame[];
}

export function newRoomState(code: string, now: number): RoomState {
  return {
    code,
    createdAt: now,
    lastActiveAt: now,
    players: [],
    gameNo: 1,
    phase: "waiting",
    round: 1,
    submissions: {},
    used: [],
    history: [],
    votes: {},
    rematch: {},
    result: null,
    pastGames: [],
  };
}

/** 兼容旧版本存下来的状态（旧版没有 reveal 阶段） */
export function migrateState(raw: RoomState): RoomState {
  const s = raw as RoomState & { sameVotes?: unknown };
  if ((s.phase as string) === "playing") s.phase = "input";
  s.votes ??= {};
  delete s.sameVotes;
  return s;
}

/** 开新的一局（保留玩家和战绩） */
export function resetGame(s: RoomState, phase: Phase): void {
  s.phase = phase;
  s.round = 1;
  s.submissions = {};
  s.used = [];
  s.history = [];
  s.votes = {};
  s.rematch = {};
  s.result = null;
}

/** 结束当前这局并记入战绩 */
export function finishGame(s: RoomState, rounds: number, by: WinBy, words: Record<string, string>): void {
  s.phase = "over";
  s.result = { rounds, by, words };
  s.submissions = {};
  s.votes = {};
  s.rematch = {};
  s.pastGames.push({ gameNo: s.gameNo, rounds, by, words: Object.values(words) });
  if (s.pastGames.length > MAX_PAST_GAMES) s.pastGames.splice(0, s.pastGames.length - MAX_PAST_GAMES);
}

// 去掉控制字符和零宽空格这类看不见的字符
const INVISIBLE = /[\p{Cc}​﻿]/gu;

/** 展示用：全角转半角(NFKC)、去首尾空格、中间连续空白合成一个 */
export function cleanText(raw: string): string {
  return raw.normalize("NFKC").replace(INVISIBLE, "").trim().replace(/\s+/gu, " ");
}

/** 比较用：在 cleanText 基础上英文统一小写（中文不受影响） */
export function normalizeWord(raw: string): string {
  return cleanText(raw).toLowerCase();
}

export function codePointLength(s: string): number {
  return [...s].length;
}

export type WordCheck =
  | { ok: true; word: string; norm: string }
  | { ok: false; code: ErrorCode; message: string };

export function checkWord(raw: unknown, used: readonly string[]): WordCheck {
  if (typeof raw !== "string") return { ok: false, code: "bad_message", message: "词的格式不对" };
  const word = cleanText(raw);
  const norm = word.toLowerCase();
  if (!word) return { ok: false, code: "empty_word", message: "不能提交空的词" };
  if (codePointLength(word) > MAX_WORD_LEN) {
    return { ok: false, code: "word_too_long", message: `词太长了（最多 ${MAX_WORD_LEN} 个字）` };
  }
  if (used.includes(norm)) {
    return { ok: false, code: "used_word", message: `「${word}」已经有人用过了，换一个吧` };
  }
  return { ok: true, word, norm };
}

export function cleanName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return [...cleanText(raw)].slice(0, MAX_NAME_LEN).join("");
}

const PLAYER_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function isValidPlayerId(raw: unknown): raw is string {
  return typeof raw === "string" && PLAYER_ID_RE.test(raw);
}
