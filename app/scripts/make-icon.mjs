// 生成 512x512 应用图标源图:深底圆角方 + 灰/强调双色横条(双语对照意象)
// 纯 node 实现(无 canvas 依赖):手写 PNG chunk + zlib
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const S = 512;
const R = 112; // 圆角半径
const px = Buffer.alloc(S * S * 4);

const inRounded = (x, y) => {
  const cx = Math.max(R, Math.min(S - R, x));
  const cy = Math.max(R, Math.min(S - R, y));
  return (x - cx) ** 2 + (y - cy) ** 2 <= R * R;
};
const bar = (x, y, y0, h, m) => x >= m && x <= S - m && y >= y0 && y <= y0 + h;

const bg = [16, 19, 34]; // #101322
const gray = [160, 165, 180]; // --t3
const accent = [76, 91, 240]; // --accent

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    if (!inRounded(x, y)) {
      px[i + 3] = 0;
      continue;
    }
    let c = bg;
    if (bar(x, y, 168, 34, 128)) c = gray; // 原文行
    if (bar(x, y, 250, 52, 128)) c = accent; // 译文行
    if (bar(x, y, 332, 34, 128) && x <= 312) c = gray; // 第二原文行(短)
    px[i] = c[0];
    px[i + 1] = c[1];
    px[i + 2] = c[2];
    px[i + 3] = 255;
  }
}

const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0; // filter none
  px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
const crcTable = [...Array(256)].map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
writeFileSync(new URL("../app-icon.png", import.meta.url), png);
console.log("app-icon.png written:", png.length, "bytes");
