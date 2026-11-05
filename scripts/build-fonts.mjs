#!/usr/bin/env node
// 生成 public/fonts/ 下的子集字体：只保留界面上用到的字，文件很小，
// 也不依赖 Google Fonts（国内经常打不开）。
// 改了界面上的中文文字之后运行：npm run fonts
//
// 字体来自 google/fonts 仓库，均为 SIL Open Font License（许可证一并放在 public/fonts/）。
// 玩家输入的词和昵称不用这些字体，而是用系统字体，所以不需要覆盖全部汉字。

import subsetFont from "subset-font";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";

const REPO = "https://raw.githubusercontent.com/google/fonts/main/ofl";
const FONTS = [
  { out: "zcool-qingke", dir: "zcoolqingkehuangyou", file: "ZCOOLQingKeHuangYou-Regular.ttf" },
  { out: "zcool-kuaile", dir: "zcoolkuaile", file: "ZCOOLKuaiLe-Regular.ttf" },
  { out: "bangers", dir: "bangers", file: "Bangers-Regular.ttf", asciiOnly: true },
];
// 界面文字出现在这些文件里（服务端的错误提示也会显示出来）
const SOURCES = ["public/index.html", "public/app.js", "src/room.ts", "src/game.ts"];
const CACHE = ".cache/fonts";

const ASCII = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join("");

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function download(url, path) {
  if (await exists(path)) return readFile(path);
  process.stdout.write(`下载 ${url} … `);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败 ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(path, buf);
  console.log(`${(buf.length / 1024).toFixed(0)} KB`);
  return buf;
}

await mkdir(CACHE, { recursive: true });
await mkdir("public/fonts", { recursive: true });

const text = (await Promise.all(SOURCES.map((f) => readFile(f, "utf8")))).join("");
const wide = [...new Set([...text].filter((ch) => ch.codePointAt(0) > 0x7e))].join("");

for (const font of FONTS) {
  const ttf = await download(`${REPO}/${font.dir}/${font.file}`, `${CACHE}/${font.file}`);
  const license = await download(`${REPO}/${font.dir}/OFL.txt`, `${CACHE}/${font.out}-OFL.txt`);
  const chars = font.asciiOnly ? ASCII : ASCII + wide;
  const woff2 = await subsetFont(ttf, chars, { targetFormat: "woff2" });
  await writeFile(`public/fonts/${font.out}.woff2`, woff2);
  await writeFile(`public/fonts/${font.out}-OFL.txt`, license);
  console.log(`public/fonts/${font.out}.woff2  ${(woff2.length / 1024).toFixed(1)} KB`);
}
console.log(`共收录 ${[...wide].length} 个非 ASCII 字符`);
