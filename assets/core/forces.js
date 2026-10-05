/**
 * 当前姿态的理论切向挖掘力。
 * 以油缸净液压力乘机构瞬时力传递比，通过虚功关系换算到斗齿切向。
 * 不含结构变形、自重、地面条件、泵流量限制或整机稳定性影响。
 */

import { armCylLength, boomCylLength, bucketCylLength, resolveJointRanges } from './cylinders.js?v=20261005c';

const area = (diameter) => Math.PI * diameter * diameter / 4;
const DEG = Math.PI / 180;
const ANGLE_TOL_DEG = 1e-5;
const LENGTH_TOL_MM = 1e-3;

function reachable(p, pose) {
  const ranges = resolveJointRanges(p);
  for (const [angle, lo, hi, length, prefix] of [
    [pose.alphaDeg, ranges.alphaMin, ranges.alphaMax, boomCylLength(p, pose.alphaDeg), 'boom'],
    [pose.deltaDeg, ranges.deltaMin, ranges.deltaMax, armCylLength(p, pose.deltaDeg), 'arm'],
    [pose.psiDeg, ranges.psiMin, ranges.psiMax, bucketCylLength(p, pose.psiDeg), 'bkt'],
  ]) {
    if (![angle, lo, hi, length].every(Number.isFinite)
      || angle < lo - ANGLE_TOL_DEG || angle > hi + ANGLE_TOL_DEG
      || length < p[`${prefix}CylClosed`] - LENGTH_TOL_MM
      || length > p[`${prefix}CylClosed`] + p[`${prefix}CylStroke`] + LENGTH_TOL_MM) return false;
  }
  return true;
}

function derivativePerRadian(fn, angleDeg) {
  const hDeg = 0.01;
  const plus = fn(angleDeg + hDeg);
  const minus = fn(angleDeg - hDeg);
  if (!Number.isFinite(plus) || !Number.isFinite(minus)) return NaN;
  return (plus - minus) / (2 * hDeg * DEG);
}

function cylinderForceN(p, bore, rod, count, direction) {
  const cap = area(bore);
  const annular = cap - area(rod);
  const pressure = p.forcePressure;
  const backPressure = p.forceBackPressure;
  const active = direction === 'retract' ? annular : cap;
  const returnSide = direction === 'retract' ? cap : annular;
  return Math.max(0, (pressure * active - backPressure * returnSide) * count * p.forceEfficiency);
}

/**
 * @param {object} p 几何与液压参数
 * @param {object|null} pose 当前工作姿态（solvePose 的结果）
 * @returns {null|{bucketCurlKN:number,armCrowdKN:number,bucketCylinderDirection:string,armCylinderDirection:string}}
 */
export function computeDiggingForces(p, pose) {
  if (!pose || ![pose.alphaDeg, pose.deltaDeg, pose.psiDeg, pose.B?.x, pose.B?.y, pose.T?.x, pose.T?.y].every(Number.isFinite)
    || !reachable(p, pose)) {
    return null;
  }

  // 收斗是 ψ 减小（顺时针）。按 dL/dψ 的符号选进油腔；两个预设均为伸缸收斗。
  // 力比 = 缸长变化 / 斗齿绕 C 的切向位移。
  const dBucketLength = derivativePerRadian((psi) => bucketCylLength(p, psi), pose.psiDeg);
  const bucketCylinderDirection = dBucketLength <= 0 ? 'extend' : 'retract';
  const bucketLever = p.bucketRadius;
  const bucketCurlN = cylinderForceN(
    p, p.bktCylBore, p.bktCylRodDiameter, p.bktCylCount, bucketCylinderDirection,
  ) * Math.abs(dBucketLength) / bucketLever;

  // 斗杆内收是 Δ 减小；标准布置为伸缸。斗齿绕 B 的切向半径取 |B→T|。
  const dArmLength = derivativePerRadian((delta) => armCylLength(p, delta), pose.deltaDeg);
  const armCylinderDirection = dArmLength <= 0 ? 'extend' : 'retract';
  const armLever = Math.hypot(pose.T.x - pose.B.x, pose.T.y - pose.B.y);
  const armCrowdN = cylinderForceN(
    p, p.armCylBore, p.armCylRodDiameter, p.armCylCount, armCylinderDirection,
  ) * Math.abs(dArmLength) / armLever;

  if (!(bucketLever > 0) || !(armLever > 0) || !Number.isFinite(bucketCurlN) || !Number.isFinite(armCrowdN)) {
    return null;
  }
  return { bucketCurlKN: bucketCurlN / 1000, armCrowdKN: armCrowdN / 1000, bucketCylinderDirection, armCylinderDirection };
}
