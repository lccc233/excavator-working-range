import test from 'node:test';
import assert from 'node:assert/strict';

import { armDeltaFromLength, boomAngleFromLength, bucketPsiFromLength, cylinderPose, resolveJointRanges } from '../assets/core/cylinders.js';
import { solvePose } from '../assets/core/geometry.js';
import { computeDiggingForces } from '../assets/core/forces.js';
import { clonePreset, PRESETS } from '../assets/core/presets.js';

test('回归：旧页面姿态的收斗力使用无杆腔，斗杆力保持正确', () => {
  const p = clonePreset('x20t');
  p.armLength = 3170;
  const pose = solvePose(
    p,
    boomAngleFromLength(p, 2644),
    armDeltaFromLength(p, 3518),
    bucketPsiFromLength(p, 1734),
  );
  const force = computeDiggingForces(p, pose);
  assert.ok(Math.abs(force.bucketCurlKN - 148.844726) < 1e-4);
  assert.ok(Math.abs(force.armCrowdKN - 54.8) < 0.1);
});

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const cross = (a, b) => a.x * b.y - a.y * b.x;
const norm = (v) => Math.hypot(v.x, v.y);
const unit = (v) => ({ x: v.x / norm(v), y: v.y / norm(v) });
const scale = (v, s) => ({ x: v.x * s, y: v.y * s });

// Independent reference: solve equilibrium at pin P and moments about C/B.
// This does not differentiate cylinder lengths or call the force implementation.
function pinStatics(p, pose, bucketExtend = true) {
  const pins = cylinderPose(p, pose);
  const netForce = (prefix, extend) => {
    const cap = Math.PI * p[`${prefix}CylBore`] ** 2 / 4;
    const annular = cap - Math.PI * p[`${prefix}CylRodDiameter`] ** 2 / 4;
    return (p.forcePressure * (extend ? cap : annular) - p.forceBackPressure * (extend ? annular : cap))
      * p.forceEfficiency * p[`${prefix}CylCount`];
  };
  const rocker = unit(sub(pins.rocker.joint, pins.rocker.pivot));
  const link = unit(sub(pins.link.to, pins.link.from));
  const actuator = unit(sub(pins.bucket.rod, pins.bucket.body));
  const force = scale(actuator, netForce('bkt', bucketExtend) * (bucketExtend ? 1 : -1));
  const linkForce = -cross(rocker, force) / cross(rocker, link);
  const bucketTorque = cross(sub(pins.link.to, pose.C), scale(link, -linkForce));
  const armForce = scale(unit(sub(pins.arm.rod, pins.arm.body)), netForce('arm', true));
  const armTorque = cross(sub(pins.arm.rod, pose.B), armForce);
  return {
    bucketTorque, armTorque,
    bucketKN: -bucketTorque / p.bucketRadius / 1000,
    armKN: -armTorque / norm(sub(pose.T, pose.B)) / 1000,
  };
}

function strokePose(p, fraction) {
  return solvePose(p,
    boomAngleFromLength(p, p.boomCylClosed + p.boomCylStroke * fraction),
    armDeltaFromLength(p, p.armCylClosed + p.armCylStroke * fraction),
    bucketPsiFromLength(p, p.bktCylClosed + p.bktCylStroke * fraction));
}

test('两个预设全行程的收斗/斗杆力与销轴静力平衡一致，力矩均为顺时针', () => {
  for (const p of PRESETS) {
    for (let i = 0; i <= 40; i++) {
      const pose = strokePose(p, i / 40);
      const actual = computeDiggingForces(p, pose);
      const reference = pinStatics(p, pose);
      assert.ok(actual, `${p.id} stroke=${i}/40: 可达姿态必须产生力值`);
      assert.ok(reference.bucketTorque < 0 && reference.armTorque < 0, `${p.id}: 收斗/内收应为顺时针力矩`);
      assert.ok(Math.abs(actual.bucketCurlKN - reference.bucketKN) < reference.bucketKN * 1e-5);
      assert.ok(Math.abs(actual.armCrowdKN - reference.armKN) < reference.armKN * 1e-5);
    }
  }
});

test('E215 默认姿态收斗理论力为约 100.7 kN', () => {
  const p = clonePreset('E215HC4488A06A0');
  const R = resolveJointRanges(p);
  const pose = solvePose(p, R.alphaMin + (R.alphaMax - R.alphaMin) * 0.76, -80,
    R.psiMax - (R.psiMax - R.psiMin) * 0.22);
  const force = computeDiggingForces(p, pose);
  assert.ok(Math.abs(force.bucketCurlKN - 100.697587) < 1e-4);
  assert.ok(Math.abs(force.armCrowdKN - 81.969294) < 1e-4);
});

test('镜像铲斗安装几何按实际收斗方向选择有杆腔', () => {
  const p = clonePreset('x20t');
  for (const key of ['bktCylBodyPerp', 'bktBellPerp', 'bktEPerp', 'bktBranch']) p[key] *= -1;
  const pose = strokePose(p, 0.5);
  const actual = computeDiggingForces(p, pose);
  const reference = pinStatics(p, pose, false);
  assert.ok(actual);
  assert.ok(reference.bucketTorque < 0);
  assert.equal(actual.bucketCylinderDirection, 'retract');
  assert.ok(Math.abs(actual.bucketCurlKN - reference.bucketKN) < reference.bucketKN * 1e-5);
});

test('拒绝油缸行程外的动臂、斗杆、铲斗姿态', () => {
  const p = clonePreset('E215HC4488A06A0');
  const R = resolveJointRanges(p);
  const good = strokePose(p, 0.5);
  for (const [alpha, delta, psi] of [
    [R.alphaMax + 1, good.deltaDeg, good.psiDeg],
    [good.alphaDeg, R.deltaMin - 1, good.psiDeg],
    [good.alphaDeg, good.deltaDeg, 63.74], // 旧垂直贴壁姿态要求缸长约 1601 mm，小于安装距 1655。
  ]) assert.equal(computeDiggingForces(p, solvePose(p, alpha, delta, psi)), null);
});

test('另一装配支即使缸长可行也不能作为当前机器的姿态', () => {
  const p = clonePreset('E215HC4488A06A0');
  const good = strokePose(p, 0.5);
  const bodyAngle = Math.atan2(p.armCylBodyPerp, p.armCylBodyAlong) * 180 / Math.PI;
  const rodAngle = Math.atan2(p.armCylRodPerp, p.armCylRodAlong) * 180 / Math.PI;
  const alternate = 2 * (bodyAngle - rodAngle) - good.deltaDeg;
  assert.equal(computeDiggingForces(p, solvePose(p, good.alphaDeg, alternate, good.psiDeg)), null);
});

test('净液压力按回油侧面积扣背压，效率与数量只各乘一次', () => {
  const p = clonePreset('E215HC4488A06A0');
  p.forceBackPressure = 2;
  p.forceEfficiency = 0.75;
  p.armCylCount = 2;
  p.bktCylCount = 3;
  const pose = strokePose(p, 0.5);
  const actual = computeDiggingForces(p, pose);
  const reference = pinStatics(p, pose);
  assert.ok(Math.abs(actual.bucketCurlKN - reference.bucketKN) < 1e-4);
  assert.ok(Math.abs(actual.armCrowdKN - reference.armKN) < 1e-4);
});

test('空姿态与非有限角度不输出挖掘力', () => {
  const p = clonePreset('x20t');
  const good = strokePose(p, 0.5);
  assert.equal(computeDiggingForces(p, null), null);
  assert.equal(computeDiggingForces(p, { ...good, alphaDeg: NaN }), null);
});

test('E215 采用图纸缸径、杆径时当前姿态力值有限', () => {
  const p = clonePreset('E215HC4488A06A0');
  const a = p.calculatedAngles;
  const pose = solvePose(p, a.boom.retracted, a.armRelative.retracted, a.bucketRelative.retracted);
  const force = computeDiggingForces(p, pose);
  assert.ok(Number.isFinite(force.bucketCurlKN) && force.bucketCurlKN > 0);
  assert.ok(Number.isFinite(force.armCrowdKN) && force.armCrowdKN > 0);
});

test('液压压力为零时不产生理论挖掘力', () => {
  const p = clonePreset('E215HC4488A06A0');
  p.forcePressure = 0;
  p.forceBackPressure = 0;
  const a = p.calculatedAngles;
  const pose = solvePose(p, a.boom.retracted, a.armRelative.retracted, a.bucketRelative.retracted);
  assert.deepEqual(computeDiggingForces(p, pose), {
    bucketCurlKN: 0, armCrowdKN: 0, bucketCylinderDirection: 'extend', armCylinderDirection: 'extend',
  });
});
