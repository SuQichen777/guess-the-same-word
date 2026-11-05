# 同词相遇

一个给朋友玩的双人在线小游戏：两个人每轮各写一个词，同时揭晓，直到写出同一个词。界面是波普拼贴风格（勒索信标题、网点、漫画对话气泡）。

技术栈：Cloudflare Workers + Durable Objects（WebSocket Hibernation）+ Workers Static Assets，TypeScript + wrangler，前端是原生 JS（无构建步骤）。全部在**免费套餐**内运行。

## 一轮是怎么走的

1. **各自写词**：两人各自偷偷写一个词，对方只能看到“写好了”。
2. **结果页**：都写好后，两人同时看到两个词。
   - 写的一样（忽略大小写、首尾空格）→ 直接赢，进入结束页。
   - 不一样 → 页面盖一个「不一样」的章，两人各自选「我觉得一样」或「不一样，下一轮」。选好之前对方看不到你选了什么，选了不能改。
3. **两人都选好后**：都选「一样」→ 也算赢（心有灵犀）；否则进入下一轮，这时双方的选择才公开（回合记录里会标出谁觉得一样）。
4. 下一轮写一个能连接上一轮两个词的词；任何一方用过的词都不能再用。

---

## 项目结构

```
guess-the-same-word/
├── wrangler.jsonc              # Worker / 静态资源 / Durable Object 配置
├── package.json                # 脚本：dev / deploy / typecheck / test:smoke
├── tsconfig.json
├── LICENSE                     # MIT（代码）
├── worker-configuration.d.ts   # `wrangler types` 生成的运行时 + Env 类型（改了 wrangler.jsonc 要重新生成）
├── src/
│   ├── index.ts                # Worker 入口：POST /api/room、GET /ws/:code、其余交给静态资源
│   ├── room.ts                 # Room Durable Object：WebSocket、游戏流程、存储、定时清理
│   ├── game.ts                 # 纯游戏逻辑：状态结构、词语归一化与校验
│   └── protocol.ts             # WebSocket 消息协议（类型定义）
├── public/                     # 静态前端（Workers Static Assets 直接返回）
│   ├── index.html
│   ├── style.css
│   ├── app.js
│   ├── favicon.svg
│   └── fonts/                  # 子集字体（npm run fonts 生成）+ 各自的 OFL 许可证
└── scripts/
    ├── smoke-test.mjs          # 端到端测试：模拟多个玩家打真实的 HTTP/WebSocket
    └── build-fonts.mjs         # 生成子集字体
```

## wrangler 配置

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "same-word",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-20",
  "assets": {
    "directory": "./public",
    "binding": "ASSETS",
    "run_worker_first": ["/api/*", "/ws/*"]   // 只有这两类路径先进 Worker
  },
  "durable_objects": {
    "bindings": [{ "name": "ROOM", "class_name": "Room" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Room"] }],  // 免费套餐必须用 SQLite 后端
  "observability": { "enabled": true }
}
```

要点：

- **`new_sqlite_classes`**：免费套餐只能用 SQLite 存储后端的 Durable Object。代码里用的是 `ctx.storage.get/put`（KV 风格 API），在 SQLite 后端上一样能用。
- **`run_worker_first`**：静态文件不经过 Worker，不占 Worker 请求额度；只有 `/api/*`、`/ws/*` 会先进 Worker。
- 部署之后**不要改** migration 的 `tag` 和 `Room` 类名。如果以后要改类名，需要新增一条 migration（比如 `renamed_classes`）。

---

## 本地开发与测试

需要 Node.js 22 或更高版本（冒烟测试用到了 Node 自带的 `WebSocket`）。

```bash
npm install
```

```bash
npm run dev
```

然后打开 http://localhost:8787 。

### 两个人一起测

玩家身份是 localStorage 里的随机 `playerId`，所以**同一个浏览器的两个标签页算同一个人**（新标签页会把旧的顶掉）。可以这样测：

- 一个普通窗口，再开一个**无痕/隐私窗口**；或者
- 用两个不同的浏览器；或者
- 用手机：让 dev server 监听局域网，手机和电脑连同一个 Wi-Fi，然后在手机上打开 `http://<电脑的局域网 IP>:8787`

```bash
npx wrangler dev --ip 0.0.0.0
```

（局域网走的是 http，有些浏览器这时会禁用系统分享和剪贴板，前端会退回成直接显示房间码。）

### 自动化测试

先开着 `npm run dev`，另开一个终端：

```bash
npm run test:smoke
```

它会模拟 A、B、C 等多个玩家，检查 24 项：创建房间、第 3 人被拒绝、只通知“对方已提交”而不泄露词、同时揭晓进入结果页、结果页上的选择对方看不到也不能改、选择分歧时进入下一轮、已用词校验（大小写/全角/空格）、写出同词获胜、两人都选“一样”获胜、再来一局、断线重连恢复、同一玩家多开时旧连接被顶掉、房间不存在、离开房间等。

**持久化测试**：验证状态确实存在 `ctx.storage`，而不只在内存里（包括结果页上一方已选、但还没公开的选择）。

```bash
node scripts/smoke-test.mjs --persist-setup
```

然后在 dev server 的终端按 Ctrl+C 停掉，再 `npm run dev` 重启，接着运行：

```bash
node scripts/smoke-test.mjs --persist-verify
```

类型检查：

```bash
npm run typecheck
```

本地的 Durable Object 数据存在 `.wrangler/state`，想清空就删掉 `.wrangler` 目录。

### 字体

界面用了三款 SIL Open Font License 字体：站酷庆科黄油体（标题、按钮）、站酷快乐体（正文）、Bangers（英文和数字）。为了不依赖 Google Fonts（国内经常打不开），也为了文件小，`public/fonts/` 里放的是**只含界面用到的字**的子集，三个加起来不到 200 KB。玩家输入的词和昵称用系统字体显示，所以不需要收录全部汉字。

**改了界面上的中文文字后**，重新生成一次字体，否则新加的字会退回系统字体：

```bash
npm run fonts
```

第一次运行会从 google/fonts 仓库下载原始字体到 `.cache/fonts/`（约 10 MB，不会被部署），之后直接用缓存。

---

## 部署

1. 注册一个 Cloudflare 账号（免费套餐就够）。
2. 登录（会打开浏览器授权）：

   ```bash
   npx wrangler login
   ```

3. 部署：

   ```bash
   npm run deploy
   ```

   第一次部署时如果还没有 `workers.dev` 子域名，wrangler 会提示你注册一个。部署成功后会打印地址，形如 `https://same-word.<你的子域名>.workers.dev`。
4. 把这个地址发给朋友：一个人点“创建房间”，再点“发送邀请链接”，链接里带着房间码（`/?room=ABCD`），朋友打开就能加入。
5. 可选：

   - 对线上跑一遍冒烟测试：

     ```bash
     node scripts/smoke-test.mjs https://same-word.<你的子域名>.workers.dev
     ```

   - 看实时日志：

     ```bash
     npx wrangler tail
     ```

   - 想换个名字：改 `wrangler.jsonc` 里的 `name`；想用自己的域名：在 Cloudflare 控制台给这个 Worker 加 Custom Domain。

### 免费套餐说明

- Durable Object 用的是 SQLite 后端，符合免费套餐要求。
- 静态资源请求免费，也不计入 Worker 请求数。
- 用了 WebSocket Hibernation：连接空闲时 DO 可以休眠而连接不断，不会一直计时长；心跳 `ping`/`pong` 由运行时自动回复，不会唤醒 DO。
- 朋友之间玩，免费额度绰绰有余（Workers 免费套餐每天 10 万次请求；DO 的请求数、时长、存储也各有每日免费额度，具体数字以 Cloudflare 官方定价页为准）。
- 房间里最后一个人断开 24 小时后，DO 会用 alarm 自动清空这个房间的存储，房间码可以被再次使用。

---

## 玩法与实现细节

- **房间码**：4 位大写字母。`POST /api/room` 随机生成后，会调用对应 DO 的 `create()` 占住这个码；撞上正在使用的房间就换一个重试。输入房间码时大小写都行。
- **提交与揭晓**：一方提交后，另一方只收到 `opponent_submitted`，下发的 `state` 也只告诉 TA“对方已提交”，绝不包含词本身。双方都交了才一起揭晓，进入结果页（`reveal` 阶段）。
- **词语比较**：Unicode NFKC 归一化（全角字母 `ＡＢＣ` 会变成 `ABC`），去掉不可见字符和首尾空格，中间的连续空白合并成一个，英文统一小写。最长 30 个字。
- **已用词**：已经揭晓过的词，任何一方都不能再用（前端先查一遍给即时提示，服务端再做最终校验）。本轮对方还没揭晓的词不算，否则就等于泄露了对方写的内容。
- **结果页的选择**：存在 `votes` 里，下发给对方的只有 `opponentVoted: true`，不含选了什么；两人都选完才写进这一轮的回合记录并公开。选择带着轮次号，跨轮的旧请求会被拒绝。两人都选“一样”算赢，轮数记为这一轮。
- **再来一局**：游戏结束后双方都点“再来一局”才开新局；房间会记录每局用了几轮。
- **断线重连**：`playerId` 存在 localStorage，重连后发 `join`，服务端发回完整快照。前端断线后指数退避重连，手机切回前台或网络恢复时会立即重连。同一个 `playerId` 有了新连接时，旧连接会被关闭（关闭码 4000）。
- **离开房间**：额外加了一个 `leave` 消息，用来空出位置（比如朋友换了个浏览器，变成了新的 playerId）。有人离开后这一局作废，回到等待状态。
- **导出本局用词图片**：结束页的按钮用 Canvas 现画一张 1080px 宽的波普风格长图（结果、最后的词、两人昵称、每一轮的用词和“谁觉得一样”），不依赖第三方库。保存时手机走系统分享（存相册、发微信），电脑直接下载；预览图用 data URL，微信等内置浏览器里可以长按保存。
- **深色/浅色**：默认跟随系统；首页右上角和房间顶部的小按钮可以在「跟随系统 → 浅色 → 深色」之间切换，选择存在 localStorage（`sw.theme`），`<head>` 里有一小段脚本在页面渲染前就应用它，避免闪一下。
- **存储**：整个房间状态是 `ctx.storage` 里的一个 key（`state`），每次改动都会写回。DO 被唤醒或重建时，在构造函数里用 `blockConcurrencyWhile` 读回来；内存里那份只是缓存。玩家身份通过 `ws.serializeAttachment({ cid, pid })` 绑在连接上，休眠后依然能取回。

---

## 消息协议

全部是 JSON，用 `type` 字段区分。完整类型定义见 [src/protocol.ts](src/protocol.ts)。

### 客户端 → 服务端

| type | 字段 | 说明 |
| --- | --- | --- |
| `join` | `playerId`, `name?` | 加入或重连。`playerId` 为 8–64 位字母、数字、`_`、`-` |
| `submit` | `word` | 提交本轮的词 |
| `same_vote` | `round`, `same` | 结果页上的选择：`same:true` 是“我觉得一样”，`false` 是“不一样，下一轮”。只能在 `reveal` 阶段发，选了不能改。**新增**，“含义相同”功能需要 |
| `rematch` | — | 再来一局 |
| `leave` | — | 离开房间、空出位置。**新增** |

心跳：客户端每 25 秒发送纯文本 `ping`，服务端自动回复 `pong`（不是 JSON）。

### 服务端 → 客户端

| type | 字段 | 说明 |
| --- | --- | --- |
| `state` | 见下 | 按接收者视角定制的完整快照，每次有变化都会发 |
| `opponent_submitted` | `round` | 对方已提交（不含内容） |
| `reveal` | `round`, `mine`, `theirs`, `match` | 本轮揭晓 |
| `win` | `rounds`, `by`, `mine`, `theirs` | 获胜。`by` 是 `same_word`（写出同一个词）或 `same_meaning`（两人都认为意思相同） |
| `error` | `code`, `message` | 错误，`message` 可以直接展示给用户 |

`state` 示例：

```json
{
  "type": "state",
  "room": "ABCD",
  "you": "3f2a…",
  "phase": "reveal",
  "gameNo": 1,
  "round": 2,
  "players": [
    { "id": "3f2a…", "name": "小张", "online": true, "you": true },
    { "id": "9c1b…", "name": "小李", "online": true, "you": false }
  ],
  "history": [
    { "round": 1, "mine": "苹果", "theirs": "香蕉", "myVote": true, "theirVote": false },
    { "round": 2, "mine": "水果", "theirs": "黄色", "myVote": null, "theirVote": null }
  ],
  "used": ["苹果", "香蕉", "水果", "黄色"],
  "mySubmission": null,
  "opponentSubmitted": false,
  "myVote": null,
  "opponentVoted": true,
  "rematch": { "me": false, "opponent": false },
  "result": null,
  "pastGames": []
}
```

`phase` 的取值：`waiting`（等第二个人）→ `input`（各自写词）→ `reveal`（结果页，各自选）→ 回到 `input`，或者 `over`。

- `mySubmission` / `opponentSubmitted` 只在 `input` 阶段有意义；`myVote` / `opponentVoted` 只在 `reveal` 阶段有意义。
- `history` 里每轮的 `myVote` / `theirVote` 在两人都选完之前是 `null`；直接写出同一个词的那一轮也是 `null`。

错误码：`bad_message`、`not_joined`、`no_room`、`room_full`、`replaced`、`waiting_opponent`、`game_over`、`game_not_over`、`already_submitted`、`empty_word`、`word_too_long`、`used_word`、`revealing`（结果页阶段不能提交词）、`nothing_to_vote`（还没到结果页）、`already_voted`、`stale_vote`。

WebSocket 关闭码（收到时客户端不再自动重连）：`4000` 被同一玩家的新连接顶掉、`4001` 房间已满、`4003` 主动离开、`4004` 房间不存在或已过期。

## 许可证

代码使用 [MIT 许可证](LICENSE)。`public/fonts/` 里的字体（站酷庆科黄油体、站酷快乐体、Bangers）使用 SIL Open Font License 1.1，许可证文本和字体放在一起。
