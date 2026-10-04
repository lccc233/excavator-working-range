#!/usr/bin/env node
/**
 * 测试入口
 * ==========================================================================
 * 为什么不直接用 `node --test tests/`：
 * 本机运行在受限沙箱下，`node --test` 会为每个测试文件 spawn 一个子进程并通过
 * 管道收集输出，而沙箱禁止打开命名管道，会直接以 EPERM 失败。
 * 这里把全部测试文件 import 进同一个进程，由 node:test 的默认运行器统一执行，
 * 既绕开了子进程管道，也让 `npm test` 保持一条命令。
 *
 *   node tools/test.mjs
 */

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const testsDir = path.join(here, '..', 'tests');

const files = (await readdir(testsDir)).filter((f) => f.endsWith('.test.js')).sort();

if (!files.length) {
  console.error('未找到任何测试文件。');
  process.exit(2);
}

console.log(`运行 ${files.length} 个测试文件：${files.join(', ')}\n`);

for (const f of files) {
  await import(pathToFileURL(path.join(testsDir, f)).href);
}
