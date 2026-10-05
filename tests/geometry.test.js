/**
 * 运动学与参数校验测试
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  solvePose,
  normalizeDeg,
  toRad,
  toDeg,
  clamp,
  bucketPolygon,
  bucketLocalShape,
  outlinePoints,
  taperedQuad,
} from '../assets/core/geometry.js';
import { defaultParams, clonePreset, PRESETS } from '../assets/core/presets.js';
import { validateParams, sanitizeParams, bucketRotationRange, PARAM_SPEC } from '../assets/core/params.js';
import { resolveJointRanges, clearRangeCache } from '../assets/core/cylinders.js';

const P = defaultParams();

test('角度归一化落在 (-180, 180]', () => {
  assert.equal(normalizeDeg(0), 0);
  assert.equal(normalizeDeg(180), 180);
  assert.equal(normalizeDeg(190), -170);
  assert.equal(normalizeDeg(-190), 170);
  assert.equal(normalizeDeg(360), 0);
  assert.equal(normalizeDeg(540), 180);
  assert.equal(normalizeDeg(-360), 0);
});

test('弧度角度互转往返一致', () => {
  for (const deg of [-179.5, -90, 0, 33.3, 90, 179.9]) {
    assert.ok(Math.abs(toDeg(toRad(deg)) - deg) < 1e-9);
  }
});

test('正运动学：关节角为 0 时三点共线水平', () => {
  const pose = solvePose(P, 0, 0, 0);
  assert.ok(Math.abs(pose.A.y - P.pivotY) < 1e-9);
  assert.ok(Math.abs(pose.B.y - P.pivotY) < 1e-9);
  assert.ok(Math.abs(pose.C.y - P.pivotY) < 1e-9);
  assert.ok(Math.abs(pose.T.y - P.pivotY) < 1e-9);
  assert.ok(Math.abs(pose.B.x - (P.pivotX + P.boomLength)) < 1e-9);
  assert.ok(Math.abs(pose.C.x - (P.pivotX + P.boomLength + P.armLength)) < 1e-9);
  assert.ok(
    Math.abs(pose.T.x - (P.pivotX + P.boomLength + P.armLength + P.bucketRadius)) < 1e-9,
    'A→T 总长应等于三连杆之和',
  );
});

test('正运动学：动臂抬到 90° 时 B 点在 A 正上方', () => {
  const pose = solvePose(P, 90, 0, 0);
  assert.ok(Math.abs(pose.B.x - P.pivotX) < 1e-6, `x 偏差 ${pose.B.x - P.pivotX}`);
  assert.ok(Math.abs(pose.B.y - (P.pivotY + P.boomLength)) < 1e-6);
});

test('正运动学：连杆长度恒定，与关节角无关', () => {
  for (const [a, d, s] of [
    [0, 0, 0],
    [-39, -140, 30],
    [52, -2, -130],
    [-12.5, -77.3, 121.4],
  ]) {
    const pose = solvePose(P, a, d, s);
    const dAB = Math.hypot(pose.B.x - pose.A.x, pose.B.y - pose.A.y);
    const dBC = Math.hypot(pose.C.x - pose.B.x, pose.C.y - pose.B.y);
    const dCT = Math.hypot(pose.T.x - pose.C.x, pose.T.y - pose.C.y);
    assert.ok(Math.abs(dAB - P.boomLength) < 1e-6, `AB=${dAB}`);
    assert.ok(Math.abs(dBC - P.armLength) < 1e-6, `BC=${dBC}`);
    assert.ok(Math.abs(dCT - P.bucketRadius) < 1e-6, `CT=${dCT}`);
  }
});

test('正运动学：斗杆绝对角 = 动臂角 + 相对角', () => {
  const pose = solvePose(P, 20, -60, 45);
  assert.ok(Math.abs(pose.armAbsDeg - (-40)) < 1e-9);
  assert.ok(Math.abs(pose.bucketAbsDeg - 5) < 1e-9);
});

test('斗杆共线时 A、B、C 三点共线', () => {
  const pose = solvePose(P, 15, 0, 0);
  const cross =
    (pose.B.x - pose.A.x) * (pose.C.y - pose.A.y) - (pose.B.y - pose.A.y) * (pose.C.x - pose.A.x);
  const scale = P.boomLength * P.armLength;
  assert.ok(Math.abs(cross) / scale < 1e-9, `共线残差 ${cross}`);
});

test('铲斗转角范围由实际油缸安装距和行程解出', () => {
  for (const m of PRESETS) {
    const r = bucketRotationRange(m);
    assert.ok(Number.isFinite(r.curl) && Number.isFinite(r.dump), `${m.id}: 铲斗端点角度必须有限`);
    assert.ok(r.curl < r.dump, `${m.id}: 顺时针收斗角应小于开斗角`);
    assert.ok(r.max > r.min, `${m.id}: 铲斗角度范围必须大于 0`);
  }
});

test('斗底安装角使「最大挖掘高度 − 最大卸载高度 = 2R3」成立', () => {
  for (const m of PRESETS) {
    if (m.nominal.maxDigHeight == null || m.nominal.dumpHeight == null) continue;
    const diff = m.nominal.maxDigHeight - m.nominal.dumpHeight;
    assert.ok(
      Math.abs(diff - 2 * m.bucketRadius) < 3,
      `${m.id}: 高度差 ${diff} 应对应 2R3=${2 * m.bucketRadius}`,
    );
  }
});

test('参数校验：合法预设全部通过', () => {
  for (const m of PRESETS) {
    const v = validateParams(m);
    assert.ok(v.ok, `${m.id} 校验失败: ${v.errors.join('; ')}`);
  }
});

test('参数校验：能识别几何上不可达的组合', () => {
  // 斗杆油缸行程太短 → 斗杆转角范围够不到「B、C、T 三点竖直」的最大挖掘深度姿态
  const bad = { ...P, armCylStroke: 60 };
  const v = validateParams(bad);
  assert.ok(
    v.warnings.some((w) => w.includes('最大挖掘深度姿态')),
    v.warnings.join('; '),
  );
  clearRangeCache();
  const R = resolveJointRanges(bad);
  const deltaForDepth = -90 - R.alphaMin;
  assert.ok(
    deltaForDepth < R.deltaMin || deltaForDepth > R.deltaMax,
    `行程 60mm 时 Δ 范围 [${R.deltaMin.toFixed(1)}, ${R.deltaMax.toFixed(1)}] 不应覆盖 ${deltaForDepth.toFixed(1)}`,
  );
});

test('参数校验：动臂转角范围过小会被拒绝', () => {
  const v = validateParams({ ...P, boomCylStroke: 25 });
  assert.equal(v.ok, false);
  assert.ok(
    v.errors.some((e) => e.includes('动臂仰角范围')),
    v.errors.join('; '),
  );
});

test('参数校验：铰点高过整链长会被拒绝', () => {
  // 铰点比整条工作装置链还高 → 斗齿尖永远够不到停机面
  const v = validateParams({ ...P, pivotY: 4000, boomLength: 2000, armLength: 1200, bucketRadius: 500 });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('铰点高度')), v.errors.join('; '));
});

test('sanitizeParams 把越界值收敛到规范区间', () => {
  const boomSpec = PARAM_SPEC.find((s) => s.key === 'boomLength');
  const armSpec = PARAM_SPEC.find((s) => s.key === 'armLength');
  const out = sanitizeParams(
    { boomLength: boomSpec.max + 5000, armLength: armSpec.min - 5000 },
    P,
  );
  assert.equal(out.boomLength, boomSpec.max);
  assert.equal(out.armLength, armSpec.min);
});

test('sanitizeParams 忽略非数值与缺字段', () => {
  const out = sanitizeParams({ boomLength: 'abc', armLength: null, boomAngleMax: NaN }, P);
  assert.equal(out.boomLength, P.boomLength);
  assert.equal(out.armLength, P.armLength);
  assert.equal(out.boomAngleMax, P.boomAngleMax);
});

test('sanitizeParams 不会把未提供字段清零', () => {
  const out = sanitizeParams({}, P);
  for (const spec of PARAM_SPEC) assert.equal(out[spec.key], P[spec.key], spec.key);
});

test('预设的每个参数都必须落在滑块区间内（否则界面会把它夹到边界）', () => {
  // 这条守卫的价值：参数规范收窄区间时，若预设值没跟着改，sanitizeParams 会把它
  // 悄悄夹到边界——界面显示的就不是预设几何了，指标也跟着漂。
  for (const m of PRESETS) {
    for (const spec of PARAM_SPEC) {
      const v = m[spec.key];
      if (v === undefined) continue;
      assert.ok(
        v >= spec.min && v <= spec.max,
        `${m.id} 的 ${spec.key} = ${v} 超出区间 [${spec.min}, ${spec.max}]`,
      );
    }
  }
});

test('taperedQuad 生成四个顶点且宽度符合预期', () => {
  const q = taperedQuad({ x: 0, y: 0 }, { x: 100, y: 0 }, 10, 20);
  assert.equal(q.length, 4);
  const ys = q.map((p) => p.y).sort((a, b) => a - b);
  assert.deepEqual(ys, [-10, -5, 5, 10]);
});

test('铲斗轮廓顶点数量固定且均有限', () => {
  const pts = bucketPolygon({ x: 0, y: 0 }, toRad(30), 1000, bucketLocalShape(P));
  assert.ok(pts.length >= 6);
  for (const pt of pts) {
    assert.ok(Number.isFinite(pt.x) && Number.isFinite(pt.y));
  }
});

/**
 * 斗形验收：一个「切掉一部分的半圆」。
 *   直边（直径）躺在 C→T 直线上，齿尖 T 是未被切掉的直边端点，
 *   切除线与直边的交点是铲斗铰点 C（严格落在直边内部，不是端点），
 *   切除线的另一端 E 落在圆弧上 = 连杆–铲斗铰点。
 */
for (const p of [...PRESETS, defaultParams()]) {
  test(`铲斗外形是切掉一部分的半圆，T/C/E 三个特征点与机构一致（${p.id}）`, () => {
    const R3 = p.bucketRadius;
    const ex = p.bktEAlong / R3;
    const ey = p.bktEPerp / R3;
    const shape = bucketLocalShape(p);

    // ① 点序：C（铲斗铰点）→ T（齿尖）→ 圆弧 → E（连杆铰点）
    assert.deepEqual(shape[0], [0, 0], '轮廓首点应为铲斗铰点 C');
    assert.deepEqual(shape[1], [1, 0], '轮廓第 2 点应为斗齿尖 T = (1, 0)');
    const E = shape[shape.length - 1];
    assert.ok(Math.abs(E[0] - ex) < 1e-12 && Math.abs(E[1] - ey) < 1e-12, '轮廓末点应为连杆铰点 E');

    // ② 未被切掉的直边 C–T 长度恒为 1（即 bucketRadius，与指标口径一致）
    assert.ok(Math.abs(Math.hypot(shape[1][0] - shape[0][0], shape[1][1] - shape[0][1]) - 1) < 1e-12);

    // ③ 圆心在直边所在直线上 → 圆弧各点到圆心等距，半径 R = |1 − m|
    const m = (1 - ex * ex - ey * ey) / (2 * (1 - ex));
    const R = Math.abs(1 - m);
    for (const [x, y] of shape.slice(2)) {
      assert.ok(Math.abs(Math.hypot(x - m, y) - R) < 1e-12, `圆弧点 (${x}, ${y}) 不在圆上`);
    }

    // ④ 直边另一端 Q 已被切掉，且 C 严格落在直边内部 —— 即「切除线与直边相交」而非相交于端点
    const Q = 2 * m - 1;
    assert.ok(Q < -1e-9, `直边另一端 Q.x=${Q} 应落在 C 之后（C 必须在直边内部）`);
    const onAxis = shape.filter(([, y]) => Math.abs(y) < 1e-12);
    assert.equal(onAxis.length, 2, '直边上只剩 C–T 一段：被切掉的 Q–C 段不应出现在轮廓里');

    // ⑤ 圆弧只凸向 E 所在的一侧（E 在下半平面时圆弧也应在下半平面）
    const side = Math.sign(ey) || 1;
    for (const [, y] of shape.slice(2)) assert.ok(y * side > -1e-12, '圆弧越到了 E 的另一侧');
  });
}

test('铲斗轮廓把齿尖 T 映射到机构的 T 点（同一姿态、同一 C 点）', () => {
  const pose = solvePose(P, 20, -55, 35);
  const local = bucketLocalShape(P);
  const poly = bucketPolygon(pose.C, toRad(pose.bucketAbsDeg), P.bucketRadius, local);
  const tip = poly[1]; // 第 2 点就是齿尖
  assert.ok(Math.abs(tip.x - pose.T.x) < 1e-9 && Math.abs(tip.y - pose.T.y) < 1e-9, '轮廓齿尖应与 solvePose 的 T 重合');
  const hinge = poly[0];
  assert.ok(Math.abs(hinge.x - pose.C.x) < 1e-9 && Math.abs(hinge.y - pose.C.y) < 1e-9, '轮廓首点应与 C 重合');
});

test('outlinePoints 在给定姿态下返回有限点集', () => {
  const pose = solvePose(P, 30, -60, 20);
  const pts = outlinePoints(P, pose);
  assert.ok(pts.length > 10);
  for (const pt of pts) assert.ok(Number.isFinite(pt.x) && Number.isFinite(pt.y));
});

test('clonePreset 返回独立副本，改动不影响常量表', () => {
  const a = clonePreset('x20t');
  a.boomLength = 1;
  a.nominal.maxDigDepth = 1;
  const b = clonePreset('x20t');
  assert.equal(b.boomLength, 5700);
  assert.equal(b.nominal.maxDigDepth, 6600);
});

test('clamp 边界行为', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(11, 0, 10), 10);
});
