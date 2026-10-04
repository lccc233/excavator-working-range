#!/usr/bin/env node
/**
 * 上线验证：逐个文件比对本地与线上的 sha256
 * ==========================================================================
 * 部署完「必须能证明线上就是本地这一份」，否则「部署成功」只是一句话。
 * 这里做三件事：
 *   ① 逐文件拉取线上内容（带查询串绕开 nginx 的 7 天缓存），与本地逐字节比对；
 *   ② 检查首页可访问、返回 200 且带正确的 charset；
 *   ③ 抽查若干「关键字」确认新特性确实在线上（防止只更新了一半）。
 *
 *   SITE=http://<域名或 IP> node tools/verify-deploy.mjs     验证线上部署
 *   SITE=http://127.0.0.1:8080 node tools/verify-deploy.mjs  验证本地服务（默认）
 *   STAMP=whatever node tools/verify-deploy.mjs              指定缓存穿透串
 *
 * 只上线 index.html + assets/**（与 deploy/package.ps1 的口径一致），
 * 所以 tests/ tools/ deploy/ docs/ 不参与比对。
 */

import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.env.SITE ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');
const STAMP = process.env.STAMP ?? `v${Date.now()}`;

/** 关键特性关键字：文件、片段、是否应当出现、说明 */
const FEATURES = [
  ['assets/core/geometry.js', 'bucketLocalShape', true, '实体外形斗形：切掉一部分的半圆'],
  ['assets/core/geometry.js', 'armHeelAlong', true, '斗杆后跟长度（斗杆轮廓与支座共用口径）'],
  ['assets/core/geometry.js', 'BUCKET_LOCAL_SHAPE', false, '旧斗形常量应已移除'],
  ['assets/ui/draw.js', 'cylinderMounts', true, '油缸端支座几何'],
  ['assets/ui/draw.js', 'data-mount', true, '油缸端支座确实画到图上'],
];

async function walk(rel) {
  const out = [];
  for (const e of await readdir(path.join(ROOT, rel), { withFileTypes: true })) {
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...(await walk(r)));
    else out.push(r);
  }
  return out;
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const files = ['index.html', ...(await walk('assets'))].sort();

let ok = 0;
let totalMs = 0;
const bad = [];
const bodies = new Map();

console.log(`比对 ${BASE} 与本地构建（穿透串 ${STAMP}）\n`);
for (const f of files) {
  const local = await readFile(path.join(ROOT, f));
  const t0 = Date.now();
  const res = await fetch(`${BASE}/${f}?${STAMP}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ms = Date.now() - t0;
  totalMs += ms;
  bodies.set(f, buf.toString('utf8'));
  const same = res.status === 200 && buf.length === local.length && sha(buf) === sha(local);
  if (same) ok++;
  else {
    bad.push(
      `${f}: HTTP ${res.status}，本地 ${local.length}B/${sha(local).slice(0, 12)} vs 线上 ${buf.length}B/${sha(buf).slice(0, 12)}`,
    );
  }
  console.log(`${same ? 'OK  ' : 'DIFF'} ${f.padEnd(30)} ${String(buf.length).padStart(7)}B  ${String(ms).padStart(4)}ms`);
}

const home = await fetch(`${BASE}/?${STAMP}`);
const html = await home.text();
const charset = home.headers.get('content-type') ?? '';
const title = /<title>[^<]+<\/title>/.exec(html)?.[0] ?? '(无 title)';

console.log(`\n文件一致：${ok}/${files.length}　总耗时 ${totalMs} ms（平均 ${(totalMs / files.length).toFixed(0)} ms）`);
console.log(`首页：HTTP ${home.status}，${html.length} 字符，content-type=${charset}，${title}`);

let featureFail = 0;
for (const [file, needle, want, why] of FEATURES) {
  const hit = (bodies.get(file) ?? '').includes(needle);
  const pass = hit === want;
  if (!pass) featureFail++;
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${why}（${file} ${want ? '含' : '不含'} ${needle}）`);
}

const problems =
  bad.length + (home.status === 200 ? 0 : 1) + (charset.includes('charset=utf-8') ? 0 : 1) + featureFail;
if (problems) {
  if (bad.length) {
    console.log('\n不一致明细：');
    for (const b of bad) console.log('  ' + b);
  }
  console.error(`\n结论：验证未通过（${problems} 处问题）`);
  process.exit(1);
}
console.log(`\n结论：线上 ${files.length} 个文件与本地构建逐字节一致，关键特性均在线上。`);
