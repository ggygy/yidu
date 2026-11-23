#!/usr/bin/env node
// 用 tauri.conf.json 里的 updater 公钥校验 latest.json 中每个平台的 minisign 签名。
// 任一失败 → exit 1。发布前跑,防止发出 App 内更新必报「signature verification failed」的版本。
//
// 用法:node app/scripts/verify-updater-sig.mjs <latest.json> <产物目录> [tauri.conf.json]
// 产物文件名取各平台 url 的最后一段。零依赖:Node 内置 crypto 支持 Ed25519 与 BLAKE2b-512。

import { createHash, createPublicKey, verify } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const [latestPath, distDir, confArg] = process.argv.slice(2);
if (!latestPath || !distDir) {
  console.error('用法: verify-updater-sig.mjs <latest.json> <产物目录> [tauri.conf.json]');
  process.exit(2);
}
const confPath =
  confArg ?? join(dirname(fileURLToPath(import.meta.url)), '../src-tauri/tauri.conf.json');

const b64 = (s) => Buffer.from(s.trim(), 'base64');
const keyIdHex = (buf) => Buffer.from(buf).reverse().toString('hex').toUpperCase();

// 公钥:base64(「untrusted comment\n」+ base64(alg[2] keyid[8] pk[32]))
const pubLines = b64(JSON.parse(readFileSync(confPath, 'utf8')).plugins.updater.pubkey)
  .toString('utf8')
  .split('\n');
const pubRaw = b64(pubLines[1]);
if (pubRaw.length !== 42) throw new Error(`公钥长度异常: ${pubRaw.length}`);
const pubKeyId = keyIdHex(pubRaw.subarray(2, 10));
const pubKey = createPublicKey({
  key: { kty: 'OKP', crv: 'Ed25519', x: pubRaw.subarray(10).toString('base64url') },
  format: 'jwk',
});
console.log(`updater 公钥 key ID: ${pubKeyId}`);

async function digest(file, prehashed) {
  if (!prehashed) return readFileSync(file);
  const h = createHash('blake2b512');
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest();
}

// 签名:base64(untrusted comment / base64(alg[2] keyid[8] sig[64]) / trusted comment / base64(global_sig[64]))
async function check(sigB64, file) {
  const lines = b64(sigB64).toString('utf8').split('\n');
  const raw = b64(lines[1]);
  const alg = raw.subarray(0, 2).toString('latin1');
  const keyId = keyIdHex(raw.subarray(2, 10));
  const sig = raw.subarray(10, 74);
  const trusted = lines[2].replace(/^trusted comment: /, '');
  const errors = [];
  if (keyId !== pubKeyId) errors.push(`key ID 不符(签名 ${keyId} ≠ 公钥 ${pubKeyId})`);
  if (alg !== 'ED' && alg !== 'Ed') errors.push(`未知签名算法 ${alg}`);
  const fileOk = verify(null, await digest(file, alg === 'ED'), pubKey, sig);
  if (!fileOk) errors.push('文件签名校验失败');
  const globalOk = verify(null, Buffer.concat([sig, Buffer.from(trusted, 'utf8')]), pubKey, b64(lines[3]));
  if (!globalOk) errors.push('trusted comment 签名校验失败(私钥与公钥不是一对)');
  return { errors, trusted };
}

const latest = JSON.parse(readFileSync(latestPath, 'utf8'));
let failed = 0;
for (const [platform, { signature, url }] of Object.entries(latest.platforms)) {
  const name = decodeURIComponent(url.split('/').pop());
  try {
    const { errors, trusted } = await check(signature, join(distDir, name));
    if (errors.length) {
      failed++;
      console.error(`✗ ${platform} ${name}\n    ${errors.join('\n    ')}\n    (${trusted})`);
    } else {
      console.log(`✓ ${platform} ${name}`);
    }
  } catch (e) {
    failed++;
    console.error(`✗ ${platform} ${name}: ${e.message}`);
  }
}
if (failed) {
  console.error(
    `\n${failed} 个平台签名无效。TAURI_SIGNING_PRIVATE_KEY 与 tauri.conf.json 的 updater.pubkey 不匹配?` +
      '\n本地核对:cat ~/.tauri/yidu.key.pub 应与 pubkey 一致;一致则重设 secret:' +
      '\n  gh secret set TAURI_SIGNING_PRIVATE_KEY -R ggygy/yidu < ~/.tauri/yidu.key',
  );
  process.exit(1);
}
console.log('全部平台 updater 签名有效');
