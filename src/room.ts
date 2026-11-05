import { DurableObject } from "cloudflare:workers";
import {
  checkWord,
  cleanName,
  finishGame,
  isValidPlayerId,
  migrateState,
  newRoomState,
  resetGame,
  type RoomState,
} from "./game";
import {
  CloseCode,
  type ClientMsg,
  type ErrorCode,
  type JoinMsg,
  type SameVoteMsg,
  type ServerMsg,
  type StateMsg,
  type SubmitMsg,
} from "./protocol";

const STATE_KEY = "state";
/** 房间最后一个人断开后保留多久，过期自动清理（房间码可被复用） */
const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
/** 定时清理时，超过这么久没收到心跳的连接视为已经死掉 */
const STALE_SOCKET_MS = 10 * 60 * 1000;
const MAX_MESSAGE_LENGTH = 2048;

/** 每条 WebSocket 上附带的身份信息，休眠后也能取回 */
interface Attachment {
  cid: string; // 连接 id，用来区分同一个玩家的不同连接
  pid: string | null; // 发过 join 之后才有
}

/** 把一局里的 {playerId: 词} 按“我/对方”拆开 */
function split(words: Record<string, string>, pid: string): { mine: string; theirs: string } {
  let theirs = "";
  for (const [id, w] of Object.entries(words)) if (id !== pid) theirs = w;
  return { mine: words[pid] ?? "", theirs };
}

export class Room extends DurableObject<Env> {
  /** 内存里的缓存；真正的数据源是 ctx.storage，每次改动都会写回去 */
  private s: RoomState | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // 心跳：客户端发 "ping"，运行时直接回 "pong"，不会把休眠中的 DO 叫醒
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    // DO 休眠或被回收后再次创建时，从存储恢复状态
    void ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<RoomState>(STATE_KEY);
      this.s = saved ? migrateState(saved) : null;
    });
  }

  // ---------------- 给 Worker 调用的 RPC ----------------

  /** 占用这个房间码。已被占用时返回 false，Worker 会换一个码重试 */
  async create(code: string): Promise<boolean> {
    if (this.s) return false;
    const now = Date.now();
    this.s = newRoomState(code, now);
    await this.save();
    await this.ctx.storage.setAlarm(now + ROOM_TTL_MS);
    return true;
  }

  // ---------------- WebSocket 生命周期 ----------------

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    // Hibernation API：由运行时托管连接，空闲时 DO 可以休眠而连接不断
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ cid: crypto.randomUUID(), pid: null } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string" || raw.length > MAX_MESSAGE_LENGTH) {
      return this.error(ws, "bad_message", "消息格式不对");
    }
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw) as ClientMsg;
    } catch {
      return this.error(ws, "bad_message", "消息格式不对");
    }
    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") {
      return this.error(ws, "bad_message", "消息格式不对");
    }

    if (!this.s) {
      // 房间从没创建过，或者已经过期被清理了
      this.error(ws, "no_room", "房间不存在或已过期");
      this.close(ws, CloseCode.NoRoom, "no room");
      return;
    }

    if (msg.type === "join") return this.onJoin(ws, msg);

    const pid = this.pidOf(ws);
    if (!pid || !this.s.players.some((p) => p.id === pid)) {
      return this.error(ws, "not_joined", "请先加入房间");
    }
    switch (msg.type) {
      case "submit":
        return this.onSubmit(ws, pid, msg);
      case "same_vote":
        return this.onVote(ws, pid, msg);
      case "rematch":
        return this.onRematch(ws, pid);
      case "leave":
        return this.onLeave(pid);
      default:
        return this.error(ws, "bad_message", "未知的消息类型");
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // 回应关闭握手（如果运行时已经自动回应过，这里会静默失败）
    this.close(ws, 1000, "bye");
    await this.onDisconnect(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.onDisconnect(ws);
  }

  /** 定时清理：房间长时间没人连接就删掉存储 */
  async alarm(): Promise<void> {
    const now = Date.now();
    for (const ws of this.openSockets()) {
      const lastPing = this.ctx.getWebSocketAutoResponseTimestamp(ws);
      if (!lastPing || now - lastPing.getTime() > STALE_SOCKET_MS) this.close(ws, 1001, "stale");
    }
    if (!this.s) {
      await this.ctx.storage.deleteAll();
      return;
    }
    if (this.openSockets().length > 0) {
      await this.ctx.storage.setAlarm(now + ROOM_TTL_MS);
      return;
    }
    const expiresAt = this.s.lastActiveAt + ROOM_TTL_MS;
    if (now < expiresAt) {
      await this.ctx.storage.setAlarm(expiresAt);
      return;
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.s = null;
  }

  // ---------------- 消息处理 ----------------

  private async onJoin(ws: WebSocket, msg: JoinMsg): Promise<void> {
    const s = this.s!;
    if (!isValidPlayerId(msg.playerId)) return this.error(ws, "bad_message", "玩家 id 不合法");
    const pid = msg.playerId;
    const current = this.pidOf(ws);
    if (current && current !== pid) return this.error(ws, "bad_message", "这个连接已经以别的身份加入了");

    const name = cleanName(msg.name);
    let player = s.players.find((p) => p.id === pid);
    if (!player) {
      if (s.players.length >= 2) {
        this.error(ws, "room_full", "房间已满（最多 2 人）");
        this.close(ws, CloseCode.RoomFull, "room full");
        return;
      }
      player = { id: pid, name: name || `玩家${s.players.length + 1}` };
      s.players.push(player);
      if (s.players.length === 2 && s.phase === "waiting") s.phase = "input";
    } else if (name) {
      player.name = name; // 老玩家重连，顺便更新昵称
    }

    // 同一个玩家只保留最新的连接（比如同时开了两个标签页）
    const myCid = this.attachment(ws)?.cid;
    for (const other of this.openSockets()) {
      const a = this.attachment(other);
      if (a && a.pid === pid && a.cid !== myCid) {
        other.serializeAttachment({ cid: a.cid, pid: null } satisfies Attachment);
        this.error(other, "replaced", "你在别的页面打开了这个房间");
        this.close(other, CloseCode.Replaced, "replaced");
      }
    }

    ws.serializeAttachment({ cid: myCid ?? crypto.randomUUID(), pid } satisfies Attachment);
    s.lastActiveAt = Date.now();
    await this.save();
    this.broadcastState();
  }

  private async onSubmit(ws: WebSocket, pid: string, msg: SubmitMsg): Promise<void> {
    const s = this.s!;
    if (s.phase === "waiting") return this.error(ws, "waiting_opponent", "等对方加入后才能开始");
    if (s.phase === "reveal") return this.error(ws, "revealing", "先在结果页选一下");
    if (s.phase === "over") return this.error(ws, "game_over", "这一局已经结束了");
    if (s.submissions[pid]) return this.error(ws, "already_submitted", "这一轮你已经提交过了");

    const check = checkWord(msg.word, s.used);
    if (!check.ok) return this.error(ws, check.code, check.message);

    s.submissions[pid] = { word: check.word, norm: check.norm };
    s.lastActiveAt = Date.now();

    const opp = this.opponentOf(pid);
    const theirs = opp ? s.submissions[opp] : undefined;
    if (!opp || !theirs) {
      // 只告诉对方“已提交”，不透露内容
      await this.save();
      if (opp) this.sendTo(opp, { type: "opponent_submitted", round: s.round });
      this.broadcastState();
      return;
    }

    // 双方都交了：同时揭晓。写的一样直接赢，不一样就进入结果页让两人各自选
    const mine = s.submissions[pid]!;
    const round = s.round;
    const words: Record<string, string> = { [pid]: mine.word, [opp]: theirs.word };
    s.history.push({ round, words });
    for (const n of [mine.norm, theirs.norm]) if (!s.used.includes(n)) s.used.push(n);
    s.submissions = {};
    s.votes = {};

    const match = mine.norm === theirs.norm;
    if (match) finishGame(s, round, "same_word", words);
    else s.phase = "reveal";
    await this.save();

    for (const p of s.players) {
      const view = split(words, p.id);
      this.sendTo(p.id, { type: "reveal", round, match, ...view });
      if (match) this.sendTo(p.id, { type: "win", rounds: round, by: "same_word", ...view });
    }
    this.broadcastState();
  }

  /** 结果页上的选择。两人都选完才揭晓：都觉得一样就赢，否则进入下一轮 */
  private async onVote(ws: WebSocket, pid: string, msg: SameVoteMsg): Promise<void> {
    const s = this.s!;
    if (s.phase === "waiting") return this.error(ws, "waiting_opponent", "等对方加入后才能开始");
    if (s.phase === "over") return this.error(ws, "game_over", "这一局已经结束了");
    if (s.phase !== "reveal") return this.error(ws, "nothing_to_vote", "还没到看结果的时候");
    if (msg.round !== s.round) return this.error(ws, "stale_vote", "那一轮已经过去了");
    if (s.votes[pid] !== undefined) return this.error(ws, "already_voted", "你已经选过了");

    s.votes[pid] = msg.same === true;
    s.lastActiveAt = Date.now();

    const opp = this.opponentOf(pid);
    if (!opp || s.votes[opp] === undefined) {
      // 对方只会知道“你选好了”，不知道你选了什么
      await this.save();
      this.broadcastState();
      return;
    }

    const last = s.history.at(-1)!;
    last.votes = { ...s.votes };
    if (s.votes[pid] && s.votes[opp]) {
      // 两人都认为这两个词意思一样：也算赢
      finishGame(s, last.round, "same_meaning", last.words);
      await this.save();
      for (const p of s.players) {
        this.sendTo(p.id, { type: "win", rounds: last.round, by: "same_meaning", ...split(last.words, p.id) });
      }
      this.broadcastState();
      return;
    }

    s.round += 1;
    s.phase = "input";
    s.votes = {};
    await this.save();
    this.broadcastState();
  }

  private async onRematch(ws: WebSocket, pid: string): Promise<void> {
    const s = this.s!;
    if (s.phase !== "over") return this.error(ws, "game_not_over", "这一局还没结束");
    s.rematch[pid] = true;
    s.lastActiveAt = Date.now();
    if (s.players.length === 2 && s.players.every((p) => s.rematch[p.id])) {
      s.gameNo += 1;
      resetGame(s, "input");
    }
    await this.save();
    this.broadcastState();
  }

  private async onLeave(pid: string): Promise<void> {
    const s = this.s!;
    s.players = s.players.filter((p) => p.id !== pid);
    // 换了对手就重新开一局
    if (s.phase === "over") s.gameNo += 1;
    resetGame(s, "waiting");
    s.lastActiveAt = Date.now();
    await this.save();
    for (const ws of this.openSockets()) {
      const a = this.attachment(ws);
      if (a?.pid === pid) {
        ws.serializeAttachment({ cid: a.cid, pid: null } satisfies Attachment);
        this.close(ws, CloseCode.Left, "left");
      }
    }
    this.broadcastState();
  }

  private async onDisconnect(ws: WebSocket): Promise<void> {
    const s = this.s;
    if (!s) return;
    if (this.pidOf(ws)) this.broadcastState(ws); // 让对方看到“离线”
    if (this.openSockets(ws).length === 0) {
      s.lastActiveAt = Date.now();
      await this.save();
      await this.ctx.storage.setAlarm(s.lastActiveAt + ROOM_TTL_MS);
    }
  }

  // ---------------- 工具方法 ----------------

  private async save(): Promise<void> {
    await this.ctx.storage.put(STATE_KEY, this.s);
  }

  private attachment(ws: WebSocket): Attachment | null {
    try {
      return (ws.deserializeAttachment() as Attachment | null) ?? null;
    } catch {
      return null;
    }
  }

  private pidOf(ws: WebSocket): string | null {
    return this.attachment(ws)?.pid ?? null;
  }

  /** 当前打开着的连接（可排除一个正在关闭的连接） */
  private openSockets(exclude?: WebSocket): WebSocket[] {
    const excludeCid = exclude ? this.attachment(exclude)?.cid : undefined;
    return this.ctx.getWebSockets().filter((ws) => {
      if (ws.readyState !== WebSocket.OPEN) return false;
      return !excludeCid || this.attachment(ws)?.cid !== excludeCid;
    });
  }

  private opponentOf(pid: string): string | undefined {
    return this.s?.players.find((p) => p.id !== pid)?.id;
  }

  private send(ws: WebSocket, msg: ServerMsg): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // 连接可能刚好断了，忽略
    }
  }

  private sendTo(pid: string, msg: ServerMsg): void {
    for (const ws of this.openSockets()) if (this.pidOf(ws) === pid) this.send(ws, msg);
  }

  private error(ws: WebSocket, code: ErrorCode, message: string): void {
    this.send(ws, { type: "error", code, message });
  }

  private close(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // 已经关闭了
    }
  }

  private broadcastState(exclude?: WebSocket): void {
    const sockets = this.openSockets(exclude);
    const online = new Set(sockets.map((ws) => this.pidOf(ws)).filter((p): p is string => !!p));
    for (const ws of sockets) {
      const pid = this.pidOf(ws);
      if (pid) this.send(ws, this.stateFor(pid, online));
    }
  }

  /** 按某个玩家的视角生成快照：对方本轮还没揭晓的词绝不放进去 */
  private stateFor(pid: string, online: Set<string>): StateMsg {
    const s = this.s!;
    const opp = this.opponentOf(pid);

    // 已用词按回合顺序列出，每轮先列自己的（展示用的词已经 cleanText 过，小写即归一化）
    const used = new Map<string, string>();
    for (const r of s.history) {
      const { mine, theirs } = split(r.words, pid);
      for (const w of [mine, theirs]) {
        const key = w.toLowerCase();
        if (w && !used.has(key)) used.set(key, w);
      }
    }

    return {
      type: "state",
      room: s.code,
      you: pid,
      phase: s.phase,
      gameNo: s.gameNo,
      round: s.round,
      players: s.players.map((p) => ({ id: p.id, name: p.name, online: online.has(p.id), you: p.id === pid })),
      history: s.history.map((r) => {
        let theirVote: boolean | null = null;
        for (const [id, v] of Object.entries(r.votes ?? {})) if (id !== pid) theirVote = v;
        return { round: r.round, ...split(r.words, pid), myVote: r.votes?.[pid] ?? null, theirVote };
      }),
      used: [...used.values()],
      mySubmission: s.submissions[pid]?.word ?? null,
      opponentSubmitted: !!(opp && s.submissions[opp]),
      myVote: s.phase === "reveal" ? (s.votes[pid] ?? null) : null,
      opponentVoted: s.phase === "reveal" && !!opp && s.votes[opp] !== undefined,
      rematch: { me: !!s.rematch[pid], opponent: !!(opp && s.rematch[opp]) },
      result: s.result ? { rounds: s.result.rounds, by: s.result.by, ...split(s.result.words, pid) } : null,
      pastGames: s.pastGames,
    };
  }
}
