// WebSocket 消息协议（全部是 JSON，用 type 字段区分）。
// 前端 public/app.js 里用的是同一套字段。

// ---------- 客户端 → 服务端 ----------

export interface JoinMsg {
  type: "join";
  playerId: string; // 存在 localStorage 里的随机 id，用来断线重连
  name?: string;
}

export interface SubmitMsg {
  type: "submit";
  word: string;
}

/**
 * 结果页上的选择：same=true 是“我觉得一样”，same=false 是“不一样，下一轮”。
 * 选了就不能改；对方选好之前看不到你选了什么。
 */
export interface SameVoteMsg {
  type: "same_vote";
  round: number; // 投的是哪一轮，防止刚好跨轮时投错
  same: boolean;
}

export interface RematchMsg {
  type: "rematch";
}

/** 主动离开房间，空出位置（比如换了手机/浏览器） */
export interface LeaveMsg {
  type: "leave";
}

export type ClientMsg = JoinMsg | SubmitMsg | SameVoteMsg | RematchMsg | LeaveMsg;

// ---------- 服务端 → 客户端 ----------

/** waiting 等人 → input 各自写词 → reveal 结果页（一起看、各自选） → 回到 input，或者 over */
export type Phase = "waiting" | "input" | "reveal" | "over";
export type WinBy = "same_word" | "same_meaning";

export interface PlayerView {
  id: string;
  name: string;
  online: boolean;
  you: boolean;
}

export interface RoundView {
  round: number;
  mine: string;
  theirs: string;
  /** 结果页上各自的选择；双方都选完之前是 null */
  myVote: boolean | null;
  theirVote: boolean | null;
}

export interface ResultView {
  rounds: number;
  by: WinBy;
  mine: string;
  theirs: string;
}

export interface PastGameView {
  gameNo: number;
  rounds: number;
  by: WinBy;
  words: string[];
}

/** 当前房间的完整快照（按接收者视角定制，绝不包含对方本轮还没揭晓的词） */
export interface StateMsg {
  type: "state";
  room: string;
  you: string;
  phase: Phase;
  gameNo: number;
  round: number;
  players: PlayerView[];
  history: RoundView[];
  used: string[];
  mySubmission: string | null; // input 阶段：我这一轮写的词
  opponentSubmitted: boolean;
  myVote: boolean | null; // reveal 阶段：我的选择（还没选是 null）
  opponentVoted: boolean; // reveal 阶段：对方选了没有（不透露选了什么）
  rematch: { me: boolean; opponent: boolean };
  result: ResultView | null;
  pastGames: PastGameView[];
}

export interface OpponentSubmittedMsg {
  type: "opponent_submitted";
  round: number;
}

export interface RevealMsg {
  type: "reveal";
  round: number;
  mine: string;
  theirs: string;
  match: boolean;
}

export interface WinMsg {
  type: "win";
  rounds: number;
  by: WinBy;
  mine: string;
  theirs: string;
}

export type ErrorCode =
  | "bad_message"
  | "not_joined"
  | "no_room"
  | "room_full"
  | "replaced"
  | "waiting_opponent"
  | "game_over"
  | "game_not_over"
  | "already_submitted"
  | "empty_word"
  | "word_too_long"
  | "used_word"
  | "revealing"
  | "nothing_to_vote"
  | "already_voted"
  | "stale_vote";

export interface ErrorMsg {
  type: "error";
  code: ErrorCode;
  message: string;
}

export type ServerMsg = StateMsg | OpponentSubmittedMsg | RevealMsg | WinMsg | ErrorMsg;

/** 自定义 WebSocket 关闭码：收到这些码时客户端不应自动重连 */
export const CloseCode = {
  Replaced: 4000, // 同一个玩家在别处连上了
  RoomFull: 4001,
  Left: 4003, // 玩家主动离开
  NoRoom: 4004,
} as const;
