#!/usr/bin/env node
/**
 * 机型几何参数标定器（半解析求解）—— 第一级标定
 * ==========================================================================
 * ⚠️ 工作流有先后：本工具只解出「关节角层面的几何」，即
 *    动臂长度 / 斗杆长度 / 铲斗销轴至斗齿尖 / 铰点位置 / 目标关节角范围。
 *    要得到可运行的机型，必须接着跑：
 *        node tools/setup-cylinders.mjs
 *    由它把目标角度折算成三个油缸的安装位置、安装距、行程与铲斗四连杆尺寸。
 *
 * 厂家样本只给「作业尺寸指标」，不给铰点高度、关节角范围这些几何量。
 * 本工具按国标姿态定义的解析关系，从标称指标反解几何参数。
 *
 * 方程结构（已知 动臂 L1、斗杆 L2）：
 *   ① 铲斗销轴–斗齿尖 R3 = (最大挖掘高度 − 最大卸载高度) / 2
 *   ② 最小回转半径 S = pivotX + L1·cos(αmax) + 半个动臂截面宽
 *        → pivotX 由 αmax 决定
 *   ③ 停机面最大挖掘半径 G = pivotX + √(Lc² − pivotY²)，Lc = |A→C(Δmax)| + R3
 *   ④ 最大挖掘高度 H = pivotY + L1·sinαmax + L2·sin(αmax+Δmax) + R3
 *        ③④ 联立可解出 pivotY 与 Δmax（对 Δmax 做一维求根）
 *   ⑤ 最大挖掘深度 D = L2 + R3 − pivotY − L1·sinαmin  → 解出 αmin
 *   ⑥ 最大垂直挖掘深度 V → 解出斗底安装角
 *
 * 只剩 αmax 一个自由参数（4 个方程、5 个未知量），
 * 因此对 αmax 扫描，再按「铰点位置是否合理」挑最优解。
 *
 *   node tools/fit-preset.mjs --all
 *   node tools/fit-preset.mjs x20t
 */

import { PRESETS, getPreset } from '../assets/core/presets.js';
import { computeMetrics } from '../assets/core/metrics.js';
import { computeMinSwingRadius } from '../assets/core/envelope.js';
import { validateParams } from '../assets/core/params.js';
import { toRad, toDeg, clamp } from '../assets/core/geometry.js';
import { setupCylinders } from './setup-cylinders.mjs';

const HALF_BOOM = (p) => (p.boomWidth ?? 520) / 2;

/** 由 αmax 出发，按 ②③④ 解出 pivotX / pivotY / Δmax */
function solveForAlphaMax(base, t, R3, alphaMaxDeg) {
  const L1 = base.boomLength;
  const L2 = base.armLength;
  const aRad = toRad(alphaMaxDeg);

  const pivotX =
    t.minSwingRadius != null ? t.minSwingRadius - L1 * Math.cos(aRad) - HALF_BOOM(base) : base.pivotX;

  const need = t.groundMaxRadius - pivotX; // 需要 Lc·cos(tilt) 的值
  if (!(need > 0)) return null;

  // f(Δmax) = 按 ③ 定出的 pivotY 代入 ④ 后的残差
  const f = (deltaMaxDeg) => {
    const dRad = toRad(deltaMaxDeg);
    const ac = Math.sqrt(L1 * L1 + L2 * L2 + 2 * L1 * L2 * Math.cos(dRad));
    const Lc = ac + R3;
    const py2 = Lc * Lc - need * need;
    if (!(py2 > 0)) return null;
    const pivotY = Math.sqrt(py2);
    const h = pivotY + L1 * Math.sin(aRad) + L2 * Math.sin(aRad + dRad) + R3;
    return { pivotY, residual: h - t.maxDigHeight };
  };

  let lo = -70;
  let hi = 0;
  let flo = f(lo);
  let fhi = f(hi);
  if (!flo || !fhi) {
    for (let d = -70; d <= 0 && (!flo || !fhi); d += 1) {
      if (!flo) {
        lo = d;
        flo = f(d);
      }
      if (!fhi) {
        hi = -d;
        fhi = f(hi);
      }
    }
  }
  if (!flo || !fhi || flo.residual * fhi.residual > 0) return null;

  let a = lo;
  let b = hi;
  for (let i = 0; i < 80; i++) {
    const m = (a + b) / 2;
    const fm = f(m);
    if (!fm) return null;
    const fa = f(a);
    if (fa.residual * fm.residual <= 0) b = m;
    else a = m;
  }
  const deltaMax = (a + b) / 2;
  const sol = f(deltaMax);
  if (!sol) return null;

  const pivotY = sol.pivotY;
  const alphaMinDeg = toDeg(Math.asin(clamp((L2 + R3 - pivotY - t.maxDigDepth) / L1, -1, 1)));

  return { pivotX, pivotY, alphaMaxDeg, deltaMax, alphaMinDeg, R3 };
}

/** 合理性打分：铰点位置越接近常见布置越好 */
function plausibility(base, s) {
  let pen = 0;
  const px = s.pivotX;
  const py = s.pivotY;
  if (px < -250) pen += ((-250 - px) / 100) ** 2;
  if (px > 700) pen += ((px - 700) / 100) ** 2;
  if (py < 1100) pen += ((1100 - py) / 100) ** 2;
  if (py > 2500) pen += ((py - 2500) / 100) ** 2;
  if (s.deltaMax > -1) pen += ((s.deltaMax + 1) / 5) ** 2 * 0.35;
  if (s.deltaMax < -40) pen += ((-40 - s.deltaMax) / 5) ** 2 * 0.35;
  if (s.alphaMaxDeg < 35) pen += ((35 - s.alphaMaxDeg) / 5) ** 2 * 0.25;
  if (s.alphaMaxDeg > 68) pen += ((s.alphaMaxDeg - 68) / 5) ** 2 * 0.25;
  if (s.alphaMinDeg < -60) pen += ((-60 - s.alphaMinDeg) / 5) ** 2 * 0.25;
  if (s.alphaMinDeg > -25) pen += ((s.alphaMinDeg + 25) / 5) ** 2 * 0.25;
  if (py >= s.R3 + base.boomLength + base.armLength) pen += 10;
  return pen;
}

/** 由标称的最大垂直挖掘深度反解斗底安装角 */
function solveBottomAngle(base, params, targetV) {
  // 在该姿态下：depth = −(pivotY + L1·sinα + L2·sinγ + R3·sin(ψabs))，ψabs = 斗底角 − 90
  const alpha = params.boomAngleMin;
  const delta = clamp(-90 - alpha, params.armRelMin, params.armRelMax);
  const gamma = alpha + delta;
  const yC =
    params.pivotY + params.boomLength * Math.sin(toRad(alpha)) + params.armLength * Math.sin(toRad(gamma));
  const sinPsi = (-targetV - yC) / params.bucketRadius;
  if (Math.abs(sinPsi) > 1) return null;
  return toDeg(Math.asin(sinPsi)) + 90;
}

/** 关节角字段已从机型参数移到 calibration（角度是派生量，不再是输入项） */
const CAL_KEYS = new Set(['boomAngleMin', 'boomAngleMax', 'armRelMin', 'armRelMax']);
const seedOf = (m, k) => (CAL_KEYS.has(k) ? m.calibration?.[k] : m[k]);

function fit(machine) {
  const t = Object.fromEntries(Object.entries(machine.nominal ?? {}).filter(([, v]) => Number.isFinite(v)));
  console.log('');
  console.log('='.repeat(80));
  console.log(`标定机型：${machine.name}  [${machine.id}]`);
  console.log('='.repeat(80));

  if (!Object.keys(t).length) {
    console.log('  该机型无标称值，跳过。');
    return null;
  }

  const missing = ['groundMaxRadius', 'maxDigHeight', 'maxDigDepth', 'minSwingRadius'].filter((k) => t[k] == null);
  if (missing.length) {
    console.log(`  ! 缺少标定所需的标称值：${missing.join(', ')}，将沿用原值。`);
  }

  // ① 铲斗销轴–斗齿尖
  const R3 =
    t.maxDigHeight != null && t.dumpHeight != null ? (t.maxDigHeight - t.dumpHeight) / 2 : machine.bucketRadius;
  console.log(`  R3 由「挖掘高度 − 卸载高度 = 2·R3」定出：${R3.toFixed(0)} mm`);

  // 扫描 αmax，挑合理性最好的解
  const candidates = [];
  for (let am = 28; am <= 78; am += 0.05) {
    const s = solveForAlphaMax(machine, t, R3, am);
    if (!s) continue;
    s.penalty = plausibility(machine, s);
    candidates.push(s);
  }
  if (!candidates.length) {
    console.log('  ✗ 未找到可行解，请检查标称值是否自相矛盾。');
    return null;
  }
  candidates.sort((a, b) => a.penalty - b.penalty);

  let bestPick = null;
  for (const cand of candidates.slice(0, 400)) {
    const p = {
      ...machine,
      bucketRadius: R3,
      pivotX: Math.round(cand.pivotX),
      pivotY: Math.round(cand.pivotY),
      boomAngleMax: Number(cand.alphaMaxDeg.toFixed(2)),
      boomAngleMin: Number(cand.alphaMinDeg.toFixed(2)),
      armRelMax: Number(cand.deltaMax.toFixed(2)),
    };
    if (t.verticalWallDepth != null) {
      const bba = solveBottomAngle(machine, p, t.verticalWallDepth);
      if (bba != null && bba >= 20 && bba <= 100) p.bucketBottomAngle = Number(bba.toFixed(2));
    }

    // 关键一步：关节角在本模型里是派生量，直接算指标只会读到机型原有的油缸数据，
    // 拟合结果根本不会生效。必须先由目标角度折算出三个油缸与四连杆，再评估指标。
    // reuseBucket：复用现成连杆、跳过四连杆搜索（那要跑约 24 万次评估，而拟合要试
    // 几百个候选）。这么做是安全的——只要能覆盖目标 ψ 区间，
    // 解出的关节角范围与选中哪套连杆无关，因此作业尺寸也不变。
    const calibration = {
      boomAngleMin: Number(cand.alphaMinDeg.toFixed(2)),
      boomAngleMax: Number(cand.alphaMaxDeg.toFixed(2)),
      armRelMin: Number(machine.calibration?.armRelMin ?? p.armRelMin),
      armRelMax: Number(cand.deltaMax.toFixed(2)),
    };
    let built = setupCylinders({ ...p, calibration }, { reuseBucket: true });
    // 现成连杆覆盖不到新目标角时，退回完整搜索
    if (!built) built = setupCylinders({ ...p, calibration });
    if (!built) continue;
    const full = built.machine;
    if (!validateParams(full).ok) continue;

    const { values } = computeMetrics(full);
    const all = { ...values, minSwingRadius: computeMinSwingRadius(full) };
    let worst = 0;
    for (const [k, nom] of Object.entries(t)) worst = Math.max(worst, Math.abs((all[k] - nom) / nom));
    if (worst <= 0.01) {
      bestPick = { p: full, all, worst, cand };
      break;
    }
    if (!bestPick || worst < bestPick.worst) bestPick = { p: full, all, worst, cand };
  }

  if (!bestPick) {
    console.log('  ✗ 所有候选解都未通过参数校验。');
    return null;
  }

  const { p, all, worst } = bestPick;
  console.log(`  选取 αmax = ${p.boomAngleMax}°，Δmax = ${p.armRelMax}°，铰点 (${p.pivotX}, ${p.pivotY})`);
  console.log('');
  console.log(`  ${'指标'.padEnd(22)}${'拟合计算'.padStart(12)}${'标称'.padStart(12)}${'偏差'.padStart(11)}`);
  console.log('  ' + '-'.repeat(60));
  for (const [k, nom] of Object.entries(t)) {
    const calc = all[k];
    const dev = (calc - nom) / nom;
    console.log(
      `  ${k.padEnd(22)}${calc.toFixed(0).padStart(12)}${String(nom).padStart(12)}${((dev >= 0 ? '+' : '') + (dev * 100).toFixed(2) + '%').padStart(11)}${Math.abs(dev) <= 0.05 ? '  ✓' : '  ✗'}`,
    );
  }
  console.log(`\n  最大偏差 ${(worst * 100).toFixed(2)}%  ${worst <= 0.05 ? '✅ 达标' : '❌ 未达标'}`);

  console.log('\n  关节角层面的标定结果（下一步请跑 node tools/setup-cylinders.mjs 折算油缸）：');
  console.log('  {');
  console.log(`    id: '${machine.id}',`);
  console.log(`    name: '${machine.name}',`);
  for (const k of ['boomLength', 'armLength', 'bucketRadius', 'pivotX', 'pivotY', 'bucketBottomAngle', 'boomBend']) {
    if (k in p) console.log(`    ${k}: ${typeof p[k] === 'number' ? Number(p[k].toFixed(4)) : JSON.stringify(p[k])},`);
  }
  console.log('    calibration: {');
  console.log(`      boomAngleMin: ${p.calibration.boomAngleMin},`);
  console.log(`      boomAngleMax: ${p.calibration.boomAngleMax},`);
  console.log(`      armRelMin: ${p.calibration.armRelMin},`);
  console.log(`      armRelMax: ${p.calibration.armRelMax},`);
  console.log('    },');
  console.log('  },');

  return { p, worst };
}

const args = process.argv.slice(2);
const runAll = args.includes('--all');
const wanted = args.filter((a) => !a.startsWith('--'));
const list = runAll || !wanted.length ? PRESETS : wanted.map((id) => getPreset(id)).filter(Boolean);
for (const m of list) fit(m);
