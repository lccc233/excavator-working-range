import test from 'node:test';
import assert from 'node:assert/strict';

import { armDeltaFromLength, boomAngleFromLength, bucketPsiFromLength } from '../assets/core/cylinders.js';
import { solvePose } from '../assets/core/geometry.js';
import { computeDiggingForces } from '../assets/core/forces.js';
import { clonePreset } from '../assets/core/presets.js';

test('理论挖掘力复现旧页面默认姿态结果', () => {
  const p = clonePreset('x20t');
  p.armLength = 3170;
  const pose = solvePose(
    p,
    boomAngleFromLength(p, 2644),
    armDeltaFromLength(p, 3518),
    bucketPsiFromLength(p, 1734),
  );
  const force = computeDiggingForces(p, pose);
  assert.ok(Math.abs(force.bucketCurlKN - 81.2) < 0.1);
  assert.ok(Math.abs(force.armCrowdKN - 54.8) < 0.1);
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
  assert.deepEqual(computeDiggingForces(p, pose), { bucketCurlKN: 0, armCrowdKN: 0 });
});
