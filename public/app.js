// 同词相遇 · 前端（原生 JS，无需构建）
// 消息协议见 src/protocol.ts
"use strict";

(() => {
  const $ = (id) => document.getElementById(id);

  // ---------------- 本地存储（隐私模式下可能不可用） ----------------
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };
  const K_PID = "sw.playerId";
  const K_NAME = "sw.name";
  const K_LAST_ROOM = "sw.lastRoom";

  function randomId() {
    // crypto.randomUUID 只在 https/localhost 可用；getRandomValues 在局域网 http 下也能用
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  }

  let playerId = store.get(K_PID);
  if (!playerId || !/^[A-Za-z0-9_-]{8,64}$/.test(playerId)) {
    playerId = randomId();
    store.set(K_PID, playerId);
  }

  // ---------------- 和服务端一致的词语归一化 ----------------
  const CODE_RE = /^[A-Z]{4}$/;
  const MAX_WORD_LEN = 30;
  const INVISIBLE = /[\p{Cc}​﻿]/gu;
  const cleanText = (s) => s.normalize("NFKC").replace(INVISIBLE, "").trim().replace(/\s+/gu, " ");
  const norm = (s) => cleanText(s).toLowerCase();

  // 这些关闭码代表“不该自动重连”
  const FATAL_CLOSE = {
    4000: "你在别的页面打开了这个房间",
    4001: "房间已满（最多 2 人）",
    4003: "",
    4004: "房间不存在或已过期",
  };
  const FATAL_ERRORS = new Set(["no_room", "room_full", "replaced"]);
  const WORD_ERRORS = new Set(["used_word", "empty_word", "word_too_long", "already_submitted"]);

  // ---------------- 运行时状态 ----------------
  let ws = null;
  let roomCode = null;
  let state = null;
  let retry = 0;
  let retryTimer = 0;
  let pingTimer = 0;
  let lastSeen = 0;
  let pending = false; // 提交了词，等服务端确认
  let voting = false; // 在结果页选了，等服务端确认
  let judgeFresh = false; // 刚揭晓，结果页要播入场动画
  let resultFresh = false; // 刚赢，结束页要播入场动画
  let renderedGame = 0;
  let renderedRounds = 0;

  // ---------------- 小工具 ----------------
  function h(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  let toastTimer = 0;
  function toast(text, kind) {
    const t = $("toast");
    t.textContent = text;
    t.className = "toast show" + (kind ? " " + kind : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = "toast"; }, 2400);
  }

  function buzz(pattern) {
    // 浏览器要求用户先点过页面才允许震动，否则会在控制台报错
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
    try { navigator.vibrate?.(pattern); } catch { /* ignore */ }
  }

  function shake(input) {
    input.classList.remove("shake");
    void input.offsetWidth;
    input.classList.add("shake");
  }

  /** 重新播放某个元素上的 CSS 入场动画 */
  function replay(el, on) {
    el.classList.remove("play");
    if (!on) return;
    void el.offsetWidth;
    el.classList.add("play");
  }

  function myName() {
    return $("name").value.trim() || store.get(K_NAME) || "";
  }

  function initial(name) {
    return name ? [...name][0] : "?";
  }

  /** 按字数调整词的字号，长词不撑破气泡 */
  function fitWord(el, word, sizes) {
    const n = [...word].length;
    const fs = n <= 2 ? sizes[0] : n <= 4 ? sizes[1] : n <= 8 ? sizes[2] : sizes[3];
    el.style.setProperty("--fs", `${fs}px`);
    el.textContent = word;
  }

  /** 爆炸框的锯齿顶点：中心、外半径、内半径、尖角数、纵向压缩 */
  function burstPoints(cx, cy, r1, r2, n, sy) {
    const pts = [];
    for (let i = 0; i < n * 2; i++) {
      const r = (i % 2 ? r2 : r1) * (1 + (((i * 37) % 7) - 3) * 0.035);
      const a = (Math.PI * i) / n - Math.PI / 2;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a) * sy]);
    }
    return pts;
  }

  /** 给页面里的 polygon[data-burst="cx,cy,r1,r2,n,sy"] 填上顶点 */
  function drawBursts() {
    for (const p of document.querySelectorAll("polygon[data-burst]")) {
      const pts = burstPoints(...p.dataset.burst.split(",").map(Number));
      p.setAttribute("points", pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" "));
    }
  }

  function show(screen) {
    $("home").hidden = screen !== "home";
    $("room").hidden = screen !== "room";
  }

  // ---------------- 主题：跟随系统 → 浅色 → 深色 ----------------
  const K_THEME = "sw.theme";
  const THEMES = ["auto", "light", "dark"];
  const THEME_LABEL = { auto: "跟随系统", light: "浅色", dark: "深色" };
  const THEME_ICON = {
    auto: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path class="solid" d="M12 4a8 8 0 0 0 0 16z"/></svg>',
    light: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/></svg>',
    dark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg>',
  };
  const BAR_COLOR = { light: "#fff4dc", dark: "#1a1620" };

  function currentTheme() {
    const t = store.get(K_THEME);
    return t === "light" || t === "dark" ? t : "auto";
  }

  function applyTheme(theme) {
    const root = document.documentElement;
    if (theme === "auto") delete root.dataset.theme;
    else root.dataset.theme = theme;
    for (const btn of document.querySelectorAll(".theme-btn")) {
      btn.innerHTML = THEME_ICON[theme];
      btn.title = `主题：${THEME_LABEL[theme]}`;
      btn.setAttribute("aria-label", `主题：${THEME_LABEL[theme]}，点击切换`);
    }
    // 手机浏览器地址栏的颜色也跟着变
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
      const systemDark = meta.media.includes("dark");
      meta.content = theme === "auto" ? BAR_COLOR[systemDark ? "dark" : "light"] : BAR_COLOR[theme];
    }
  }

  function cycleTheme() {
    const next = THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length];
    if (next === "auto") store.del(K_THEME);
    else store.set(K_THEME, next);
    applyTheme(next);
    toast(`主题：${THEME_LABEL[next]}`);
  }

  // ---------------- 首页 ----------------
  function showHome(message, prefillCode) {
    show("home");
    const msg = $("home-msg");
    msg.hidden = !message;
    msg.textContent = message || "";
    if (prefillCode) $("code").value = prefillCode;
    updateJoinLabel();
    const last = store.get(K_LAST_ROOM);
    const resume = $("resume");
    resume.hidden = !last || last === prefillCode;
    if (last) resume.textContent = `回到上次的房间 ${last} →`;
  }

  function updateJoinLabel() {
    const code = $("code").value;
    $("join").textContent = CODE_RE.test(code) ? `加入 ${code}` : "加入";
  }

  async function createRoom() {
    const btn = $("create");
    btn.disabled = true;
    btn.textContent = "创建中…";
    try {
      const res = await fetch("/api/room", { method: "POST" });
      if (!res.ok) throw new Error(String(res.status));
      const { code } = await res.json();
      enterRoom(code);
    } catch {
      showHome("创建房间失败，请稍后再试");
    } finally {
      btn.disabled = false;
      btn.textContent = "创建房间";
    }
  }

  function enterRoom(code) {
    roomCode = code;
    state = null;
    pending = false;
    voting = false;
    renderedGame = 0;
    renderedRounds = 0;
    history.replaceState(null, "", `/?room=${code}`);
    show("room");
    $("room-code").textContent = code;
    for (const id of ["waiting", "play", "judge", "result"]) $(id).hidden = true;
    connect();
  }

  function leaveToHome(message, forgetRoom) {
    const code = roomCode;
    roomCode = null;
    state = null;
    clearTimeout(retryTimer);
    clearInterval(pingTimer);
    if (ws) {
      ws.onclose = ws.onmessage = ws.onopen = null;
      try { ws.close(); } catch { /* ignore */ }
      ws = null;
    }
    if (forgetRoom) store.del(K_LAST_ROOM);
    history.replaceState(null, "", "/");
    showHome(message, message ? code : "");
  }

  // ---------------- WebSocket ----------------
  function connect() {
    clearTimeout(retryTimer);
    clearInterval(pingTimer);
    if (ws) {
      ws.onclose = ws.onmessage = ws.onopen = null;
      try { ws.close(); } catch { /* ignore */ }
    }
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const sock = new WebSocket(`${proto}//${location.host}/ws/${roomCode}`);
    ws = sock;
    setConn(retry === 0 ? "connecting" : "reconnecting");

    sock.onopen = () => {
      lastSeen = Date.now();
      sock.send(JSON.stringify({ type: "join", playerId, name: myName() }));
      sock.send("ping");
      pingTimer = setInterval(() => {
        if (sock.readyState !== WebSocket.OPEN) return;
        // 太久没收到任何消息（包括 pong），认为连接已死，直接重连
        if (Date.now() - lastSeen > 60_000) { connect(); return; }
        sock.send("ping");
      }, 25_000);
    };

    sock.onmessage = (e) => {
      lastSeen = Date.now();
      if (e.data === "pong") return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      onMessage(msg);
    };

    sock.onclose = (e) => {
      if (ws !== sock) return;
      clearInterval(pingTimer);
      ws = null;
      // 4000（被别的页面顶掉）时保留“回到上次的房间”入口
      if (e.code in FATAL_CLOSE) { leaveToHome(FATAL_CLOSE[e.code], e.code !== 4000); return; }
      if (!roomCode) return;
      setConn("reconnecting");
      const delay = Math.min(10_000, 500 * 2 ** retry);
      retry += 1;
      retryTimer = setTimeout(connect, delay);
    };
  }

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
      return true;
    }
    toast("还没连上服务器，稍等一下", "error");
    return false;
  }

  function setConn(status) {
    const c = $("conn");
    c.hidden = status === "ok";
    c.textContent = status === "connecting" ? "连接中…" : "连接断开，正在重连…";
  }

  function onMessage(msg) {
    switch (msg.type) {
      case "state": {
        retry = 0;
        setConn("ok");
        store.set(K_LAST_ROOM, msg.room);
        const prev = state;
        state = msg;
        announce(prev, msg);
        render();
        break;
      }
      case "opponent_submitted":
        toast("对方写好了 ✓");
        buzz(30);
        break;
      case "reveal":
        // 后提交的一方不会收到“已提交”的 state，直接揭晓，所以在这里收尾
        pending = false;
        voting = false;
        $("word").value = "";
        if (!msg.match) {
          judgeFresh = true;
          buzz(25);
        }
        break;
      case "win":
        resultFresh = true;
        celebrate();
        break;
      case "error":
        onError(msg);
        break;
    }
  }

  /** 根据前后两次快照的差别给出提示 */
  function announce(prev, s) {
    if (!prev || prev.gameNo !== s.gameNo) return;
    if (prev.phase === "reveal" && s.phase === "reveal" && !prev.opponentVoted && s.opponentVoted) {
      toast("对方选好了 ✓");
      buzz(30);
    }
    if (prev.phase === "reveal" && s.phase === "input") {
      const last = s.history.at(-1);
      let text = "没对上，下一轮！";
      if (last?.myVote && !last.theirVote) text = "对方觉得不一样，下一轮！";
      else if (!last?.myVote && last?.theirVote) text = "对方其实觉得一样！下一轮再来";
      toast(text);
    }
  }

  function onError(msg) {
    if (FATAL_ERRORS.has(msg.code)) return; // 紧接着会收到关闭码，由 leaveToHome 统一提示
    pending = false;
    voting = false;
    if (WORD_ERRORS.has(msg.code)) shake($("word"));
    toast(msg.message, "error");
    if (state) render();
  }

  // ---------------- 渲染 ----------------
  function render() {
    const s = state;
    if (!s) return;
    show("room");
    const me = s.players.find((p) => p.you);
    const opp = s.players.find((p) => !p.you);

    // 后操作的一方会直接跳到下一阶段，收不到“已确认”的快照，所以离开阶段时把等待标记清掉
    if (s.phase !== "input") pending = false;
    if (s.phase !== "reveal") voting = false;

    $("room-code").textContent = s.room;
    $("game-no").textContent = `第 ${s.gameNo} 局`;
    renderBigCode(s.room);

    let mine = "在线";
    let theirs = "在线";
    if (s.phase === "input") {
      mine = s.mySubmission != null ? "写好了 ✓" : "思考中…";
      theirs = s.opponentSubmitted ? "写好了 ✓" : "思考中…";
    } else if (s.phase === "reveal") {
      mine = s.myVote !== null ? "选好了 ✓" : "在看结果";
      theirs = s.opponentVoted ? "选好了 ✓" : "在看结果";
    } else if (s.phase === "over") {
      mine = s.rematch.me ? "准备好了 ✓" : "在线";
      theirs = s.rematch.opponent ? "想再来一局 ✓" : "在线";
    }
    if (opp && !opp.online) theirs = "离线";
    renderPlayer("me", me, mine, true);
    renderPlayer("opp", opp, opp ? theirs : "", !!opp?.online);

    $("waiting").hidden = s.phase !== "waiting";
    $("play").hidden = s.phase !== "input";
    $("judge").hidden = s.phase !== "reveal";
    $("result").hidden = s.phase !== "over";

    // 入场动画只在刚揭晓/刚赢时播放；同一阶段里再次渲染不打断，离开阶段时清掉
    if (s.phase === "input") renderPlay(s, opp);
    if (s.phase !== "reveal") replay($("judge"), false);
    else if (judgeFresh) replay($("judge"), true);
    if (s.phase === "reveal") renderJudge(s, me, opp);
    judgeFresh = false;
    if (s.phase !== "over") replay($("result"), false);
    else if (resultFresh) replay($("result"), true);
    if (s.phase === "over") renderResult(s, me, opp);
    resultFresh = false;

    renderHistory(s);
    renderUsed(s);
  }

  function renderBigCode(code) {
    const box = $("big-code");
    if (box.dataset.code === code) return;
    box.dataset.code = code;
    box.setAttribute("aria-label", `房间码 ${code}`);
    box.replaceChildren(...[...code].map((c) => h("span", "", c)));
  }

  function renderPlayer(prefix, p, status, online) {
    $(`${prefix}-name`).textContent = p ? p.name : "等待加入…";
    $(`${prefix}-avatar`).textContent = initial(p?.name);
    const st = $(`${prefix}-status`);
    st.textContent = status;
    st.classList.toggle("done", status.includes("✓"));
    $(prefix).classList.toggle("offline", !online || !p);
  }

  function renderPlay(s, opp) {
    $("round").textContent = String(s.round);
    const last = s.history.at(-1);
    $("prompt-text").textContent = last ? "写一个词，把这两个连起来" : "第一轮，随便写一个词";
    $("prompt-chips").hidden = !last;
    if (last) {
      $("chip-a").textContent = last.mine;
      $("chip-b").textContent = last.theirs;
    }

    // 上一轮有人觉得意思一样（但没有两人都觉得），提一句
    const note = $("last-votes");
    note.hidden = !(last && (last.myVote || last.theirVote));
    if (last?.myVote) note.textContent = "上一轮你觉得这俩意思一样，对方不这么想";
    else if (last?.theirVote) note.textContent = "上一轮对方觉得这俩意思一样，你不这么想";

    const submitted = s.mySubmission != null;
    $("submit-form").hidden = submitted;
    $("submitted").hidden = !submitted;
    if (submitted) {
      pending = false;
      $("word").value = "";
      $("my-word").textContent = s.mySubmission;
      $("wait-text").textContent = opp && !opp.online ? "对方离线了，等 TA 回来" : "等对方写完";
    }
    $("submit-btn").disabled = pending;
  }

  function renderJudge(s, me, opp) {
    const last = s.history.at(-1);
    if (!last) return;
    $("judge-round").textContent = String(last.round);
    fitWord($("jb-mine"), last.mine, [40, 32, 24, 18]);
    fitWord($("jb-theirs"), last.theirs, [40, 32, 24, 18]);
    $("jb-me-av").textContent = initial(me?.name);
    $("jb-opp-av").textContent = initial(opp?.name);
    $("jb-opp-name").textContent = opp?.name || "对方";

    const voted = s.myVote !== null;
    if (voted) voting = false;
    $("vote-buttons").hidden = voted;
    $("vote-same").disabled = voting;
    $("vote-next").disabled = voting;

    let status;
    if (voted) status = `你选了「${s.myVote ? "一样" : "下一轮"}」，等对方选…`;
    else if (s.opponentVoted) status = "对方已经选好了，就等你了";
    else status = "两人都选「一样」也算相遇；选好之前对方看不到你的选择";
    if (opp && !opp.online) status += "（对方离线了）";
    $("vote-status").textContent = status;
  }

  function renderResult(s, me, opp) {
    const r = s.result;
    if (!r) return;
    const sameWord = r.by === "same_word";
    const title = $("result-title");
    title.textContent = sameWord ? "同词!" : "心有灵犀!";
    title.setAttribute("font-size", sameWord ? "50" : "40");

    $("merged").hidden = !sameWord;
    $("merged-avs").hidden = !sameWord;
    $("meaning").hidden = sameWord;
    if (sameWord) {
      fitWord($("merged-word"), r.mine, [52, 44, 30, 22]);
      $("r-me-av").textContent = initial(me?.name);
      $("r-opp-av").textContent = initial(opp?.name);
    } else {
      $("mw-mine").textContent = r.mine;
      $("mw-theirs").textContent = r.theirs;
    }
    $("result-line").textContent = sameWord
      ? `第 ${r.rounds} 轮，你们说了同一个词`
      : `第 ${r.rounds} 轮，你们都觉得是一个意思`;

    const btn = $("rematch");
    btn.disabled = s.rematch.me;
    btn.textContent = s.rematch.me ? "等对方确认…" : "再来一局";
    let hint = "";
    if (s.rematch.opponent && !s.rematch.me) hint = "对方想再来一局！";
    else if (opp && !opp.online) hint = "对方离线了";
    $("rematch-hint").textContent = hint;

    const past = s.pastGames;
    $("past-games").hidden = past.length < 2;
    const list = $("past-list");
    list.replaceChildren();
    for (const g of [...past].reverse()) {
      const li = h("li");
      const desc = g.by === "same_word" ? `同词「${g.words[0] ?? ""}」` : `意思一样「${g.words.join("」≈「")}」`;
      li.append(h("span", "", `第 ${g.gameNo} 局`), h("b", "", `${g.rounds} 轮`), h("span", "", desc));
      list.append(li);
    }
  }

  function renderHistory(s) {
    if (renderedGame !== s.gameNo) {
      renderedGame = s.gameNo;
      renderedRounds = s.history.length; // 重连或新局时不播放动画
    }
    const isNew = s.history.length > renderedRounds;
    renderedRounds = s.history.length;

    const list = $("history");
    list.replaceChildren();
    const meaningRound = s.result?.by === "same_meaning" ? s.result.rounds : -1;
    s.history.forEach((r, i) => {
      const li = h("li", "cell");
      if (norm(r.mine) === norm(r.theirs) || r.round === meaningRound) li.classList.add("win");
      if (isNew && i === s.history.length - 1) li.classList.add("new");
      li.append(h("span", "rn", `#${r.round}`), h("div", "m", r.mine), h("div", "t", r.theirs));
      let vt = "";
      if (r.myVote && r.theirVote) vt = "都觉得一样";
      else if (r.myVote) vt = "你觉得一样";
      else if (r.theirVote) vt = "对方觉得一样";
      if (vt) li.append(h("div", "vt", vt));
      list.append(li);
    });
    $("history-empty").hidden = s.history.length > 0;
  }

  function renderUsed(s) {
    $("used-box").hidden = s.used.length === 0;
    $("used-count").textContent = String(s.used.length);
    $("used").replaceChildren(...s.used.map((w) => h("span", "", w)));
  }

  // ---------------- 胜利：两股波普碎片从左右下角喷出、在中间相遇 ----------------
  function celebrate() {
    buzz([40, 60, 40, 60, 160]);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const canvas = $("confetti");
    const ctx = canvas.getContext("2d");
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = window.innerWidth;
    const H = window.innerHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.hidden = false;

    const css = getComputedStyle(document.documentElement);
    const c = (v) => css.getPropertyValue(v).trim();
    const ink = c("--ink");
    const left = [c("--red"), c("--yellow"), "#ffffff"];
    const right = [c("--blue"), c("--yellow"), "#ffffff"];
    const parts = Array.from({ length: 120 }, (_, i) => {
      const fromLeft = i % 2 === 0;
      const angle = (fromLeft ? -60 : -120) + (Math.random() - 0.5) * 36;
      const speed = 11 + Math.random() * 9;
      const rad = (angle * Math.PI) / 180;
      return {
        x: fromLeft ? -10 : W + 10,
        y: H * 0.85,
        vx: Math.cos(rad) * speed * (W / 420) ** 0.5,
        vy: Math.sin(rad) * speed,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.25,
        size: 8 + Math.random() * 9,
        shape: i % 3, // 0 圆点 1 方块 2 三角
        color: (fromLeft ? left : right)[Math.floor(Math.random() * 3)],
      };
    });

    const DURATION = 3200;
    const start = performance.now();
    const frame = (t) => {
      const elapsed = t - start;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.globalAlpha = Math.max(0, 1 - Math.max(0, elapsed - DURATION * 0.65) / (DURATION * 0.35));
      ctx.lineWidth = 2;
      ctx.strokeStyle = ink;
      for (const p of parts) {
        p.vy += 0.32;
        p.vx *= 0.985;
        p.vy *= 0.985;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        const s = p.size / 2;
        if (p.shape === 0) ctx.arc(0, 0, s, 0, Math.PI * 2);
        else if (p.shape === 1) ctx.rect(-s, -s, p.size, p.size);
        else { ctx.moveTo(0, -s); ctx.lineTo(s, s); ctx.lineTo(-s, s); ctx.closePath(); }
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
      if (elapsed < DURATION) requestAnimationFrame(frame);
      else canvas.hidden = true;
    };
    requestAnimationFrame(frame);
  }

  // ---------------- 导出本局用词图片（Canvas 手绘，不依赖第三方库） ----------------
  // 图片固定用浅色波普配色，和当前是不是深色模式无关
  const CARD = {
    W: 1080,
    pad: 64,
    page: "#fff4dc",
    dots: "#f7b6c6",
    paper: "#ffffff",
    ink: "#141414",
    muted: "#6c6156",
    red: "#f0373c",
    redInk: "#c21f25",
    blue: "#2257e0",
    blueInk: "#1a45b8",
    yellow: "#ffd93b",
    tape: "rgba(255, 217, 59, 0.85)",
  };
  const F_DISPLAY = '"QingKe", "KuaiLe", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
  const F_HAND = '"KuaiLe", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
  const F_COMIC = '"Bangers", Impact, "Arial Black", sans-serif';
  // 玩家写的词和昵称用系统字体（子集字体里没有这些字）
  const F_TEXT = 'system-ui, -apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", sans-serif';
  const textFont = (size) => `800 ${size}px ${F_TEXT}`;
  const noteFont = (size) => `600 ${size}px ${F_TEXT}`;

  let exportBlob = null;
  let exportName = "";

  /** 等界面字体就绪，最多等 2 秒；没加载出来就用系统字体画 */
  function loadFonts() {
    const all = Promise.all(["60px QingKe", "30px KuaiLe", "30px Bangers"].map((f) => document.fonts.load(f)));
    return Promise.race([all, new Promise((r) => setTimeout(r, 2000))]).catch(() => {});
  }

  /** 按字折行，中英文都适用 */
  function wrapText(ctx, text, maxW) {
    const lines = [];
    let line = "";
    for (const ch of text) {
      if (line && ctx.measureText(line + ch).width > maxW) {
        lines.push(line);
        line = ch === " " ? "" : ch;
      } else {
        line += ch;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  /** 找能在 maxLines 行内放下的最大字号；实在放不下就截断加省略号 */
  function fitText(ctx, text, maxW, maxLines, sizes, font) {
    for (const size of sizes) {
      ctx.font = font(size);
      const lines = wrapText(ctx, text, maxW);
      if (lines.length <= maxLines) return { size, lines };
    }
    const size = sizes[sizes.length - 1];
    ctx.font = font(size);
    const lines = wrapText(ctx, text, maxW).slice(0, maxLines);
    let last = lines[maxLines - 1];
    while (last && ctx.measureText(`${last}…`).width > maxW) last = [...last].slice(0, -1).join("");
    lines[maxLines - 1] = `${last}…`;
    return { size, lines };
  }

  function textWidth(ctx, text, font) {
    ctx.font = font;
    return ctx.measureText(text).width;
  }

  function linesWidth(ctx, fit, font) {
    return Math.max(...fit.lines.map((l) => textWidth(ctx, l, font(fit.size))));
  }

  /** 在以 (cx, cy) 为中心、旋转 deg 度的坐标系里画 */
  function rotated(ctx, cx, cy, deg, draw) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((deg * Math.PI) / 180);
    draw();
    ctx.restore();
  }

  /** 波普纸片：实心错位阴影 + 粗黑边；content 在纸片中心坐标系里画 */
  function paperBox(ctx, cx, cy, w, h, deg, fill, { border = 5, shadow = 8, tape = false, content } = {}) {
    rotated(ctx, cx, cy, deg, () => {
      if (shadow) {
        ctx.fillStyle = CARD.ink;
        ctx.fillRect(-w / 2 + shadow, -h / 2 + shadow, w, h);
      }
      ctx.fillStyle = fill;
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.lineWidth = border;
      ctx.strokeStyle = CARD.ink;
      ctx.strokeRect(-w / 2, -h / 2, w, h);
      if (tape) {
        rotated(ctx, 0, -h / 2, -7, () => {
          ctx.fillStyle = CARD.tape;
          ctx.fillRect(-52, -14, 104, 28);
        });
      }
      content?.();
    });
  }

  function centerText(ctx, text, x, y, font, color, stroke) {
    ctx.font = font;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if (stroke) {
      ctx.lineJoin = "round";
      ctx.lineWidth = stroke;
      ctx.strokeStyle = CARD.ink;
      ctx.strokeText(text, x, y);
    }
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  /** 多行文字整体居中在 (cx, cy) */
  function centerLines(ctx, fit, cx, cy, color, font = textFont) {
    const lh = fit.size * 1.2;
    let y = cy - (lh * (fit.lines.length - 1)) / 2;
    for (const line of fit.lines) {
      centerText(ctx, line, cx, y, font(fit.size), color);
      y += lh;
    }
  }

  function polygon(ctx, pts) {
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
  }

  function avatarDot(ctx, x, y, r, fill, name) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = 5;
    ctx.strokeStyle = CARD.ink;
    ctx.stroke();
    centerText(ctx, initial(name), x, y + 2, textFont(Math.round(r * 0.95)), "#ffffff");
  }

  /** 名字小纸条：左边一个颜色圆点 + 昵称；返回宽度 */
  function namePill(ctx, name, color) {
    const fit = fitText(ctx, name, 280, 1, [30, 26, 22], textFont);
    const w = textWidth(ctx, fit.lines[0], textFont(fit.size)) + 84;
    return {
      w,
      draw(cx, cy) {
        paperBox(ctx, cx, cy, w, 54, 0, CARD.paper, {
          border: 4,
          shadow: 0,
          content: () => {
            ctx.beginPath();
            ctx.arc(-w / 2 + 30, 0, 12, 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.fill();
            ctx.lineWidth = 3;
            ctx.strokeStyle = CARD.ink;
            ctx.stroke();
            centerText(ctx, fit.lines[0], 22, 2, textFont(fit.size), CARD.ink);
          },
        });
      },
    };
  }

  function formatDate(d) {
    return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
  }

  /** 画一张本局的分享长图：标题、结果、最后的词、每一轮的用词 */
  function drawCard(s, me, opp) {
    const { W, pad: P } = CARD;
    const r = s.result;
    const sameWord = r.by === "same_word";
    const meName = me?.name || "我";
    const oppName = opp?.name || "对方";
    const m = document.createElement("canvas").getContext("2d"); // 只用来量尺寸

    // ---- 第一遍：排版，算出总高度 ----
    const subText = `第 ${s.gameNo} 局 · 房间 ${s.room} · ${formatDate(new Date())}`;
    const lineText = sameWord ? `第 ${r.rounds} 轮，你们说了同一个词` : `第 ${r.rounds} 轮，你们都觉得是一个意思`;

    let big = null;
    let clipA = null;
    let clipB = null;
    let clipH = 0;
    let wordBlockH;
    if (sameWord) {
      big = fitText(m, r.mine, 500, 2, [128, 104, 84, 66, 52], textFont);
      wordBlockH = 610;
    } else {
      clipA = fitText(m, r.mine, 320, 2, [76, 62, 50, 40, 32], textFont);
      clipB = fitText(m, r.theirs, 320, 2, [76, 62, 50, 40, 32], textFont);
      clipH = Math.max(clipA.lines.length * clipA.size, clipB.lines.length * clipB.size) * 1.2 + 48;
      wordBlockH = 40 + clipH + 170;
    }

    const cols = 2;
    const gap = 28;
    const cellW = (W - P * 2 - gap) / cols;
    const inner = cellW - 48;
    const meaningRound = sameWord ? -1 : r.rounds;
    const cells = s.history.map((h) => {
      const mine = fitText(m, h.mine, inner, 3, [40, 34, 28], textFont);
      const theirs = fitText(m, h.theirs, inner, 3, [40, 34, 28], textFont);
      let voteText = "";
      if (h.myVote && h.theirVote) voteText = "都觉得一样";
      else if (h.myVote) voteText = `${meName} 觉得一样`;
      else if (h.theirVote) voteText = `${oppName} 觉得一样`;
      const vote = voteText ? fitText(m, voteText, inner, 1, [26, 22], noteFont) : null;
      const win = norm(h.mine) === norm(h.theirs) || h.round === meaningRound;
      const height = 24 + 40 + 12 + (mine.lines.length * mine.size + theirs.lines.length * theirs.size) * 1.2 + 6 + (vote ? 46 : 0) + 24;
      return { round: h.round, mine, theirs, vote, win, height };
    });
    const rowH = [];
    for (let i = 0; i < cells.length; i += cols) rowH.push(Math.max(...cells.slice(i, i + cols).map((c) => c.height)));
    const gridH = rowH.reduce((a, b) => a + b, 0) + Math.max(0, rowH.length - 1) * gap;

    const yTitle = 70;
    const ySub = yTitle + 128 + 48;
    const yBurst = ySub + 60 + 28;
    const yWord = yBurst + 350;
    const yLine = yWord + wordBlockH;
    const yLabel = yLine + 96 + 70;
    const yGrid = yLabel + 70 + 44;
    const yFoot = yGrid + gridH + 80;
    const H = Math.ceil(yFoot + 60 + 70);

    // ---- 第二遍：画 ----
    const scale = Math.min(1, Math.sqrt(16_000_000 / (W * H))); // iOS Safari 对画布面积有上限
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(W * scale);
    canvas.height = Math.round(H * scale);
    const ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);

    // 背景网点
    ctx.fillStyle = CARD.page;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = CARD.dots;
    ctx.beginPath();
    for (let y = 0, row = 0; y < H + 24; y += 24, row++) {
      for (let x = row % 2 ? 12 : 0; x < W + 24; x += 24) {
        ctx.moveTo(x + 4.5, y);
        ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      }
    }
    ctx.fill();

    // 勒索信标题
    const tiles = [
      { ch: "同", fill: CARD.yellow, color: CARD.ink, font: F_DISPLAY, deg: -6, dy: 0 },
      { ch: "词", fill: CARD.paper, color: CARD.ink, font: F_HAND, deg: 4, dy: 8 },
      { ch: "相", fill: CARD.red, color: "#ffffff", font: F_DISPLAY, deg: -3, dy: -4 },
      { ch: "遇", fill: CARD.blue, color: "#ffffff", font: F_DISPLAY, deg: 6, dy: 0 },
    ];
    const T = 128;
    const TG = 14;
    const tx0 = (W - (T * 4 + TG * 3)) / 2;
    tiles.forEach((t, i) => {
      paperBox(ctx, tx0 + i * (T + TG) + T / 2, yTitle + T / 2 + t.dy, T, T, t.deg, t.fill, {
        border: 6,
        shadow: 7,
        content: () => centerText(ctx, t.ch, 0, 4, `88px ${t.font}`, t.color),
      });
    });

    // 局号 · 房间 · 日期
    const subFont = `30px ${F_HAND}`;
    paperBox(ctx, W / 2, ySub + 30, textWidth(ctx, subText, subFont) + 60, 60, 1.5, CARD.paper, {
      border: 4,
      shadow: 0,
      tape: true,
      content: () => centerText(ctx, subText, 0, 2, subFont, CARD.ink),
    });

    // 爆炸框
    const bcx = W / 2;
    const bcy = yBurst + 160;
    polygon(ctx, burstPoints(bcx + 12, bcy + 12, 410, 280, 16, 0.4));
    ctx.fillStyle = CARD.ink;
    ctx.fill();
    polygon(ctx, burstPoints(bcx, bcy, 410, 280, 16, 0.4));
    ctx.fillStyle = CARD.yellow;
    ctx.fill();
    ctx.lineJoin = "round";
    ctx.lineWidth = 7;
    ctx.strokeStyle = CARD.ink;
    ctx.stroke();
    centerText(ctx, sameWord ? "同词!" : "心有灵犀!", bcx, bcy + 10, `${sameWord ? 150 : 116}px ${F_DISPLAY}`, CARD.red, 14);

    if (sameWord) {
      // 一个对话气泡长出两条尾巴，分别指向两个人（和结束页一样，按 SVG 的坐标放大）
      const k = 2.9;
      const cx = W / 2;
      const cy = yWord + 160;
      const at = ([x, y]) => [cx + (x - 130) * k, cy + (y - 62) * k];
      ctx.lineJoin = "round";
      ctx.lineWidth = 8;
      ctx.strokeStyle = CARD.ink;
      ctx.fillStyle = CARD.paper;
      ctx.beginPath();
      ctx.ellipse(cx, cy, 112 * k, 52 * k, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      for (const tail of [[[72, 98], [40, 144], [104, 108]], [[156, 108], [220, 144], [188, 98]]]) {
        polygon(ctx, tail.map(at));
        ctx.fill();
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.ellipse(cx, cy, 112 * k - 7, 52 * k - 7, 0, 0, Math.PI * 2);
      ctx.fill();
      centerLines(ctx, big, cx, cy + 4, CARD.ink);

      const [lx, ty] = at([40, 144]);
      const [rx] = at([220, 144]);
      avatarDot(ctx, lx, ty + 46, 42, CARD.red, meName);
      avatarDot(ctx, rx, ty + 46, 42, CARD.blue, oppName);
      namePill(ctx, meName, CARD.red).draw(lx, ty + 140);
      namePill(ctx, oppName, CARD.blue).draw(rx, ty + 140);
    } else {
      // 两张剪报 ≈
      const cy = yWord + 40 + clipH / 2;
      const ax = W / 2 - 240;
      const bx = W / 2 + 240;
      paperBox(ctx, ax, cy, linesWidth(ctx, clipA, textFont) + 64, clipH, -4, CARD.red, {
        tape: true,
        content: () => centerLines(ctx, clipA, 0, 3, "#ffffff"),
      });
      paperBox(ctx, bx, cy, linesWidth(ctx, clipB, textFont) + 64, clipH, 4, CARD.blue, {
        tape: true,
        content: () => centerLines(ctx, clipB, 0, 3, "#ffffff"),
      });
      centerText(ctx, "≈", W / 2, cy, `130px ${F_COMIC}`, CARD.yellow, 12);
      namePill(ctx, meName, CARD.red).draw(ax, cy + clipH / 2 + 80);
      namePill(ctx, oppName, CARD.blue).draw(bx, cy + clipH / 2 + 80);
    }

    // 黄色旁白框
    const lineFont = `42px ${F_HAND}`;
    paperBox(ctx, W / 2, yLine + 48, textWidth(ctx, lineText, lineFont) + 80, 96, -1, CARD.yellow, {
      content: () => centerText(ctx, lineText, 0, 3, lineFont, CARD.ink),
    });

    // 「本局用词」标签 + 右侧图例
    const labelFont = `40px ${F_DISPLAY}`;
    const lw = textWidth(ctx, "本局用词", labelFont) + 56;
    paperBox(ctx, P + lw / 2, yLabel + 35, lw, 70, -2, CARD.paper, {
      shadow: 6,
      tape: true,
      content: () => centerText(ctx, "本局用词", 0, 3, labelFont, CARD.ink),
    });
    const pillB = namePill(ctx, oppName, CARD.blue);
    const pillA = namePill(ctx, meName, CARD.red);
    pillB.draw(W - P - pillB.w / 2, yLabel + 35);
    pillA.draw(W - P - pillB.w - 16 - pillA.w / 2, yLabel + 35);

    // 每一轮一格，像漫画分镜
    let y = yGrid;
    rowH.forEach((rh, row) => {
      for (let col = 0; col < cols; col++) {
        const index = row * cols + col;
        const c = cells[index];
        if (!c) continue;
        const x = P + col * (cellW + gap);
        paperBox(ctx, x + cellW / 2, y + rh / 2, cellW, rh, index % 2 ? 1 : -1, c.win ? CARD.yellow : CARD.paper, {
          border: 6,
          shadow: 7,
          content: () => {
            const left = -cellW / 2 + 24;
            let ty = -rh / 2 + 24;
            ctx.textAlign = "left";
            ctx.textBaseline = "top";
            ctx.font = `40px ${F_COMIC}`;
            ctx.fillStyle = CARD.ink;
            ctx.fillText(`#${c.round}`, left, ty);
            ty += 40 + 12;
            for (const [fit, color] of [[c.mine, c.win ? CARD.ink : CARD.redInk], [c.theirs, c.win ? CARD.ink : CARD.blueInk]]) {
              ctx.font = textFont(fit.size);
              ctx.fillStyle = color;
              for (const line of fit.lines) {
                ctx.fillText(line, left, ty);
                ty += fit.size * 1.2;
              }
              ty += 6;
            }
            if (c.vote) {
              ctx.font = noteFont(c.vote.size);
              ctx.fillStyle = CARD.muted;
              ctx.fillText(c.vote.lines[0], left, ty + 8);
            }
          },
        });
      }
      y += rh + gap;
    });

    // 页脚：网址
    const footText = `同词相遇 · ${location.host}`;
    const footFont = `30px ${F_HAND}`;
    paperBox(ctx, W / 2, yFoot + 30, textWidth(ctx, footText, footFont) + 60, 60, -1, CARD.paper, {
      border: 4,
      shadow: 0,
      content: () => centerText(ctx, footText, 0, 2, footFont, CARD.ink),
    });

    return canvas;
  }

  async function exportImage() {
    const s = state;
    if (!s || s.phase !== "over" || !s.result) return;
    const btn = $("export-btn");
    btn.disabled = true;
    btn.textContent = "生成中…";
    try {
      await loadFonts();
      const canvas = drawCard(s, s.players.find((p) => p.you), s.players.find((p) => !p.you));
      exportBlob = await new Promise((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png"));
      exportName = `same-word-${s.room}-game${s.gameNo}.png`;
      // 预览用 data URL：微信等内置浏览器里长按 data URL 图片才能保存
      $("export-img").src = canvas.toDataURL("image/png");
      $("export-view").hidden = false;
    } catch {
      toast("生成图片失败，请再试一次", "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "导出本局用词图片";
    }
  }

  /** 手机：系统分享（可以存相册、发微信）；电脑：直接下载 */
  async function saveExport() {
    if (!exportBlob) return;
    const touch = matchMedia("(pointer: coarse)").matches;
    if (touch && navigator.canShare) {
      const file = new File([exportBlob], exportName, { type: "image/png" });
      if (navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: "同词相遇" });
          return;
        } catch (e) {
          if (e?.name === "AbortError") return;
        }
      }
    }
    const url = URL.createObjectURL(exportBlob);
    const a = h("a");
    a.href = url;
    a.download = exportName;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    toast("已开始下载，也可以长按图片保存");
  }

  function closeExport() {
    $("export-view").hidden = true;
  }

  // ---------------- 分享 ----------------
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* 非安全上下文时退回老办法 */ }
    const ta = h("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;opacity:0;top:0;left:0";
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { /* ignore */ }
    ta.remove();
    return ok;
  }

  async function share() {
    const code = state?.room || roomCode;
    if (!code) return;
    const url = `${location.origin}/?room=${code}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: "同词相遇", text: `来和我玩「同词相遇」，房间码 ${code}`, url });
        return;
      } catch (e) {
        if (e && e.name === "AbortError") return;
      }
    }
    toast((await copyText(url)) ? "邀请链接已复制，发给朋友吧" : `房间码：${code}`);
  }

  // ---------------- 事件绑定 ----------------
  $("name").value = store.get(K_NAME) || "";
  $("name").addEventListener("input", () => store.set(K_NAME, $("name").value.trim()));

  $("create").addEventListener("click", createRoom);

  $("code").addEventListener("input", () => {
    const input = $("code");
    input.value = input.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
    updateJoinLabel();
  });

  $("join-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const code = $("code").value.toUpperCase();
    if (!CODE_RE.test(code)) {
      shake($("code"));
      toast("房间码是 4 个字母", "error");
      return;
    }
    enterRoom(code);
  });

  $("resume").addEventListener("click", () => {
    const last = store.get(K_LAST_ROOM);
    if (last) enterRoom(last);
  });

  $("submit-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!state || pending) return;
    const input = $("word");
    const word = cleanText(input.value);
    if (!word) { shake(input); toast("先写一个词", "error"); return; }
    if ([...word].length > MAX_WORD_LEN) { shake(input); toast(`最多 ${MAX_WORD_LEN} 个字`, "error"); return; }
    if (state.used.some((u) => norm(u) === norm(word))) {
      shake(input);
      toast(`「${word}」已经有人用过了，换一个吧`, "error");
      return;
    }
    if (send({ type: "submit", word })) {
      pending = true;
      $("submit-btn").disabled = true;
      input.blur();
    }
  });

  function vote(same) {
    if (!state || state.phase !== "reveal" || voting) return;
    if (send({ type: "same_vote", round: state.round, same })) {
      voting = true;
      $("vote-same").disabled = true;
      $("vote-next").disabled = true;
    }
  }
  $("vote-same").addEventListener("click", () => vote(true));
  $("vote-next").addEventListener("click", () => vote(false));

  $("rematch").addEventListener("click", () => {
    if (send({ type: "rematch" })) $("rematch").disabled = true;
  });

  $("share").addEventListener("click", share);
  $("share2").addEventListener("click", share);

  for (const btn of document.querySelectorAll(".theme-btn")) btn.addEventListener("click", cycleTheme);

  $("export-btn").addEventListener("click", exportImage);
  $("export-save").addEventListener("click", saveExport);
  $("export-close").addEventListener("click", closeExport);
  $("export-view").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeExport();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("export-view").hidden) closeExport();
  });

  $("leave").addEventListener("click", () => {
    if (!confirm("确定离开房间吗？\n离开后位置会让给别人，当前这局作废。")) return;
    if (!(ws && ws.readyState === WebSocket.OPEN && send({ type: "leave" }))) leaveToHome("", true);
    // 服务端会用 4003 关闭连接，onclose 里回到首页
  });

  // 手机切回前台 / 网络恢复时立即重连
  const reconnectIfNeeded = () => {
    if (!roomCode) return;
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      retry = 0;
      connect();
    } else if (ws.readyState === WebSocket.OPEN) {
      ws.send("ping");
    }
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") reconnectIfNeeded();
  });
  window.addEventListener("online", reconnectIfNeeded);

  // ---------------- 启动 ----------------
  applyTheme(currentTheme());
  drawBursts();
  const fromUrl = (new URLSearchParams(location.search).get("room") || "").toUpperCase();
  if (CODE_RE.test(fromUrl)) {
    // 有昵称，或者就是刷新了自己所在的房间：直接进
    if (myName() || store.get(K_LAST_ROOM) === fromUrl) {
      enterRoom(fromUrl);
    } else {
      // 第一次通过链接进来：先填个昵称
      showHome("", fromUrl);
      $("name").focus();
    }
  } else {
    showHome("");
  }
})();
