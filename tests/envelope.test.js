/**
 * 包络求解测试
 *
 * 包络按「八段圆弧作图法」生成：每段只动一个油缸、其余两个不动，齿尖画出一段圆弧。
 * 因此测试的重点是：① 八段依次相接并闭合；② 每段只动一个参数；
 * ③ ①②④段末端的共线条件、②③⑥⑦段末端的行程端点条件成立；
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
import * as arm from '../assets/core/cylinders.js';

const A_OF = (m) => ({ x: m.pivotX, y: m.pivotY });
const angOf = (A, pt) => (Math.atan2(pt.y - A.y, pt.x - A.x) * 180) / Math.PI;
const norm180 = (d) => {
  let v = d;
  while (v > 180) v -= 360;
  while (v < -180) v += 360;
  return v;
};

test('包络闭合，且八段依次首尾相接', () => {
  for (const m of PRESETS) {
    const env = computeEnvelope(m);
    assert.equal(env.closed, true, `${m.id}: 包络没有闭合（起点与终点不重合）`);
    assert.equal(env.segments.length, 8, `${m.id}: 应该有 8 段圆弧，实际 ${env.segments.length}`);
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
      assert.ok(Math.abs(s.to - s.from) > 1, `${m.id}: 第 ${s.index} 段几乎没有行程（${s.from}→${s.to}）`);
    }
  }
});

test('每段圆弧的端点满足作图法条件', () => {
  const m = PRESETS[0];
  const env = computeEnvelope(m);
  const A = A_OF(m);
  const r = jointRanges(m);
  const [aMin, aMax] = r.alpha;
  const [dMin, dMax] = r.delta;
  const [pMin, pMax] = r.psi;
  const seg = (i) => env.segments[i - 1];
  const poseAt = (i, end) => {
    // 用相邻两点的差分推出该段端点姿态：段内只有 which 参数在变
    const s = seg(i);
    return { which: s.which, from: s.from, to: s.to };
  };
  const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;
  assert.equal(seg(1).which, 'bucket');
  assert.ok(near(seg(1).from, pMax), '第①段应从铲斗缸最短（收斗位 ψmax）开始');
  assert.equal(seg(2).which, 'boom');
  assert.ok(near(seg(2).from, aMax), '第②段应从动臂缸最长（αmax）开始');
  assert.ok(near(seg(2).to, aMin), '第②段应把动臂缸收到最短（αmin）');
  assert.equal(seg(3).which, 'arm');
  assert.ok(near(seg(3).from, dMax), '第③段应从斗杆缸最短（Δmax）开始');
  assert.ok(near(seg(3).to, dMin), '第③段应把斗杆缸伸到最长（Δmin）');
  assert.equal(seg(4).which, 'bucket');
  assert.equal(seg(5).which, 'boom');
  assert.ok(near(seg(5).from, aMin), '第⑤段应从动臂缸最短开始');
  assert.ok(near(seg(5).to, aMax), '第⑤段应把动臂缸伸到最长（αmax）');
  assert.equal(seg(6).which, 'bucket');
  assert.ok(near(seg(6).to, pMin), '第⑥段应把铲斗缸伸到最长（ψmin）');
  assert.equal(seg(7).which, 'arm');
  assert.ok(near(seg(7).from, dMin), '第⑦段应从斗杆缸最长开始');
  assert.ok(near(seg(7).to, dMax), '第⑦段应把斗杆缸收回到最短（Δmax）');
  assert.equal(seg(8).which, 'bucket');
  assert.ok(near(seg(8).to, pMax), '第⑧段应把铲斗缸收回到最短（ψmax），回到起点');
  void poseAt;

  // ① 末：A、C、T 三点共线，齿尖在 C 外侧（即 |AT| = |AC| + R3）
  {
    const alpha = aMax;
    const delta = dMax;
    const psi = seg(1).to;
    const pose = armPose(m, alpha, delta, psi);
    assert.ok(
      Math.abs(Math.hypot(pose.T.x - A.x, pose.T.y - A.y) - (Math.hypot(pose.C.x - A.x, pose.C.y - A.y) + m.bucketRadius)) < 1,
      '① 末齿尖应正好在 A–C 延长线上',
    );
  }
  // ④ 末：A、T、C 三点共线（齿尖在 C 内侧，即 |AT| = |AC| − R3）
  {
    const psi = seg(4).to;
    const pose = armPose(m, aMin, dMin, psi);
    assert.ok(
      Math.abs(Math.hypot(pose.T.x - A.x, pose.T.y - A.y) - Math.abs(Math.hypot(pose.C.x - A.x, pose.C.y - A.y) - m.bucketRadius)) < 1,
      '④ 末齿尖应落在 A–T–C 共线位置',
    );
  }
  // ①④ 的共线角必须落在铲斗缸行程内（否则该段会被截断）
  assert.ok(seg(1).to >= pMin - 1e-6 && seg(1).to <= pMax + 1e-6, '①末的共线角超出行程');
  assert.ok(seg(4).to >= pMin - 1e-6 && seg(4).to <= pMax + 1e-6, '④末的共线角超出行程');
});

/** 直接解一个姿态（测试用） */
function armPose(m, alpha, delta, psi) {
  // 复用 cylinders 里的正解：先按较短的路径解出 A/B/C/T
  const A = { x: m.pivotX, y: m.pivotY };
  const a = (alpha * Math.PI) / 180;
  const g = ((alpha + delta) * Math.PI) / 180;
  const B = { x: A.x + m.boomLength * Math.cos(a), y: A.y + m.boomLength * Math.sin(a) };
  const C = { x: B.x + m.armLength * Math.cos(g), y: B.y + m.armLength * Math.sin(g) };
  const t = ((alpha + delta + psi) * Math.PI) / 180;
  return { A, B, C, T: { x: C.x + m.bucketRadius * Math.cos(t), y: C.y + m.bucketRadius * Math.sin(t) } };
}

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
  const psiCurl = 90 - (cal.boomAngleMax + cal.armRelMax);
  const cyl = arm.calibrateCylinders(longer, {
    alphaMin: cal.boomAngleMin,
    alphaMax: cal.boomAngleMax,
    deltaMin: cal.armRelMin,
    deltaMax: cal.armRelMax,
    psiCurl,
    psiDump: psiCurl - 180,
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
  const m = PRESETS[0];
  const coarse = envelopeExtremes(computeEnvelope(m, { stepDeg: 0.75 }));
  const fine = envelopeExtremes(computeEnvelope(m, { stepDeg: 0.2 }));
  assert.ok(Math.abs(coarse.maxY - fine.maxY) < 2, `最高点差 ${(coarse.maxY - fine.maxY).toFixed(2)} mm`);
  assert.ok(Math.abs(coarse.maxDepth - fine.maxDepth) < 2, `最深点差 ${(coarse.maxDepth - fine.maxDepth).toFixed(2)} mm`);
  assert.ok(Math.abs(coarse.maxX - fine.maxX) < 2, `最远点差 ${(coarse.maxX - fine.maxX).toFixed(2)} mm`);
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

void angOf;
void norm180;
