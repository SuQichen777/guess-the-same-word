import { Room } from "./room";

// Durable Object 类必须从 Worker 入口导出
export { Room };

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const WS_PATH = /^\/ws\/([A-Za-z]{4})$/;

/** 4 位大写字母房间码（拒绝采样，避免取模偏差） */
function randomCode(): string {
  let code = "";
  const buf = new Uint8Array(16);
  while (code.length < 4) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < 234 && code.length < 4) code += LETTERS[b % 26];
    }
  }
  return code;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function roomStub(env: Env, code: string) {
  return env.ROOM.get(env.ROOM.idFromName(code));
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    // 创建房间：随机生成房间码，并让对应的 DO 占住它（撞码就换一个）
    if (url.pathname === "/api/room") {
      if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      for (let i = 0; i < 10; i++) {
        const code = randomCode();
        if (await roomStub(env, code).create(code)) return json({ code }, 201);
      }
      return json({ error: "no_free_code" }, 503);
    }

    // WebSocket：按房间码转发给对应的 Room DO
    const m = WS_PATH.exec(url.pathname);
    if (m) {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }
      return roomStub(env, m[1]!.toUpperCase()).fetch(request);
    }

    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws/")) {
      return json({ error: "not_found" }, 404);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
