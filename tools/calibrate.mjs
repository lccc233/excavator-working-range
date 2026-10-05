#!/usr/bin/env node
/**
 * 标定 / 对标报告
 * ==========================================================================
 * 对每个机型预设，把「几何模型算出来的指标」与「厂家样本标称值」逐项对比，
 * 打印偏差百分比。这是判断几何参数标定是否合格的唯一依据。
 *
 *   node tools/calibrate.mjs            全部机型
 *   node tools/calibrate.mjs x20t     指定机型
 *   node tools/calibrate.mjs --json     机器可读输出（供测试使用）
 */

import { PRESETS, getPreset } from '../assets/core/presets.js';
import { computeMetrics } from '../assets/core/metrics.js';
import { computeEnvelope, computeMinSwingRadius, envelopeExtremes } from '../assets/core/envelope.js';
import { validateParams } from '../assets/core/params.js';

const LABEL = {
  maxDigRadius: '最大挖掘半径',
  groundMaxRadius: '停机面最大挖掘半径',
  maxDigHeight: '最大挖掘高度',
  dumpHeight: '最大卸载高度',
  maxDigDepth: '最大挖掘深度',
  minSwingRadius: '最小回转半径',
};
const ORDER = Object.keys(LABEL);

const TOL = 0.05; // 允许偏差 ±5%

/** 按显示宽度补空格（中文算两格），保证终端里对齐 */
function width(str) {
  return [...String(str)].reduce((a, c) => a + (/[\u4e00-\u9fff]/.test(c) ? 2 : 1), 0);
}
function pad(s, n) {
  return String(s) + ' '.repeat(Math.max(0, n - width(s)));
}
function padL(s, n) {
  return ' '.repeat(Math.max(0, n - width(s))) + String(s);
}

export function evaluatePreset(machine, { envelopeSamples = 241 } = {}) {
  const check = validateParams(machine);
  const { values, poses, warnings, notes, ranges } = computeMetrics(machine);
  const env = computeEnvelope(machine, { samples: envelopeSamples, tol: 2 });
  const extremes = envelopeExtremes(env);
  const minSwing = computeMinSwingRadius(machine);
  const allValues = { ...values, minSwingRadius: minSwing };

  const rows = ORDER.filter((k) => machine.nominal?.[k] != null).map((k) => {
    const calc = allValues[k];
    const nom = machine.nominal[k];
    const dev = nom ? (calc - nom) / nom : NaN;
    return { key: k, label: LABEL[k], calc, nominal: nom, dev, pass: Math.abs(dev) <= TOL };
  });

  // 包络极值 vs 姿态定义指标的交叉校验
  const cross = [
    { key: 'maxDigHeight', label: LABEL.maxDigHeight, pose: values.maxDigHeight, env: extremes.maxY },
    { key: 'maxDigDepth', label: LABEL.maxDigDepth, pose: values.maxDigDepth, env: extremes.maxDepth },
    { key: 'maxDigRadius', label: LABEL.maxDigRadius, pose: values.maxDigRadius, env: extremes.maxX },
  ].map((c) => ({ ...c, diff: c.pose - c.env }));

  return { machine, check, values: allValues, poses, warnings, notes, rows, cross, env, extremes, minSwing, ranges };
}

function printReport(r) {
  const m = r.machine;
  console.log('');
  console.log('='.repeat(78));
  console.log(`机型：${m.name}   [${m.id}]`);
  console.log(
    `几何：动臂 ${m.boomLength} / 斗杆 ${m.armLength} / 铲斗销轴-斗齿尖 ${m.bucketRadius} mm，` +
      `铰点 (${m.pivotX}, ${m.pivotY})`,
  );
  const R = r.ranges;
  console.log(
    `油缸解出的关节角范围：动臂仰角 [${R.alpha[0].toFixed(2)}, ${R.alpha[1].toFixed(2)}]°，` +
      `斗杆相对转角 [${R.delta[0].toFixed(2)}, ${R.delta[1].toFixed(2)}]°，` +
      `铲斗相对转角 [${R.psi[0].toFixed(2)}, ${R.psi[1].toFixed(2)}]°`,
  );
  if (m.calibration) {
    const c = m.calibration;
    console.log(
      `标定目标角：动臂 [${c.boomAngleMin}, ${c.boomAngleMax}]°，斗杆 [${c.armRelMin}, ${c.armRelMax}]°`,
    );
  }
  console.log('='.repeat(78));

  if (!r.check.ok) {
    console.log('  ✗ 参数校验未通过：');
    for (const e of r.check.errors) console.log(`      · ${e}`);
  }
  for (const w of [...r.check.warnings, ...r.warnings]) console.log(`  ! ${w}`);

  if (r.rows.length === 0) {
    console.log('  （该机型未提供标称值，仅打印计算值）');
  } else {
    console.log('');
    console.log(`  ${pad('指标', 24)}${padL('计算值', 12)}${padL('标称值', 12)}${padL('偏差', 10)}  判定`);
    console.log('  ' + '-'.repeat(74));
    for (const row of r.rows) {
      const devStr = `${(row.dev * 100 >= 0 ? '+' : '') + (row.dev * 100).toFixed(2)}%`;
      console.log(
        `  ${pad(row.label, 24)}${padL(row.calc.toFixed(0), 12)}${padL(row.nominal, 12)}${padL(devStr, 10)}  ${
          row.pass ? '✓' : '✗ 超标'
        }`,
      );
    }
  }

  console.log('');
  console.log('  【包络交叉校验】姿态定义指标 vs 包络极值');
  console.log(`  ${pad('项目', 24)}${padL('姿态法', 12)}${padL('包络法', 12)}${padL('差值', 10)}`);
  console.log('  ' + '-'.repeat(74));
  for (const c of r.cross) {
    console.log(
      `  ${pad(c.label, 24)}${padL(c.pose.toFixed(0), 12)}${padL(c.env.toFixed(0), 12)}${padL(c.diff.toFixed(0), 10)}`,
    );
  }
  console.log('');
  console.log(
    `  包络点数：外缘 ${r.env.outer.length}，边界框 x∈[${r.env.bounds.minX.toFixed(0)}, ${r.env.bounds.maxX.toFixed(0)}] ` +
      `y∈[${r.env.bounds.minY.toFixed(0)}, ${r.env.bounds.maxY.toFixed(0)}]`,
  );
  console.log(`  最小回转半径（几何计算）：${r.minSwing.toFixed(0)} mm`);

  const failed = r.rows.filter((x) => !x.pass);
  console.log('');
  console.log(failed.length === 0 ? '  ✅ 全部标称项偏差 ≤ 5%' : `  ❌ ${failed.length} 项偏差超过 5%`);
  return failed.length === 0;
}

const args = process.argv.slice(2);
const wantJson = args.includes('--json');
const targets = args.filter((a) => !a.startsWith('--'));

const list = targets.length ? targets.map((id) => getPreset(id) ?? null).filter(Boolean) : PRESETS;
if (!list.length) {
  console.error(`未找到指定机型。可用：${PRESETS.map((m) => m.id).join(', ')}`);
  process.exit(2);
}

const results = list.map((m) => evaluatePreset(m));

if (wantJson) {
  console.log(
    JSON.stringify(
      results.map((r) => ({
        id: r.machine.id,
        name: r.machine.name,
        values: r.values,
        rows: r.rows,
        cross: r.cross,
        envPoints: r.env.outer.length,
        warnings: [...r.check.warnings, ...r.warnings],
      })),
      null,
      2,
    ),
  );
  process.exit(0);
}

let allPass = true;
for (const r of results) allPass = printReport(r) && allPass;

console.log('');
console.log(allPass ? '标定结论：通过 ✅' : '标定结论：存在超标项 ❌');
process.exit(allPass ? 0 : 1);
