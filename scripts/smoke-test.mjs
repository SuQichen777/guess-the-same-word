#!/usr/bin/env node
// 端到端冒烟测试：模拟两个（以及第三个）玩家，通过真实的 HTTP/WebSocket 打 wrangler dev。
//
//   npm run dev                       # 另一个终端先启动
//   npm run test:smoke                # 默认测 http://localhost:8787
//   node scripts/smoke-test.mjs https://same-word.xxx.workers.dev   # 也可以测线上
//
// 持久化测试（验证状态存在 ctx.storage，而不只是内存）：
//   node scripts/smoke-test.mjs --persist-setup   # 打到结果页、一方已选择，把房间信息写到 .wrangler/persist-test.json
//   # 停掉并重启 wrangler dev
//   node scripts/smoke-test.mjs --persist-verify  # 重连后检查状态是否完整恢复
//
// 需要 Node.js 22+（自带全局 WebSocket）。

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const BASE = (args.find((a) => !a.startsWith("--")) || process.env.BASE_URL || "http://localhost:8787").replace(/\/$/, "");
const WS_BASE = BASE.replace(/^http/, "ws");
const PERSIST_FILE = ".wrangler/persist-test.json";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomId = () => randomBytes(16).toString("hex");

class Player {
  constructor(label, name, pid = randomId()) {
    this.label = label;
    this.name = name;
    this.pid = pid;
    this.queue = [];
    this.all = [];
    this.closeCode = null;
  }

  connect(code) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${WS_BASE}/ws/${code}`);
      this.ws = ws;
      ws.onopen = () => resolve(this);
      ws.onerror = () => reject(new Error(`${this.label}: WebSocket 连接失败`));
      ws.onmessage = (e) => {
        const msg = e.data === "pong" ? { type: "pong" } : JSON.parse(e.data);
        this.queue.push(msg);
        this.all.push(msg);
      };
      ws.onclose = (e) => { this.closeCode = e.code; };
    });
  }

  async join(code) {
    await this.connect(code);
    this.send({ type: "join", playerId: this.pid, name: this.name });
    return this;
  }

  send(msg) {
    this.ws.send(typeof msg === "string" ? msg : JSON.stringify(msg));
  }

  /** 等到第一条满足条件的消息（丢弃它之前的消息） */
  async take(pred, label, timeout = 4000) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const i = this.queue.findIndex(pred);
      if (i >= 0) return this.queue.splice(0, i + 1).at(-1);
      if (Date.now() > deadline) {
        throw new Error(`${this.label}: 等待「${label}」超时，收到的是 ${JSON.stringify(this.queue.map((m) => m.type))}`);
      }
      await sleep(15);
    }
  }

  state(pred = () => true, label = "state") {
    return this.take((m) => m.type === "state" && pred(m), label);
  }

  error(code) {
    return this.take((m) => m.type === "error" && m.code === code, `error:${code}`);
  }

  async closed(timeout = 4000) {
    const deadline = Date.now() + timeout;
    while (this.closeCode === null) {
      if (Date.now() > deadline) throw new Error(`${this.label}: 等待连接关闭超时`);
      await sleep(15);
    }
    return this.closeCode;
  }

  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

let passed = 0;
async function step(name, fn) {
  process.stdout.write(`  • ${name} … `);
  try {
    await fn();
    passed += 1;
    console.log("ok");
  } catch (e) {
    console.log("FAILED");
    throw e;
  }
}

async function createRoom() {
  const res = await fetch(`${BASE}/api/room`, { method: "POST" });
  assert.equal(res.status, 201);
  const { code } = await res.json();
  assert.match(code, /^[A-Z]{4}$/);
  return code;
}

async function submitBoth(a, b, wa, wb) {
  a.send({ type: "submit", word: wa });
  await a.state((s) => s.mySubmission !== null, "A 已提交");
  b.send({ type: "submit", word: wb });
  const ra = await a.take((m) => m.type === "reveal", "reveal");
  const rb = await b.take((m) => m.type === "reveal", "reveal");
  return [ra, rb];
}

// ------------------------------------------------------------------
async function fullTest() {
  console.log(`测试目标：${BASE}\n`);
  let code;
  const A = new Player("A", "小A");
  const B = new Player("B", "小B");

  await step("静态首页可访问", async () => {
    const res = await fetch(`${BASE}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /同词相遇/);
  });

  await step("POST /api/room 返回 4 位大写房间码；GET 返回 405", async () => {
    code = await createRoom();
    assert.equal((await fetch(`${BASE}/api/room`)).status, 405);
  });

  await step("/ws/:code 非 WebSocket 请求返回 426", async () => {
    assert.equal((await fetch(`${BASE}/ws/${code}`)).status, 426);
  });

  await step("A 加入：等待对手", async () => {
    await A.join(code);
    const s = await A.state();
    assert.equal(s.phase, "waiting");
    assert.equal(s.players.length, 1);
    assert.equal(s.room, code);
  });

  await step("房间码大小写不敏感，B 加入后开始游戏", async () => {
    await B.join(code.toLowerCase());
    const sb = await B.state((s) => s.players.length === 2);
    assert.equal(sb.phase, "input");
    assert.equal(sb.round, 1);
    const sa = await A.state((s) => s.players.length === 2);
    assert.deepEqual(sa.players.map((p) => p.name), ["小A", "小B"]);
    assert.ok(sa.players.every((p) => p.online));
  });

  await step("第 3 人被拒绝（error room_full + 关闭码 4001）", async () => {
    const C = await new Player("C", "小C").join(code);
    await C.error("room_full");
    assert.equal(await C.closed(), 4001);
  });

  await step("心跳 ping → pong（自动回复）", async () => {
    A.send("ping");
    await A.take((m) => m.type === "pong", "pong");
  });

  await step("A 提交后，B 只收到“对方已提交”，看不到内容", async () => {
    B.all.length = 0;
    A.send({ type: "submit", word: "  Apple  " });
    const sa = await A.state((s) => s.mySubmission !== null);
    assert.equal(sa.mySubmission, "Apple");
    const ev = await B.take((m) => m.type === "opponent_submitted", "opponent_submitted");
    assert.equal(ev.round, 1);
    const sb = await B.state((s) => s.opponentSubmitted);
    assert.equal(sb.mySubmission, null);
    await sleep(100);
    assert.ok(!JSON.stringify(B.all).toLowerCase().includes("apple"), "B 收到的消息里不该出现 apple");
  });

  await step("重复提交被拒绝", async () => {
    A.send({ type: "submit", word: "pear" });
    await A.error("already_submitted");
  });

  await step("双方都提交后同时揭晓，进入结果页（还是第 1 轮）", async () => {
    B.send({ type: "submit", word: "banana" });
    const ra = await A.take((m) => m.type === "reveal", "reveal");
    const rb = await B.take((m) => m.type === "reveal", "reveal");
    assert.deepEqual([ra.mine, ra.theirs, ra.match], ["Apple", "banana", false]);
    assert.deepEqual([rb.mine, rb.theirs, rb.match], ["banana", "Apple", false]);
    const s = await A.state((x) => x.phase === "reveal");
    assert.equal(s.round, 1);
    assert.deepEqual(s.used, ["Apple", "banana"]);
    assert.deepEqual(s.history, [{ round: 1, mine: "Apple", theirs: "banana", myVote: null, theirVote: null }]);
    assert.equal(s.myVote, null);
    assert.equal(s.opponentVoted, false);
  });

  await step("结果页上不能提交新词；过期轮次的选择被拒绝", async () => {
    A.send({ type: "submit", word: "pear" });
    await A.error("revealing");
    A.send({ type: "same_vote", round: 99, same: true });
    await A.error("stale_vote");
  });

  await step("A 选“一样”：B 只知道 A 选好了，不知道选了什么；不能改选", async () => {
    B.all.length = 0;
    A.send({ type: "same_vote", round: 1, same: true });
    const sa = await A.state((x) => x.myVote === true);
    assert.equal(sa.phase, "reveal");
    const sb = await B.state((x) => x.opponentVoted);
    assert.equal(sb.myVote, null);
    assert.equal(sb.history[0].theirVote, null);
    await sleep(100);
    assert.ok(B.all.every((m) => m.type !== "state" || m.history.every((r) => r.theirVote === null)), "B 不该提前看到 A 的选择");
    A.send({ type: "same_vote", round: 1, same: false });
    await A.error("already_voted");
  });

  await step("B 选“不一样” → 进入第 2 轮，双方的选择这时才公开", async () => {
    B.send({ type: "same_vote", round: 1, same: false });
    const sa = await A.state((x) => x.phase === "input");
    assert.equal(sa.round, 2);
    assert.deepEqual(sa.history[0], { round: 1, mine: "Apple", theirs: "banana", myVote: true, theirVote: false });
    const sb = await B.state((x) => x.phase === "input");
    assert.deepEqual([sb.history[0].myVote, sb.history[0].theirVote], [false, true]);
  });

  await step("用过的词不能再用（大小写 / 全角 / 空格都算同一个）", async () => {
    A.send({ type: "submit", word: "APPLE" });
    await A.error("used_word");
    A.send({ type: "submit", word: "ＢＡＮＡＮＡ" });
    await A.error("used_word");
    A.send({ type: "submit", word: "   " });
    await A.error("empty_word");
    A.send({ type: "submit", word: "x".repeat(31) });
    await A.error("word_too_long");
  });

  await step("还在写词的阶段不能选“一样/不一样”", async () => {
    A.send({ type: "same_vote", round: 2, same: true });
    await A.error("nothing_to_vote");
  });

  await step("写出同一个词（忽略大小写和首尾空格）→ win", async () => {
    const [ra] = await submitBoth(A, B, "Fruit", "  fruit ");
    assert.equal(ra.match, true);
    const wa = await A.take((m) => m.type === "win", "win");
    const wb = await B.take((m) => m.type === "win", "win");
    assert.deepEqual([wa.rounds, wa.by], [2, "same_word"]);
    assert.equal(wb.rounds, 2);
    const s = await A.state((x) => x.phase === "over");
    assert.equal(s.result.rounds, 2);
  });

  await step("结束后不能再提交", async () => {
    A.send({ type: "submit", word: "more" });
    await A.error("game_over");
  });

  await step("再来一局：双方都同意才开新局，状态清空", async () => {
    A.send({ type: "rematch" });
    await A.state((s) => s.rematch.me);
    await B.state((s) => s.rematch.opponent);
    B.send({ type: "rematch" });
    const s = await A.state((x) => x.gameNo === 2);
    assert.equal(s.phase, "input");
    assert.equal(s.round, 1);
    assert.deepEqual(s.history, []);
    assert.deepEqual(s.used, []);
    assert.equal(s.pastGames.length, 1);
  });

  await step("中文词 + 结果页上两人都选“一样” → win（含义相同）", async () => {
    const [ra] = await submitBoth(A, B, "猫咪", "小猫");
    assert.equal(ra.match, false);
    await B.state((s) => s.phase === "reveal");
    A.send({ type: "same_vote", round: 1, same: true });
    await B.state((s) => s.opponentVoted);
    B.send({ type: "same_vote", round: 1, same: true });
    const w = await A.take((m) => m.type === "win", "win");
    assert.deepEqual([w.by, w.rounds, w.mine, w.theirs], ["same_meaning", 1, "猫咪", "小猫"]);
    const s = await A.state((x) => x.phase === "over" && x.result.by === "same_meaning");
    assert.deepEqual([s.history[0].myVote, s.history[0].theirVote], [true, true]);
  });

  let A2;
  await step("断线：对方看到离线；用同一个 playerId 重连后恢复完整状态", async () => {
    A.close();
    await B.state((s) => s.players.some((p) => !p.you && !p.online), "B 看到 A 离线");
    A2 = await new Player("A2", "小A", A.pid).join(code);
    const s = await A2.state();
    assert.equal(s.phase, "over");
    assert.equal(s.gameNo, 2);
    assert.equal(s.history.length, 1);
    assert.equal(s.result.by, "same_meaning");
    assert.equal(s.pastGames.length, 2);
    await B.state((x) => x.players.every((p) => p.online), "B 看到 A 在线");
  });

  let A3;
  await step("同一玩家开第二个连接时，旧连接被顶掉（4000）", async () => {
    A3 = await new Player("A3", "小A", A.pid).join(code);
    await A3.state();
    await A2.error("replaced");
    assert.equal(await A2.closed(), 4000);
  });

  await step("加入不存在的房间（error no_room + 关闭码 4004）", async () => {
    const X = await new Player("X", "路人").join("QJQJ");
    await X.error("no_room");
    assert.equal(await X.closed(), 4004);
  });

  await step("坏消息 / 未加入就提交 都会返回错误", async () => {
    const Y = await new Player("Y", "路人").connect(code);
    Y.send("this is not json");
    await Y.error("bad_message");
    Y.send({ type: "submit", word: "hi" });
    await Y.error("not_joined");
    Y.close();
  });

  await step("离开房间：位置空出来，新玩家可以加入", async () => {
    B.send({ type: "leave" });
    assert.equal(await B.closed(), 4003);
    const s = await A3.state((x) => x.players.length === 1);
    assert.equal(s.phase, "waiting");
    const D = await new Player("D", "小D").join(code);
    const sd = await D.state((x) => x.players.length === 2);
    assert.equal(sd.phase, "input");
    assert.equal(sd.history.length, 0);
    D.close();
  });

  A3.close();
  console.log(`\n全部通过：${passed} 项 ✅`);
}

// ------------------------------------------------------------------
async function persistSetup() {
  const code = await createRoom();
  const A = await new Player("A", "持久A").join(code);
  const B = await new Player("B", "持久B").join(code);
  await A.state((s) => s.phase === "input");
  await submitBoth(A, B, "太阳", "月亮");
  await A.state((s) => s.phase === "reveal");
  A.send({ type: "same_vote", round: 1, same: true });
  await A.state((s) => s.myVote === true);
  A.close();
  B.close();
  mkdirSync(".wrangler", { recursive: true });
  writeFileSync(PERSIST_FILE, JSON.stringify({ code, a: A.pid, b: B.pid }));
  console.log(`已创建房间 ${code}：第 1 轮已揭晓，A 已在结果页选了“一样”。现在重启 wrangler dev，然后运行 --persist-verify`);
}

async function persistVerify() {
  const { code, a, b } = JSON.parse(readFileSync(PERSIST_FILE, "utf8"));
  const A = await new Player("A", "持久A", a).join(code);
  const B = await new Player("B", "持久B", b).join(code);
  const sa = await A.state((s) => s.players.length === 2);
  const sb = await B.state((s) => s.players.every((p) => p.online));
  assert.equal(sa.phase, "reveal");
  assert.equal(sa.round, 1);
  assert.equal(sa.myVote, true);
  assert.deepEqual(sa.history, [{ round: 1, mine: "太阳", theirs: "月亮", myVote: null, theirVote: null }]);
  assert.equal(sb.opponentVoted, true);
  assert.equal(sb.myVote, null);
  B.send({ type: "same_vote", round: 1, same: true });
  const w = await B.take((m) => m.type === "win", "win");
  assert.deepEqual([w.rounds, w.by, w.mine, w.theirs], [1, "same_meaning", "月亮", "太阳"]);
  A.close();
  B.close();
  console.log(`房间 ${code} 重启后状态（包括还没公开的选择）完整恢复，并能继续打完 ✅`);
}

try {
  if (flags.has("--persist-setup")) await persistSetup();
  else if (flags.has("--persist-verify")) await persistVerify();
  else await fullTest();
  process.exit(0);
} catch (e) {
  console.error("\n❌", e.message);
  process.exit(1);
}
