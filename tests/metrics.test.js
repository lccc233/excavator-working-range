/**
 * 指标标定测试 —— 本项目最关键的验收测试
 * ==========================================================================
 * 断言「几何模型算出的五大指标」与「厂家公开样本标称值」一致。
 * 标定容差：任何单项偏差不得超过 5%；
 * 已标定机型（有完整样本数据的）实际偏差 < 0.5%，这里按 1% 收紧断言，
 * 一旦有人改动几何模型导致回归，测试会立刻失败。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { PRESETS, getPreset } from '../assets/core/presets.js';
import { computeMetrics, METRIC_META, METRIC_KEYS, straightChainLength } from '../assets/core/metrics.js';
import { computeEnvelope, envelopeExtremes, computeMinSwingRadius } from '../assets/core/envelope.js';
import { solvePose } from '../assets/core/geometry.js';
import { validateParams } from '../assets/core/params.js';

/** 合同容差 */
const CONTRACT_TOL = 0.05;
/** 已标定机型的收紧容差 */
const CALIBRATED_TOL = 0.01;

test('每个预设机型的全部标称指标都在合同容差 5% 内', () => {
  for (const m of PRESETS) {
    const { values } = computeMetrics(m);
    const all = { ...values, minSwingRadius: computeMinSwingRadius(m) };
    for (const [key, nom] of Object.entries(m.nominal ?? {})) {
      const calc = all[key];
      assert.ok(Number.isFinite(calc), `${m.id}.${key} 计算值非有限数`);
      const dev = Math.abs((calc - nom) / nom);
      assert.ok(
        dev <= CONTRACT_TOL,
        `${m.id}.${key}: 计算 ${calc.toFixed(0)} vs 标称 ${nom}，偏差 ${(dev * 100).toFixed(2)}%`,
      );
    }
  }
});

test('已标定机型的偏差不超过 1%', () => {
  for (const m of PRESETS) {
    const { values } = computeMetrics(m);
    const all = { ...values, minSwingRadius: computeMinSwingRadius(m) };
    for (const [key, nom] of Object.entries(m.nominal ?? {})) {
      const dev = Math.abs((all[key] - nom) / nom);
      assert.ok(dev <= CALIBRATED_TOL, `${m.id}.${key} 偏差 ${(dev * 100).toFixed(3)}% 超过收紧容差`);
    }
  }
});

test('20 吨级机型 逐项对标（权威回归基线）', () => {
  const m = getPreset('x20t');
  const { values } = computeMetrics(m);
  const expect = {
    groundMaxRadius: 9950,
    maxDigDepth: 6600,
    maxDigHeight: 9570,
    dumpHeight: 6700,
    verticalWallDepth: 5800,
  };
  for (const [k, v] of Object.entries(expect)) {
    assert.ok(Math.abs(values[k] - v) / v < 0.005, `${k}: ${values[k].toFixed(1)} 应接近 ${v}`);
  }
  const minSwing = computeMinSwingRadius(m);
  assert.ok(Math.abs(minSwing - 3730) / 3730 < 0.01, `最小回转半径 ${minSwing.toFixed(0)} 应接近 3730`);
});

test('最大挖掘高度 − 最大卸载高度 = 2×铲斗销轴到斗齿尖距离', () => {
  for (const m of PRESETS) {
    const { values } = computeMetrics(m);
    const diff = values.maxDigHeight - values.dumpHeight;
    assert.ok(Math.abs(diff - 2 * m.bucketRadius) < 1, `${m.id}: 差值 ${diff.toFixed(1)} 应为 2R3=${2 * m.bucketRadius}`);
  }
});

test('最大挖掘半径严格大于停机面最大挖掘半径', () => {
  for (const m of PRESETS) {
    const { values } = computeMetrics(m);
    assert.ok(
      values.maxDigRadius > values.groundMaxRadius,
      `${m.id}: 水平共线半径 ${values.maxDigRadius.toFixed(0)} 应大于触地半径 ${values.groundMaxRadius.toFixed(0)}`,
    );
  }
});

test('最大挖掘半径等于铰点前移量加整链伸直长度', () => {
  for (const m of PRESETS) {
    const { values } = computeMetrics(m);
    assert.ok(Math.abs(values.maxDigRadius - (m.pivotX + straightChainLength(m))) < 1e-6);
  }
});

test('停机面最大挖掘半径满足触地几何关系', () => {
  for (const m of PRESETS) {
    const { values } = computeMetrics(m);
    const L = straightChainLength(m);
    const expect = m.pivotX + Math.sqrt(L * L - m.pivotY * m.pivotY);
    assert.ok(Math.abs(values.groundMaxRadius - expect) < 1e-6, `${m.id}`);
  }
});

test('最大挖掘深度姿态下斗齿尖恰位于铰点垂线上', () => {
  for (const m of PRESETS) {
    const { poses, values } = computeMetrics(m);
    const pose = poses.maxDigDepth;
    assert.ok(Math.abs(pose.B.x - pose.C.x) < 1e-6, `${m.id}: B.x≠C.x`);
    assert.ok(Math.abs(pose.C.x - pose.T.x) < 1e-6, `${m.id}: C.x≠T.x`);
    assert.ok(Math.abs(-pose.T.y - values.maxDigDepth) < 1e-6, `${m.id}: 深度与姿态不一致`);
  }
});

/**
 * 姿态角由油缸反解得到，而油缸的安装距/行程是「整数毫米」的工程值，
 * 取整会让解出的关节角偏离标定目标千分之几度——
 * 这不是误差而是物理事实：用这个规格的油缸，动臂就是只能到 52.29° 而不是 52.30°。
 * 因此这里按「斗齿尖偏离铅垂线的角度」断言，容差 0.15°（对应 1435 mm 铲斗约 3.8 mm）。
 */
const POSE_ANGLE_TOL_DEG = 0.15;

function tipTiltFromVertical(pose) {
  const dx = pose.T.x - pose.C.x;
  const dy = pose.T.y - pose.C.y;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return Infinity;
  const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
  // 朝上（+90°）与朝下（−90°）都算「铅垂」，取与最近铅垂方向的夹角
  return Math.abs(Math.abs(ang) - 90);
}

test('最大卸载高度姿态下斗齿尖接近铰点正下方（铅垂）', () => {
  for (const m of PRESETS) {
    const { poses, values } = computeMetrics(m);
    const pose = poses.dumpHeight;
    const tilt = tipTiltFromVertical(pose);
    assert.ok(tilt < POSE_ANGLE_TOL_DEG, `${m.id}: 斗齿尖偏离铅垂 ${tilt.toFixed(3)}°`);
    assert.ok(pose.T.y < pose.C.y, `${m.id}: 卸载时斗齿尖应低于铰点`);
    assert.ok(Math.abs(pose.T.y - values.dumpHeight) < 1e-6);
  }
});

test('最大挖掘高度姿态下斗齿尖接近铰点正上方（铅垂）', () => {
  for (const m of PRESETS) {
    const { poses, values } = computeMetrics(m);
    const pose = poses.maxDigHeight;
    const tilt = tipTiltFromVertical(pose);
    assert.ok(tilt < POSE_ANGLE_TOL_DEG, `${m.id}: 斗齿尖偏离铅垂 ${tilt.toFixed(3)}°`);
    assert.ok(pose.T.y > pose.C.y, `${m.id}: 挖掘高度姿态斗齿尖应高于铰点`);
    assert.ok(Math.abs(pose.T.y - values.maxDigHeight) < 1e-6);
  }
});

test('每个指标姿态的斗齿尖都落在包络外缘之内（容差 30 mm）', () => {
  for (const m of PRESETS) {
    const { poses } = computeMetrics(m);
    const env = computeEnvelope(m, { samples: 181, tol: 2 });
    const A = env.A;
    for (const key of METRIC_KEYS) {
      const T = poses[key].T;
      const r = Math.hypot(T.x - A.x, T.y - A.y);
      const th = Math.atan2(T.y - A.y, T.x - A.x);
      // 外缘按 0.5° 极角分箱，指标姿态的方向可能正好落在最后一个箱的边沿外，
      // 这里给一个箱宽（≈0.5°）的角向容差再取其中最大的包络半径
      let rEnv = radiusAt(env.outer, A, th);
      for (const d of [-0.005, 0.005, -0.01, 0.01]) {
        const alt = radiusAt(env.outer, A, th + d);
        if (alt != null && (rEnv == null || alt > rEnv)) rEnv = alt;
      }
      assert.ok(rEnv != null, `${m.id}.${key}: 包络在该方向上没有取到半径`);
      assert.ok(r <= rEnv + 30, `${m.id}.${key}: 姿态点半径 ${r.toFixed(0)} 超出包络 ${rEnv?.toFixed(0)}`);
    }
  }
});

test('包络极值与姿态法指标一致（外缘必须在 2 mm 内穿过极值点）', () => {
  for (const m of PRESETS) {
    const { values } = computeMetrics(m);
    const env = computeEnvelope(m, { samples: 241, tol: 1 });
    const ex = envelopeExtremes(env);
    assert.ok(
      Math.abs(ex.maxY - values.maxDigHeight) < 2,
      `${m.id}: 包络最高 ${ex.maxY.toFixed(1)} vs 最大挖掘高度 ${values.maxDigHeight.toFixed(1)}`,
    );
    assert.ok(
      Math.abs(ex.maxDepth - values.maxDigDepth) < 2,
      `${m.id}: 包络最深 ${ex.maxDepth.toFixed(1)} vs 最大挖掘深度 ${values.maxDigDepth.toFixed(1)}`,
    );
    assert.ok(
      Math.abs(ex.maxX - values.maxDigRadius) < 2,
      `${m.id}: 包络最远 ${ex.maxX.toFixed(1)} vs 最大挖掘半径 ${values.maxDigRadius.toFixed(1)}`,
    );
  }
});

/** 在折线中按极角线性插值出半径 */
function radiusAt(points, A, th) {
  let found = null;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    const t1 = Math.atan2(p.y - A.y, p.x - A.x);
    const t2 = Math.atan2(q.y - A.y, q.x - A.x);
    if (angleWithin(th, t1, t2)) {
      const f = (th - t1) / (normalize(t2 - t1) || 1);
      const r1 = Math.hypot(p.x - A.x, p.y - A.y);
      const r2 = Math.hypot(q.x - A.x, q.y - A.y);
      const r = r1 + (r2 - r1) * Math.min(Math.max(f, 0), 1);
      if (found == null || r > found) found = r;
    }
  }
  return found;
}
function normalize(a) {
  let x = a % (Math.PI * 2);
  if (x > Math.PI) x -= Math.PI * 2;
  if (x < -Math.PI) x += Math.PI * 2;
  return x;
}
function angleWithin(th, t1, t2) {
  const d = normalize(t2 - t1);
  const rel = normalize(th - t1);
  if (Math.abs(d) > Math.PI * 0.9) return false; // 跳过环绕的长弧
  return (d >= 0 && rel >= 0 && rel <= d) || (d < 0 && rel <= 0 && rel >= d);
}

test('METRIC_META 与计算输出键一致', () => {
  const { values } = computeMetrics(PRESETS[0]);
  for (const meta of METRIC_META) {
    assert.ok(Number.isFinite(values[meta.key]), `缺少指标 ${meta.key}`);
    assert.ok(meta.label && meta.symbol && meta.color);
  }
  assert.deepEqual(METRIC_KEYS, METRIC_META.map((m) => m.key));
});

test('极端但合法的参数下指标不产生 NaN / Infinity', () => {
  const base = PRESETS[0];
  const variants = [
    { boomCylStroke: 1200, armCylStroke: 2400, bktCylStroke: 1600 },
    { boomCylStroke: 320, armCylStroke: 380, bktCylStroke: 340 },
    { boomCylBodyDX: 900, boomCylBodyDY: -1200 },
    { armCylBodyAlong: -1200, armCylBodyPerp: 1400 },
    { bktCylBodyPerp: 900, bktBellPerp: -600 },
    { bktBranch: 1 },
    { pivotX: 800, pivotY: 900 },
    { trackHeight: 1400, cabHeight: 4500 },
    { boomCylRodAlong: 1200, boomCylRodPerp: -400 },
    { armCylRodAlong: -900, armCylRodPerp: -1100 },
  ];

  let checked = 0;
  for (const patch of variants) {
    const m = { ...base, ...patch };
    const check = validateParams(m);
    if (!check.ok) {
      // 解不出来的组合必须被校验拦在计算之外，而不是把 NaN 放进指标
      assert.ok(check.errors.length > 0, `${JSON.stringify(patch)} 未通过校验却没有报错信息`);
      continue;
    }
    const { values } = computeMetrics(m);
    for (const [k, v] of Object.entries(values)) {
      assert.ok(Number.isFinite(v), `${JSON.stringify(patch)} 下 ${k}=${v}`);
    }
    checked++;
  }
  assert.ok(checked >= 4, `至少要有 4 组极端参数进入计算，实际只有 ${checked} 组`);
});

test('姿态解算与 solvePose 自洽', () => {
  const m = PRESETS[0];
  const { poses } = computeMetrics(m);
  for (const [key, pose] of Object.entries(poses)) {
    const again = solvePose(m, pose.alphaDeg, pose.deltaDeg, pose.psiDeg);
    assert.ok(Math.abs(again.T.x - pose.T.x) < 1e-9, `${key} 重算不一致`);
    assert.ok(Math.abs(again.T.y - pose.T.y) < 1e-9, `${key} 重算不一致`);
  }
});
