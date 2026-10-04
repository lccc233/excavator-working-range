#!/usr/bin/env node
/**
 * 生成参数表（写进 docs/参数口径.md 的标记区）
 * ==========================================================================
 * 参数元数据只写在 assets/core/params.js 一处，文档里的表也就不该手抄——
 * 这里直接从 PARAM_SPEC 生成 markdown 表格，替换文档中
 *
 *     <!-- BEGIN:PARAM-TABLE -->   …   <!-- END:PARAM-TABLE -->
 *
 * 之间的内容。改了参数规范之后跑一次即可，避免文档与代码对不上。
 *
 *   node tools/gen-param-table.mjs           写入文档
 *   node tools/gen-param-table.mjs --print   只打印，不写文件
 *   node tools/gen-param-table.mjs --check   检查文档是否已同步（CI 可用；不同步则退出码 1）
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PARAM_SPEC, PARAM_GROUPS } from '../assets/core/params.js';
import { PRESETS } from '../assets/core/presets.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DOC = path.join(path.resolve(here, '..'), 'docs', '参数口径.md');
const BEGIN = '<!-- BEGIN:PARAM-TABLE -->';
const END = '<!-- END:PARAM-TABLE -->';

const MODE = process.argv.includes('--print') ? 'print' : process.argv.includes('--check') ? 'check' : 'write';

/** 预设机型的默认值（第一列参考值） */
const base = PRESETS[0];
const rows = [];
for (const group of PARAM_GROUPS) {
  const specs = PARAM_SPEC.filter((s) => s.group === group);
  if (!specs.length) continue;
  rows.push(`### ${group}（${specs.length} 项）`, '');
  rows.push('| 参数键 | 界面名称 | 单位 | 区间 | 步长 | 默认值（预设机型） | 说明 |');
  rows.push('|---|---|---|---|---|---|---|');
  for (const s of specs) {
    const def = Number.isFinite(base[s.key]) ? String(base[s.key]) : '—';
    const hint = (s.hint ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
    const step = s.step ?? 1;
    rows.push(
      `| \`${s.key}\` | ${s.label} | ${s.unit || '—'} | ${s.min} ~ ${s.max} | ${step} | ${def} | ${hint || '—'} |`,
    );
  }
  rows.push('');
}
rows.push(
  `> 共 ${PARAM_SPEC.length} 项参数、${PARAM_GROUPS.length} 组。本表由 \`node tools/gen-param-table.mjs\` 从 \`assets/core/params.js\` 生成，请勿手改。`,
);
const table = rows.join('\n');

if (MODE === 'print') {
  console.log(table);
  process.exit(0);
}

const doc = await readFile(DOC, 'utf8');
const i = doc.indexOf(BEGIN);
const j = doc.indexOf(END);
if (i < 0 || j < 0 || j < i) {
  console.error(`文档里找不到标记区：${DOC}\n需要成对出现 ${BEGIN} 与 ${END}`);
  process.exit(1);
}
const next = `${doc.slice(0, i + BEGIN.length)}\n\n${table}\n\n${doc.slice(j)}`;

if (MODE === 'check') {
  if (next === doc) {
    console.log('参数表已同步 ✓');
    process.exit(0);
  }
  console.error('参数表与 params.js 不一致：请运行 node tools/gen-param-table.mjs');
  process.exit(1);
}

await writeFile(DOC, next);
console.log(`已更新 ${path.relative(process.cwd(), DOC)} 中的参数表（${PARAM_SPEC.length} 项）`);
