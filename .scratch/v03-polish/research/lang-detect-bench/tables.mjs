// 若 WebView 不支持 legacy TextDecoder,可把字表预计算成静态字符串;此脚本测其大小
const han = /\p{Script=Han}/u;
const dec = (enc, ranges) => { const d = new TextDecoder(enc), s = new Set();
  for (const [h0, h1, l0, l1, skip] of ranges) for (let h = h0; h <= h1; h++) for (let l = l0; l <= l1; l++) {
    if (skip && skip(h, l)) continue; const c = d.decode(new Uint8Array([h, l])); if (c.length === 1 && han.test(c)) s.add(c); } return s; };
const GB = dec("gb2312", [[0xb0, 0xf7, 0xa1, 0xfe]]);
const B5 = dec("big5", [[0xa4, 0xf9, 0x40, 0x7e], [0xa4, 0xf9, 0xa1, 0xfe]]);
const J1 = dec("shift_jis", [[0x88, 0x98, 0x40, 0xfc, (h, l) => l === 0x7f || (h === 0x88 && l < 0x9f) || (h === 0x98 && l > 0x72)]]);
const jaOnly = [...J1].filter((c) => !GB.has(c) && !B5.has(c));
const simpJ = [...J1].filter((c) => GB.has(c) && !B5.has(c));
const tradJ = [...J1].filter((c) => !GB.has(c) && B5.has(c));
console.log("GB2312 han", GB.size, "| Big5 han", B5.size, "| JIS L1 han", J1.size);
console.log("JA_ONLY (J1∖GB∖B5)", jaOnly.length, "chars,", Buffer.byteLength(jaOnly.join("")), "bytes utf8");
console.log("SIMP_ONLY∩J1", simpJ.length, "| TRAD_ONLY∩J1", tradJ.length, "| combined bytes", Buffer.byteLength(simpJ.join("") + tradJ.join("")));
console.log("sample JA_ONLY:", jaOnly.slice(0, 60).join(""));
