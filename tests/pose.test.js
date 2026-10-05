/**
 * 「工作姿态（可调）」测试
 * ==========================================================================
 * 界面上三个滑块直接给的是油缸长度，范围 = 安装距（全缩）~ 安装距 + 行程（全伸）。
 * 这里守住三件事：
 *   1. 滑块的量程与油缸的安装距 / 行程一致，端点正好对应关节角的极值；
 *   2. 长度 → 关节角 → 长度 能往返（否则拖动滑块时姿态会跳）；
 *   3. 超出量程的输入被收敛到端点，而不是产生 NaN 或飞出姿态。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { PRESETS } from '../assets/core/presets.js';
import { computeMetrics } from '../assets/core/metrics.js';
import { jointRanges, bucketRotationRange } from '../assets/core/params.js';
import {
  boomCylLength,
  armCylLength,
  bucketCylLength,
  resolveJointRanges,
  clearRangeCache,
} from '../assets/core/cylinders.js';
import { resolvePose, cylinderLengthRange, poseCylinderLengths } from '../assets/ui/draw.js';

const KINDS = [
  { kind: 'boom', key: 'boomL', length: boomCylLength, angle: (pose) => pose.alphaDeg },
  { kind: 'arm', key: 'armL', length: armCylLength, angle: (pose) => pose.deltaDeg },
  { kind: 'bkt', key: 'bktL', length: bucketCylLength, angle: (pose) => pose.psiDeg },
];

test('油缸长度量程 = [安装距, 安装距 + 行程]', () => {
  for (const m of PRESETS) {
    for (const { kind } of KINDS) {
      const r = cylinderLengthRange(m, kind);
      const closed = m[`${kind}CylClosed`];
      const stroke = m[`${kind}CylStroke`];
      assert.equal(r.min, Math.min(closed, closed + stroke), `${m.id}/${kind}`);
      assert.equal(r.max, Math.max(closed, closed + stroke), `${m.id}/${kind}`);
      assert.ok(r.max > r.min, `${m.id}/${kind}: 量程必须为正`);
    }
  }
});

test('滑块量程端点 = 关节角的行程端点', () => {
  for (const m of PRESETS) {
    clearRangeCache();
    const R = resolveJointRanges(m);
    const b = bucketRotationRange(m);
    const cases = [
      ['boom', boomCylLength(m, R.alphaMin), m.boomCylClosed],
      ['boom', boomCylLength(m, R.alphaMax), m.boomCylClosed + m.boomCylStroke],
      ['arm', armCylLength(m, R.deltaMax), m.armCylClosed],
      ['arm', armCylLength(m, R.deltaMin), m.armCylClosed + m.armCylStroke],
      ['bkt', bucketCylLength(m, R.psiRetracted), m.bktCylClosed],
      ['bkt', bucketCylLength(m, R.psiExtended), m.bktCylClosed + m.bktCylStroke],
    ];
    for (const [kind, got, want] of cases) {
      assert.ok(Math.abs(got - want) < 1, `${m.id}/${kind}: ${got.toFixed(1)} vs ${want.toFixed(1)}`);
    }
    void b;
  }
});

test('给油缸长度能解出姿态，且长度能原样算回来（往返一致）', () => {
  for (const m of PRESETS) {
    const { poses } = computeMetrics(m);
    for (const { kind, key, length } of KINDS) {
      const r = cylinderLengthRange(m, kind);
      for (const f of [0, 0.25, 0.5, 0.75, 1]) {
        const L = r.min + (r.max - r.min) * f;
        const pose = resolvePose(m, { poseMode: 'custom', customPose: { [key]: L } }, poses);
        const back = length(m, kind === 'bkt' ? pose.psiDeg : kind === 'arm' ? pose.deltaDeg : pose.alphaDeg);
        assert.ok(Math.abs(back - L) < 1, `${m.id}/${kind} 行程 ${(f * 100).toFixed(0)}%：给 ${L.toFixed(1)} 解回来 ${back.toFixed(1)}`);
        for (const k of ['A', 'B', 'C', 'T']) {
          assert.ok(Number.isFinite(pose[k].x) && Number.isFinite(pose[k].y), `${m.id}/${kind}: ${k} 坐标非有限`);
        }
      }
    }
  }
});

test('三个油缸一起给长度时姿态唯一且各缸长度都对得上', () => {
  for (const m of PRESETS) {
    const { poses } = computeMetrics(m);
    const rb = cylinderLengthRange(m, 'boom');
    const ra = cylinderLengthRange(m, 'arm');
    const rk = cylinderLengthRange(m, 'bkt');
    const customPose = {
      boomL: rb.min + (rb.max - rb.min) * 0.7,
      armL: ra.min + (ra.max - ra.min) * 0.35,
      bktL: rk.min + (rk.max - rk.min) * 0.6,
    };
    const pose = resolvePose(m, { poseMode: 'custom', customPose }, poses);
    const lens = poseCylinderLengths(m, pose);
    assert.ok(Math.abs(lens.boomL - customPose.boomL) < 1, `${m.id}: 动臂缸 ${lens.boomL.toFixed(1)}`);
    assert.ok(Math.abs(lens.armL - customPose.armL) < 1, `${m.id}: 斗杆缸 ${lens.armL.toFixed(1)}`);
    assert.ok(Math.abs(lens.bktL - customPose.bktL) < 1, `${m.id}: 铲斗缸 ${lens.bktL.toFixed(1)}`);
  }
});

test('超出量程的油缸长度收敛到端点，不产生 NaN', () => {
  for (const m of PRESETS) {
    const { poses } = computeMetrics(m);
    for (const { kind, key, length } of KINDS) {
      const r = cylinderLengthRange(m, kind);
      for (const L of [r.min - 5000, r.max + 5000, NaN]) {
        const pose = resolvePose(m, { poseMode: 'custom', customPose: { [key]: L } }, poses);
        for (const k of ['A', 'B', 'C', 'T']) {
          assert.ok(Number.isFinite(pose[k].x) && Number.isFinite(pose[k].y), `${m.id}/${kind} L=${L}: ${k} 非有限`);
        }
        const actual = length(m, kind === 'bkt' ? pose.psiDeg : kind === 'arm' ? pose.deltaDeg : pose.alphaDeg);
        assert.ok(actual >= r.min - 1 && actual <= r.max + 1, `${m.id}/${kind} L=${L}: 实到长度 ${actual.toFixed(1)} 越界`);
      }
    }
  }
});

test('关节角直接给值的老用法仍然有效（分享链接兼容）', () => {
  const m = PRESETS[0];
  const { poses } = computeMetrics(m);
  const pose = resolvePose(m, { poseMode: 'custom', customPose: { alpha: 20, delta: -70, psi: -40 } }, poses);
  assert.ok(Math.abs(pose.alphaDeg - 20) < 1e-9);
  assert.ok(Math.abs(pose.deltaDeg + 70) < 1e-9);
  const R = jointRanges(m);
  assert.ok(pose.alphaDeg >= R.alpha[0] - 1e-9 && pose.alphaDeg <= R.alpha[1] + 1e-9);
});
