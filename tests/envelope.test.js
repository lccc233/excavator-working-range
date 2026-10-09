/**
 * 包络求解测试
 *
 * 包络按「九段圆弧作图法」生成：每段只动一个油缸、其余两个不动，齿尖画出一段圆弧。
 * 因此测试的重点是：① 九段依次相接并闭合；② 每段只动一个参数；
 * ③ ①③⑤段末端的共线条件、②④⑥⑦⑧⑨段末端的行程端点条件成立；
 * ④ 四个标称极值落在包络上。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { PRESETS } from '../assets/core/presets.js';
import {
  computeEnvelope,
  simplify,
  boundsOf,
  envelopeExtremes,
  computeMinSwingRadius,
} from '../assets/core/envelope.js';
import { computeMetrics } from '../assets/core/metrics.js';
import { jointRanges } from '../assets/core/params.js';
import { solvePose, bucketLocalShape, bucketPolygon, toRad } from '../assets/core/geometry.js';
import * as arm from '../assets/core/cylinders.js';

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const norm = (v) => Math.hypot(v.x, v.y);
const dot = (a, b) => a.x * b.x + a.y * b.y;
const cross = (a, b) => a.x * b.y - a.y * b.x;
const near = (a, b, message, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${message}: ${a} vs ${b}`);
const ARC_TYPES = ['bucket', 'boom', 'bucket', 'arm', 'bucket', 'boom', 'bucket', 'arm', 'bucket'];
const MOVING = [2, 0, 2, 1, 2, 0, 2, 1, 2];
const ROTATION_SIGNS = [-1, -1, -1, -1, -1, 1, -1, 1, 1];
const LENGTH_SIGNS = [1, -1, 1, 1, 1, 1, 1, -1, -1];

// Independently derive the endpoint poses from geometry and cylinder strokes.
function prescribedPoses(m) {
  const { alpha: [aMin, aMax], delta: [dMin, dMax], psi: [pMin, pMax] } = jointRanges(m);
  const align = (alpha, delta, inward) => {
    const pose = solvePose(m, alpha, delta, 0);
    const ac = sub(pose.C, pose.A);
    let psi = Math.atan2(ac.y, ac.x) * 180 / Math.PI + (inward ? 180 : 0) - alpha - delta;
    const middle = (pMin + pMax) / 2;
    while (psi - middle > 180) psi -= 360;
    while (psi - middle < -180) psi += 360;
    return Math.min(pMax, Math.max(pMin, psi));
  };
  const outward = align(aMax, dMax, false);
  const inward = align(aMin, dMin, true);
  const extended = Math.min(outward, Math.max(pMin, Math.min(pMax, 0)));
  return [
    [aMax, dMax, pMax], [aMax, dMax, outward], [aMin, dMax, outward],
    [aMin, dMax, extended], [aMin, dMin, extended], [aMin, dMin, inward],
    [aMax, dMin, inward], [aMax, dMin, pMin], [aMax, dMax, pMin], [aMax, dMax, pMax],
  ];
}

function cylinderLengths(m, q) {
  const pins = arm.cylinderPose(m, solvePose(m, ...q));
  return [pins.boom, pins.arm, pins.bucket].map((c) => norm(sub(c.rod, c.body)));
}

test('包络闭合，且九段依次首尾相接', () => {
  for (const m of PRESETS) {
    const env = computeEnvelope(m);
    assert.equal(env.closed, true, `${m.id}: 包络没有闭合（起点与终点不重合）`);
    assert.equal(env.segments.length, 9, `${m.id}: 应该有 9 段圆弧，实际 ${env.segments.length}`);
    assert.deepEqual(env.segments.map((s) => s.which), ARC_TYPES, `${m.id}: 新增铲斗段应位于动臂收回与斗杆伸出之间`);
    assert.ok(env.outer.length > 60, `${m.id}: 包络点数过少 ${env.outer.length}`);
    for (let i = 1; i < env.segments.length; i++) {
      assert.equal(
        env.segments[i].ptFrom,
        env.segments[i - 1].ptTo + 1,
        `${m.id}: 第 ${i} 段起点与第 ${i - 1} 段终点在点列上不相接`,
      );
    }
    // 每段只动一个参数
    for (const s of env.segments) {
      assert.ok(['boom', 'arm', 'bucket'].includes(s.which), `${m.id}: 未知段类型 ${s.which}`);
      assert.ok(Math.abs(s.to - s.from) > 0.1, `${m.id}: 第 ${s.index} 段几乎没有行程（${s.from}→${s.to}）`);
    }
  }
});

test('每段圆弧的端点满足作图法条件', () => {
  for (const m of PRESETS) {
    // Segment indices refer to the unsimplified point sequence.
    const env = computeEnvelope(m, { tol: 0 });
    const q = prescribedPoses(m);
    const lo = [m.boomCylClosed, m.armCylClosed, m.bktCylClosed];
    const hi = [lo[0] + m.boomCylStroke, lo[1] + m.armCylStroke, lo[2] + m.bktCylStroke];
    const targets = [null, lo[0], null, hi[1], null, hi[0], hi[2], lo[1], lo[2]];
    assert.equal(env.segments.length, 9, `${m.id}: 九段姿态端点缺失`);
    for (let i = 0; i < env.segments.length; i++) {
      const s = env.segments[i];
      const k = MOVING[i];
      const first = i ? s.ptFrom - 1 : 0;
      assert.equal(s.which, ARC_TYPES[i], `${m.id}: 第 ${i + 1} 段缸次序`);
      near(s.from, q[i][k], `${m.id}: 第 ${i + 1} 段起始角`, 0.000501);
      near(s.to, q[i + 1][k], `${m.id}: 第 ${i + 1} 段终止角`, 0.000501);
      near(norm(sub(env.outer[first], solvePose(m, ...q[i]).T)), 0, `${m.id}: 第 ${i + 1} 段实际起点`);
      near(norm(sub(env.outer[s.ptTo], solvePose(m, ...q[i + 1]).T)), 0, `${m.id}: 第 ${i + 1} 段实际终点`);
      if (targets[i] !== null) near(cylinderLengths(m, q[i + 1])[k], targets[i], `${m.id}: 第 ${i + 1} 段行程端点`);
    }
    for (const [segment, anchor, inward] of [[1, 'A', false], [3, 'B', false], [5, 'A', true]]) {
      const pose = solvePose(m, ...q[segment]);
      const ac = sub(pose.C, pose[anchor]);
      const at = sub(pose.T, pose[anchor]);
      near(Math.abs(cross(ac, at)) / norm(ac), 0, `${m.id}: 第 ${segment} 段共线误差`);
      const projection = dot(ac, at) / dot(ac, ac);
      assert.ok(inward ? projection > 0 && projection < 1 : projection > 1,
        `${m.id}: 第 ${segment} 段齿尖共线方向错误`);
    }
  }
});

test('九段实际轨迹均按指定方向转动，两个固定油缸不漂移，所有油缸全程遵守行程', () => {
  for (const m of PRESETS) {
    const env = computeEnvelope(m, { tol: 0 });
    const q = prescribedPoses(m);
    const lo = [m.boomCylClosed, m.armCylClosed, m.bktCylClosed];
    const hi = [lo[0] + m.boomCylStroke, lo[1] + m.armCylStroke, lo[2] + m.bktCylStroke];
    assert.equal(env.segments.length, 9, `${m.id}: 九段实际轨迹缺失`);
    for (let i = 0; i < env.segments.length; i++) {
      const s = env.segments[i];
      const k = MOVING[i];
      const start = solvePose(m, ...q[i]);
      const pivot = start[['A', 'B', 'C'][k]];
      const zero = [...q[i]];
      zero[k] = 0;
      const ref = sub(solvePose(m, ...zero).T, pivot);
      const radius = norm(ref);
      const fixed = cylinderLengths(m, q[i]);
      let previousAngle = q[i][k];
      let previousLength = fixed[k];
      for (let j = i ? s.ptFrom - 1 : 0; j <= s.ptTo; j++) {
        const radial = sub(env.outer[j], pivot);
        near(norm(radial), radius, `${m.id}: 第 ${i + 1} 段圆弧半径`);
        let angle = Math.atan2(cross(ref, radial), dot(ref, radial)) * 180 / Math.PI;
        const middle = (q[i][k] + q[i + 1][k]) / 2;
        while (angle - middle > 180) angle -= 360;
        while (angle - middle < -180) angle += 360;
        assert.ok((angle - previousAngle) * ROTATION_SIGNS[i] >= -1e-8, `${m.id}: 第 ${i + 1} 段旋转方向错误`);
        const sample = [...q[i]];
        sample[k] = angle;
        const lengths = cylinderLengths(m, sample);
        for (let n = 0; n < 3; n++) {
          assert.ok(lengths[n] >= lo[n] - 1e-6 && lengths[n] <= hi[n] + 1e-6, `${m.id}: 第 ${i + 1} 段第 ${n + 1} 缸超出行程`);
          if (n !== k) near(lengths[n], fixed[n], `${m.id}: 第 ${i + 1} 段第 ${n + 1} 固定缸漂移`);
        }
        assert.ok((lengths[k] - previousLength) * LENGTH_SIGNS[i] >= -1e-6, `${m.id}: 第 ${i + 1} 段油缸伸缩方向错误`);
        previousAngle = angle;
        previousLength = lengths[k];
      }
    }
  }
});

test('新增③到 B–C–T 共线后，新④覆盖斗杆与齿尖最大外伸半径', () => {
  for (const m of PRESETS) {
    const env = computeEnvelope(m, { stepDeg: 0.1, tol: 0 });
    const q = prescribedPoses(m);
    const s = env.segments[3];
    assert.equal(s.which, 'arm', `${m.id}: 共线后应开始斗杆圆弧`);
    const start = solvePose(m, ...q[3]);
    const radius = m.armLength + m.bucketRadius;
    const legacyRadius = norm(sub(solvePose(m, q[3][0], q[3][1], q[2][2]).T, start.B));
    assert.ok(radius - legacyRadius > 1e-4, `${m.id}: 旧轨迹应漏掉可达的最大外伸圆弧`);
    for (let j = s.ptFrom - 1; j <= s.ptTo; j++) {
      near(norm(sub(env.outer[j], start.B)), radius, `${m.id}: 斗杆最大外伸圆弧半径`);
    }
  }
});

test('E215 新④达到动臂全缩时可达的最深点，约 6296 mm', () => {
  const m = PRESETS.find((p) => p.id === 'E215HC4488A06A0');
  const { alpha: [aMin], delta: [dMin, dMax] } = jointRanges(m);
  const delta = -90 - aMin;
  assert.ok(delta > dMin && delta < dMax, '竖直向下姿态必须在斗杆行程内');
  const B = solvePose(m, aMin, delta, 0).B;
  const exactDepth = m.armLength + m.bucketRadius - B.y;
  near(exactDepth, 6296, 'E215 可达最深点约 6296 mm', 1);
  const env = computeEnvelope(m, { stepDeg: 0.1, tol: 0 });
  near(envelopeExtremes(env).maxDepth, exactDepth, 'E215 包络应到达竖直外伸最深点', 0.01);
  near(envelopeExtremes(computeEnvelope(m)).maxDepth, exactDepth, 'E215 默认显示精度应包含修复后的最深点', 1);
});

test('新增③在零角不可达时遵守铲斗行程，并保留退化段供新④连续起步', () => {
  const base = PRESETS.find((p) => p.id === 'E215HC4488A06A0');
  for (const [minimum, maximum] of [[5, 30], [-30, -5]]) {
    const short = arm.bucketCylLength(base, maximum);
    const long = arm.bucketCylLength(base, minimum);
    const m = { ...base, bktCylClosed: short, bktCylStroke: long - short };
    const env = computeEnvelope(m, { tol: 0 });
    const q = prescribedPoses(m);
    assert.equal(env.segments.length, 9, `ψ∈[${minimum},${maximum}]: 退化段仍应保留`);
    const align = env.segments[2];
    const sweep = env.segments[3];
    near(q[3][2], minimum > 0 ? minimum : maximum, '新增段应截在可达且不需逆转的端点');
    near(align.to, q[3][2], '新增段缸长边界角', 0.000501);
    assert.ok(align.to <= align.from, '新增段不应逆时针转动');
    if (maximum < 0) {
      assert.equal(align.from, align.to, '目标零角位于逆时针方向时应保持姿态');
      assert.equal(align.ptTo, env.segments[1].ptTo, '退化段不应新增伪轨迹点');
    }
    assert.equal(sweep.ptFrom, align.ptTo + 1, '新④应从新增段实际终点连续起步');
    const start = solvePose(m, ...q[3]);
    near(norm(sub(env.outer[sweep.ptFrom - 1], start.T)), 0, '新④实际起点');
    const radius = Math.sqrt(m.armLength ** 2 + m.bucketRadius ** 2
      + 2 * m.armLength * m.bucketRadius * Math.cos(q[3][2] * Math.PI / 180));
    for (let j = sweep.ptFrom - 1; j <= sweep.ptTo; j++) {
      near(norm(sub(env.outer[j], start.B)), radius, '截断姿态下新④的实际圆弧半径');
    }
    for (const pose of [q[2], q[3], q[4]]) {
      const lengths = cylinderLengths(m, pose);
      assert.ok(lengths[2] >= short - 1e-6 && lengths[2] <= long + 1e-6, '截断段铲斗缸不应超行程');
    }
    assert.equal(env.closed, true, '截断新增段后包络仍应闭合');
    assert.ok(env.outer.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)), '退化段不应产生非法点');
  }
});

test('有厂家标称值的预设：包络极值与指标一致（≤2 mm）', () => {
  for (const m of PRESETS) {
    if (!Object.keys(m.nominal ?? {}).length) continue;
    const { values } = computeMetrics(m);
    const ex = envelopeExtremes(computeEnvelope(m));
    assert.ok(Math.abs(ex.maxY - values.maxDigHeight) < 2, `${m.id}: 最高点 ${ex.maxY.toFixed(2)} vs ${values.maxDigHeight.toFixed(2)}`);
    assert.ok(Math.abs(ex.maxDepth - values.maxDigDepth) < 2, `${m.id}: 最深点 ${ex.maxDepth.toFixed(2)} vs ${values.maxDigDepth.toFixed(2)}`);
    assert.ok(Math.abs(ex.maxX - values.maxDigRadius) < 2, `${m.id}: 最远点 ${ex.maxX.toFixed(2)} vs ${values.maxDigRadius.toFixed(2)}`);
  }
});

test('包络上处处是齿尖，且都是合法姿态', () => {
  const m = PRESETS[0];
  const env = computeEnvelope(m);
  const { values } = computeMetrics(m);
  assert.ok(env.bounds.minY > -values.maxDigDepth - 5, '包络最深点不应明显超过最大挖掘深度');
  assert.ok(env.bounds.maxY < values.maxDigHeight + 5, '包络最高点不应超过最大挖掘高度');
  // 包络是闭合轮廓：面积落在合理量级
  let a2 = 0;
  for (let i = 0; i < env.outer.length; i++) {
    const u = env.outer[i];
    const v = env.outer[(i + 1) % env.outer.length];
    a2 += u.x * v.y - v.x * u.y;
  }
  const area = Math.abs(a2) / 2 / 1e6;
  assert.ok(area > 60 && area < 140, `包络面积 ${area.toFixed(1)} m² 不在合理范围`);
});

test('包络上没有横跨工作区的假直边（每段都是圆弧）', () => {
  for (const m of PRESETS) {
    const env = computeEnvelope(m);
    let longest = 0;
    for (let i = 0; i < env.outer.length; i++) {
      const a = env.outer[i];
      const b = env.outer[(i + 1) % env.outer.length];
      longest = Math.max(longest, Math.hypot(b.x - a.x, b.y - a.y));
    }
    // 圆弧采样步距 0.75°：最大圆弧半径约 10 m，弦长 ≈ 130 mm；留 1 m 余量足够
    assert.ok(longest < 1000, `${m.id}: 出现 ${longest.toFixed(0)} mm 的长边，可能有假直边`);
  }
});

/**
 * 把整台机器（含全部铰点与油缸数据）关于地面原点放大 k 倍。
 * 引入油缸之后，单独改 boomLength 会让安装点相对杆件错位、关节角范围随之改变，
 * 那不是「同型更大的机器」而是「换了杆件还留着旧油缸」；真实改型是整套一起动。
 */
const SCALE_KEYS = [
  'boomLength', 'armLength', 'bucketRadius', 'pivotX', 'pivotY',
  'boomCylBodyDX', 'boomCylBodyDY', 'boomCylRodAlong', 'boomCylRodPerp',
  'armCylBodyAlong', 'armCylBodyPerp', 'armCylRodAlong', 'armCylRodPerp',
  'bktCylBodyAlong', 'bktCylBodyPerp', 'bktBellAlong', 'bktBellPerp',
  'bktRockerLen', 'bktEAlong', 'bktEPerp', 'bktLinkLen',
  'boomCylClosed', 'boomCylStroke', 'armCylClosed', 'armCylStroke', 'bktCylClosed', 'bktCylStroke',
  'trackLength', 'trackWidth', 'platformFront',
];

function scaleMachine(p, k) {
  const out = { ...p };
  for (const key of SCALE_KEYS) out[key] = p[key] * k;
  return out;
}

test('包络对参数单调：整机放大后包络必定外扩', () => {
  const base = PRESETS[0];
  const e1 = computeEnvelope(base);
  const e2 = computeEnvelope(scaleMachine(base, 1.15));
  const b1 = boundsOf(e1.outer);
  const b2 = boundsOf(e2.outer);
  assert.ok(b2.maxX > b1.maxX, `整机放大后最远点应变大：${b1.maxX.toFixed(0)} → ${b2.maxX.toFixed(0)}`);
  assert.ok(b2.maxY > b1.maxY, `整机放大后最高点应变大：${b1.maxY.toFixed(0)} → ${b2.maxY.toFixed(0)}`);
});

test('包络对参数单调：斗杆加长后挖掘深度必定加深', () => {
  const base = PRESETS[0];
  // 真实改型是「换一根更长的斗杆，并把挂在斗杆上的铰点与油缸整套按比例搬过去」
  const cal = base.calibration;
  const k = (base.armLength + 700) / base.armLength;
  const armKeys = [
    'armCylRodAlong', 'armCylRodPerp',
    'bktCylBodyAlong', 'bktCylBodyPerp', 'bktBellAlong', 'bktBellPerp',
    'bktRockerLen', 'bktEAlong', 'bktEPerp', 'bktLinkLen',
  ];
  const longer = { ...base, armLength: base.armLength * k };
  for (const key of armKeys) longer[key] = base[key] * k;
  const psiRetracted = 90 - (cal.boomAngleMax + cal.armRelMax);
  const cyl = arm.calibrateCylinders(longer, {
    alphaMin: cal.boomAngleMin,
    alphaMax: cal.boomAngleMax,
    deltaMin: cal.armRelMin,
    deltaMax: cal.armRelMax,
    psiRetracted,
    psiExtended: psiRetracted - 180,
  });
  Object.assign(longer, cyl);

  const r2 = computeMetrics(longer).ranges;
  assert.ok(
    Math.abs(r2.delta[1] - cal.armRelMax) < 0.1,
    `重新标定后斗杆转角上限应与目标一致：${r2.delta[1].toFixed(2)} vs ${cal.armRelMax}`,
  );
  assert.ok(r2.delta[0] < -100, `斗杆转角下限应仍在收拢侧：${r2.delta[0].toFixed(2)}`);

  const e1 = envelopeExtremes(computeEnvelope(base));
  const e2 = envelopeExtremes(computeEnvelope(longer));
  assert.ok(
    e2.maxDepth > e1.maxDepth + 100,
    `斗杆加长后挖掘深度应明显加深：${e1.maxDepth.toFixed(0)} → ${e2.maxDepth.toFixed(0)}`,
  );
});

test('圆弧采样步距加密后极值稳定（默认精度已收敛）', () => {
  for (const m of PRESETS) {
    const coarse = envelopeExtremes(computeEnvelope(m, { stepDeg: 0.75 }));
    const fine = envelopeExtremes(computeEnvelope(m, { stepDeg: 0.2 }));
    assert.ok(Math.abs(coarse.maxY - fine.maxY) < 2, `${m.id}: 最高点差 ${(coarse.maxY - fine.maxY).toFixed(2)} mm`);
    assert.ok(Math.abs(coarse.maxDepth - fine.maxDepth) < 2, `${m.id}: 最深点差 ${(coarse.maxDepth - fine.maxDepth).toFixed(2)} mm`);
    assert.ok(Math.abs(coarse.maxX - fine.maxX) < 2, `${m.id}: 最远点差 ${(coarse.maxX - fine.maxX).toFixed(2)} mm`);
  }
});

test('simplify 保留端点并遵守容差', () => {
  const pts = [];
  for (let i = 0; i <= 100; i++) pts.push({ x: i, y: Math.sin(i / 10) * 50 });
  const s = simplify(pts, 1);
  assert.equal(s[0].x, pts[0].x);
  assert.equal(s[s.length - 1].x, pts[pts.length - 1].x);
  assert.ok(s.length <= pts.length);
  assert.ok(s.length > 2);
});

test('simplify 容差为 0 或点太少时原样返回', () => {
  const pts = [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
    { x: 2, y: 0 },
  ];
  assert.deepEqual(simplify(pts, 0), pts);
  assert.deepEqual(simplify([{ x: 1, y: 2 }], 5), [{ x: 1, y: 2 }]);
});

test('boundsOf 处理空数组不崩溃', () => {
  assert.deepEqual(boundsOf([]), { minX: 0, maxX: 0, minY: 0, maxY: 0 });
});

test('最小回转半径不小于平台前端，且不大于最大挖掘半径', () => {
  for (const m of PRESETS) {
    const r = computeMinSwingRadius(m);
    const { values } = computeMetrics(m);
    assert.ok(Number.isFinite(r) && r > 0, `${m.id}: ${r}`);
    assert.ok(r >= m.platformFront - 1e-6, `${m.id}: 最小回转半径 ${r.toFixed(0)} 小于平台前端 ${m.platformFront}`);
    assert.ok(r <= values.maxDigRadius, `${m.id}: 最小回转半径不应超过最大挖掘半径`);
  }
});

test('最小回转半径对动臂长度单调', () => {
  const base = PRESETS[0];
  const r1 = computeMinSwingRadius(base);
  const r2 = computeMinSwingRadius({ ...base, boomLength: base.boomLength + 1000 });
  assert.ok(r2 > r1, `动臂加长后最小回转半径应变大：${r1.toFixed(0)} → ${r2.toFixed(0)}`);
});

test('最小回转半径不小于回转平台前端（动臂后仰时不能算出几百毫米）', () => {
  const extreme = { ...PRESETS[0], boomCylStroke: 1200 };
  const r = computeMinSwingRadius(extreme);
  assert.ok(
    r >= extreme.platformFront - 1e-6,
    `极端行程下最小回转半径 ${r.toFixed(0)} 应被平台前端 ${extreme.platformFront} 兜住`,
  );
});

test('最小回转半径采样网格收敛（25×25×5 与 41×41×9 一致）', () => {
  for (const m of PRESETS) {
    const coarse = computeMinSwingRadius(m, { samples: 25, psiSamples: 5 });
    const fine = computeMinSwingRadius(m, { samples: 41, psiSamples: 9 });
    assert.ok(
      Math.abs(coarse - fine) < 1,
      `${m.id}: 粗网格 ${coarse.toFixed(1)} 与细网格 ${fine.toFixed(1)} 不一致`,
    );
  }
});

// 独立参考：枚举顶点投影的驻点和两顶点投影相等的方向，再实际旋转斗体。
// 不使用生产代码的预计算支撑值或区间查询，验证优化没有改变 α×Δ 网格的结果。
function referenceMinSwingRadius(p, samples) {
  const shape = bucketLocalShape(p);
  const r = jointRanges(p);
  const period = 2 * Math.PI;
  const candidates = [];
  for (let i = 0; i < shape.length; i++) {
    const [x, y] = shape[i];
    const stationary = Math.atan2(-y, x);
    candidates.push(stationary, stationary + Math.PI);
    for (let j = i + 1; j < shape.length; j++) {
      const dx = x - shape[j][0];
      const dy = y - shape[j][1];
      if (dx === 0 && dy === 0) continue;
      const equalProjection = Math.atan2(-dy, dx) + Math.PI / 2;
      candidates.push(equalProjection, equalProjection + Math.PI);
    }
  }
  let best = Infinity;
  for (let i = 0; i < samples; i++) {
    const alpha = r.alpha[0] + (r.alpha[1] - r.alpha[0]) * i / Math.max(1, samples - 1);
    for (let j = 0; j < samples; j++) {
      const delta = r.delta[0] + (r.delta[1] - r.delta[0]) * j / Math.max(1, samples - 1);
      const pose = solvePose(p, alpha, delta, r.psi[0]);
      const lo = toRad(pose.bucketAbsDeg);
      const hi = lo + toRad(r.psi[1] - r.psi[0]);
      const frontAt = (theta) => Math.max(...bucketPolygon(pose.C, theta, p.bucketRadius, shape).map((pt) => pt.x));
      let bucketFront = Math.min(frontAt(lo), frontAt(hi));
      for (const angle of candidates) {
        const theta = angle + Math.ceil((lo - angle) / period) * period;
        if (theta <= hi + 1e-12) bucketFront = Math.min(bucketFront, frontAt(theta));
      }
      best = Math.min(best, Math.max(
        pose.A.x + p.boomWidth / 2,
        pose.B.x + p.boomWidth / 2,
        Math.max(0, p.platformFront),
        pose.C.x + p.armWidth / 2,
        bucketFront,
      ));
    }
  }
  return best;
}

test('最小回转半径预计算与独立斗体旋转参考一致（单点、粗网格、默认网格）', () => {
  for (const p of PRESETS) {
    for (const samples of [1, 5, 25]) {
      near(computeMinSwingRadius(p, { samples }), referenceMinSwingRadius(p, samples), `${p.id}: ${samples}×${samples} 网格`);
    }
  }
});

test('最小回转半径支持镜像斗形、跨周期朝向与受限铲斗行程', () => {
  for (const base of PRESETS) {
    const mirrored = { ...base };
    for (const key of ['bktCylBodyPerp', 'bktBellPerp', 'bktEPerp', 'bktBranch']) mirrored[key] *= -1;
    for (const p of [mirrored, { ...base, bktCylStroke: 300 }]) {
      const r = jointRanges(p);
      assert.ok(Object.values(r).flat().every(Number.isFinite), `${base.id}: 参考机构必须可解`);
      near(computeMinSwingRadius(p, { samples: 7 }), referenceMinSwingRadius(p, 7), `${base.id}: 镜像或受限行程`);
    }
  }
});

test('最小回转半径就地修改斗形参数后不复用旧支撑值', () => {
  const p = { ...PRESETS[0], bktCylStroke: 300 };
  const initial = computeMinSwingRadius(p, { samples: 7 });
  for (const [key, change] of [['bktEAlong', 20], ['bktEPerp', 20], ['bucketRadius', 100]]) {
    p[key] += change;
    assert.ok(Object.values(jointRanges(p)).flat().every(Number.isFinite));
    near(computeMinSwingRadius(p, { samples: 7 }), referenceMinSwingRadius(p, 7), `改 ${key} 后的支撑值`);
  }
  assert.ok(Math.abs(initial - computeMinSwingRadius(p, { samples: 7 })) > 1, '斗形变化必须实际影响结果');
});

test('包络计算耗时满足实时要求（默认参数单次 < 20 ms）', () => {
  const m = PRESETS[0];
  for (let i = 0; i < 3; i++) computeEnvelope(m); // 预热 JIT
  const N = 8;
  let best = Infinity;
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    computeEnvelope(m);
    best = Math.min(best, performance.now() - t0);
  }
  assert.ok(best < 20, `默认参数下单次包络计算最快 ${best.toFixed(1)} ms，超过 20 ms 预算`);
});
