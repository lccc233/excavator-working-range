/**
 * 当前姿态的理论切向挖掘力。
 * 以油缸净液压力乘机构瞬时力传递比，通过虚功关系换算到斗齿切向。
 * 不含结构变形、自重、地面条件、泵流量限制或整机稳定性影响。
 */

import { armCylLength, bucketCylLength } from './cylinders.js';

const area = (diameter) => Math.PI * diameter * diameter / 4;
const DEG = Math.PI / 180;

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
 * @returns {null|{bucketCurlKN:number,armCrowdKN:number}}
 */
export function computeDiggingForces(p, pose) {
  if (!pose || ![pose.deltaDeg, pose.psiDeg, pose.B?.x, pose.B?.y, pose.T?.x, pose.T?.y].every(Number.isFinite)) {
    return null;
  }

  // 铲斗收斗由铲斗油缸缩回驱动；力比 = 缸长变化 / 斗齿绕 C 的切向位移。
  const dBucketLength = derivativePerRadian((psi) => bucketCylLength(p, psi), pose.psiDeg);
  const bucketLever = p.bucketRadius;
  const bucketCurlN = cylinderForceN(
    p, p.bktCylBore, p.bktCylRodDiameter, p.bktCylCount, 'retract',
  ) * Math.abs(dBucketLength) / bucketLever;

  // 斗杆内收由斗杆油缸伸出驱动；斗齿绕 B 的切向运动半径直接取 |B→T|。
  const dArmLength = derivativePerRadian((delta) => armCylLength(p, delta), pose.deltaDeg);
  const armLever = Math.hypot(pose.T.x - pose.B.x, pose.T.y - pose.B.y);
  const armCrowdN = cylinderForceN(
    p, p.armCylBore, p.armCylRodDiameter, p.armCylCount, 'extend',
  ) * Math.abs(dArmLength) / armLever;

  if (!(bucketLever > 0) || !(armLever > 0) || !Number.isFinite(bucketCurlN) || !Number.isFinite(armCrowdN)) {
    return null;
  }
  return { bucketCurlKN: bucketCurlN / 1000, armCrowdKN: armCrowdN / 1000 };
}
