/**
 * 油缸—连杆机构测试
 * ==========================================================================
 * 除了正反解、单调性这些常规项，这里有一条专门的回归测试：
 * 「就地修改参数后关节角范围必须跟着变」。
 * 之前 resolveJointRanges 用 WeakMap 按对象身份缓存，而界面滑块是就地改
 * 同一个对象的，结果第一次算完就把范围钉死了——拖油缸行程滑块时图与指标
 * 纹丝不动。改用取值签名缓存后修复，这条测试守住它不再复发。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { PRESETS, clonePreset, getPreset } from '../assets/core/presets.js';
import {
  boomCylLength,
  boomAngleFromLength,
  armCylLength,
  armDeltaFromLength,
  armRodPerpInBoom,
  armRodPerpSpan,
  bucketCylLength,
  bucketPsiFromLength,
  resolveJointRanges,
  clearRangeCache,
  calibrateCylinders,
  cylinderPose,
  verifyCylinderLayout,
} from '../assets/core/cylinders.js';
import { jointRanges, bucketRotationRange, validateParams } from '../assets/core/params.js';
import { computeMetrics } from '../assets/core/metrics.js';

test('动臂油缸正反解互逆', () => {
  for (const m of PRESETS) {
    const R = resolveJointRanges(m);
    for (let i = 0; i <= 20; i++) {
      const alpha = R.alphaMin + ((R.alphaMax - R.alphaMin) * i) / 20;
      const L = boomCylLength(m, alpha);
      assert.ok(Number.isFinite(L), `${m.id} α=${alpha} 缸长非有限`);
      const back = boomAngleFromLength(m, L);
      assert.ok(Math.abs(back - alpha) < 1e-6, `${m.id} α=${alpha.toFixed(3)} 反解 ${back.toFixed(3)}`);
    }
  }
});

test('斗杆油缸正反解互逆', () => {
  for (const m of PRESETS) {
    const R = resolveJointRanges(m);
    for (let i = 0; i <= 20; i++) {
      const d = R.deltaMin + ((R.deltaMax - R.deltaMin) * i) / 20;
      const L = armCylLength(m, d);
      const back = armDeltaFromLength(m, L);
      assert.ok(Math.abs(back - d) < 1e-6, `${m.id} Δ=${d.toFixed(3)} 反解 ${back.toFixed(3)}`);
    }
  }
});

test('斗杆装配支：活塞杆端全程在动臂两端点连线 A–B 上方', () => {
  // 真机斗杆油缸装在动臂上表面，活塞杆端铰点全程高于 A–B 连线。
  // 这一条同时定出圆交点里哪一支是本机装配支（见 cylinders.js 的 armBranchInfo）。
  for (const m of PRESETS) {
    clearRangeCache();
    const span = armRodPerpSpan(m);
    assert.ok(
      span.above,
      `${m.id}: 杆端应全程在 A–B 连线上方，实测 ${span.min.toFixed(0)}~${span.max.toFixed(0)} mm`,
    );
    const R = resolveJointRanges(m);
    for (let i = 0; i <= 100; i++) {
      const d = R.deltaMin + ((R.deltaMax - R.deltaMin) * i) / 100;
      assert.ok(armRodPerpInBoom(m, d) > 0, `${m.id}: Δ=${d.toFixed(2)}° 处杆端落到 A–B 连线下方`);
    }
  }
});

test('回归：斗杆反解不得选到 A–B 连线下方那一支', () => {
  // 改造前按 dL/dΔ 符号「逐缸长」判支，这组参数会把杆端全程放在连线下方
  // （201 个采样点全部在下方），图上表现为斗杆整支翻到动臂另一侧。
  // 现在支由安装几何一次定死、全程沿用，因此既要全程在上方，又不能中途跳支。
  const p = {
    ...clonePreset('x20t'),
    boomLength: 7300,
    armCylBodyAlong: -4325,
    armCylBodyPerp: 1180,
    armCylRodAlong: -1525,
    armCylRodPerp: 225,
    armCylClosed: 3075,
    armCylStroke: 1400,
  };
  clearRangeCache();
  const span = armRodPerpSpan(p);
  assert.ok(span.above, `装配支应全程在连线上方，实测 ${span.min.toFixed(0)}~${span.max.toFixed(0)} mm`);

  const Lc = Math.min(p.armCylClosed, p.armCylClosed + p.armCylStroke);
  const Lo = Math.max(p.armCylClosed, p.armCylClosed + p.armCylStroke);
  let prev = null;
  let dir = 0;
  for (let i = 0; i <= 200; i++) {
    const L = Lc + ((Lo - Lc) * i) / 200;
    const d = armDeltaFromLength(p, L);
    assert.ok(Number.isFinite(d), `L=${L.toFixed(0)} 反解非有限`);
    assert.ok(armRodPerpInBoom(p, d) > 0, `L=${L.toFixed(0)} 反解 Δ=${d.toFixed(2)}° 落在 A–B 连线下方`);
    if (prev !== null) {
      const s = Math.sign(d - prev);
      if (s !== 0) {
        if (!dir) dir = s;
        else assert.equal(s, dir, `L→Δ 在 L=${L.toFixed(0)} 处折返——中途跳支了`);
      }
    }
    prev = d;
  }
});

test('约束无法满足时：布置自检要报出来，反解仍给出有限值', () => {
  // 安装点/行程本身装不出「杆端全程在 A–B 连线上方」的姿态时，两支都不满足口径，
  // 这时退回设计支判据，但必须报出来——而不是悄悄给一支错解。
  const p = {
    ...clonePreset('x20t'),
    boomLength: 6700,
    armCylBodyAlong: -1225,
    armCylBodyPerp: 955,
    armCylRodAlong: -1250,
    armCylRodPerp: 25,
    armCylClosed: 1725,
    armCylStroke: 950,
  };
  clearRangeCache();
  assert.equal(armRodPerpSpan(p).above, false, '这组参数本就不满足口径，above 应为 false');
  assert.ok(Number.isFinite(armDeltaFromLength(p, p.armCylClosed)), '反解仍须给出有限值');

  const check = verifyCylinderLayout(p).checks.find((c) => c.key === 'armRodAbove');
  assert.ok(check && check.ok === false, '布置自检应报出「活塞杆端在 A–B 连线上方」不通过');
  const v = validateParams(p);
  assert.ok(v.warnings.some((w) => w.includes('动臂两端点连线')), v.warnings.join('; '));
  // 指标不能把 NaN 带进图与表
  for (const [k, val] of Object.entries(computeMetrics(p).values)) {
    assert.ok(Number.isFinite(val), `${k} 出现非有限值`);
  }
});

test('回归：就地改参数后斗杆装配支立即更新（支缓存不能按对象身份钉死）', () => {
  clearRangeCache();
  const p = clonePreset('x20t');
  const before = armRodPerpSpan(p);
  assert.equal(before.above, true);
  assert.equal(before.branch, -1);

  // 模拟界面滑块：就地改同一个对象（各值都在参数面板的区间内），且不清缓存
  Object.assign(p, {
    armCylBodyAlong: -400,
    armCylBodyPerp: 1950,
    armCylRodAlong: -1250,
    armCylRodPerp: 125,
    armCylClosed: 950,
    armCylStroke: 725,
  });
  const after = armRodPerpSpan(p);
  assert.equal(after.above, true, '新安装几何仍应满足口径');
  assert.equal(after.branch, 1, `装配支应翻到另一支，实为 ${after.branch}（支缓存被钉死了？）`);
  assert.notEqual(after.min, before.min, '支内垂直距离应随新几何重算');
  assert.ok(Number.isFinite(armDeltaFromLength(p, p.armCylClosed)), '反解应给出有限值');
});

test('铲斗油缸正反解互逆', () => {
  for (const m of PRESETS) {
    const b = bucketRotationRange(m);
    for (let i = 0; i <= 20; i++) {
      const psi = b.min + ((b.max - b.min) * i) / 20;
      const L = bucketCylLength(m, psi);
      assert.ok(Number.isFinite(L), `${m.id} ψ=${psi.toFixed(2)} 缸长非有限`);
      const back = bucketPsiFromLength(m, L);
      assert.ok(Number.isFinite(back), `${m.id} ψ=${psi.toFixed(2)} 反解非有限`);
      let d = Math.abs(back - psi);
      if (d > 180) d = 360 - d;
      assert.ok(d < 0.01, `${m.id} ψ=${psi.toFixed(2)} 反解 ${back.toFixed(2)}，差 ${d.toFixed(3)}°`);
    }
  }
});

test('三个油缸的缸长在各自行程内严格单调', () => {
  for (const m of PRESETS) {
    const R = resolveJointRanges(m);

    let dir = 0;
    let prev = null;
    for (let i = 0; i <= 200; i++) {
      const L = boomCylLength(m, R.alphaMin + ((R.alphaMax - R.alphaMin) * i) / 200);
      if (prev != null) {
        const s = Math.sign(L - prev);
        if (!dir) dir = s;
        else assert.equal(s, dir, `${m.id} 动臂缸长在行程中折返`);
      }
      prev = L;
    }

    dir = 0;
    prev = null;
    for (let i = 0; i <= 200; i++) {
      const L = armCylLength(m, R.deltaMin + ((R.deltaMax - R.deltaMin) * i) / 200);
      if (prev != null) {
        const s = Math.sign(L - prev);
        if (!dir) dir = s;
        else assert.equal(s, dir, `${m.id} 斗杆缸长在行程中折返`);
      }
      prev = L;
    }

    dir = 0;
    prev = null;
    for (let i = 0; i <= 200; i++) {
      const L = bucketCylLength(m, R.psiDump + ((R.psiCurl - R.psiDump) * i) / 200);
      if (prev != null) {
        const s = Math.sign(L - prev);
        if (!dir) dir = s;
        else assert.equal(s, dir, `${m.id} 铲斗缸长在行程中折返`);
      }
      prev = L;
    }
  }
});

test('真机关系：铲斗油缸全缩位即收斗位（缸长较短）', () => {
  for (const m of PRESETS) {
    const b = bucketRotationRange(m);
    assert.ok(
      bucketCylLength(m, b.curl) < bucketCylLength(m, b.dump),
      `${m.id}: 收斗位缸长应短于卸料位`,
    );
  }
});

test('安装距 / 行程 与标定目标角一致（误差 < 0.1°）', () => {
  for (const m of PRESETS) {
    const cal = m.calibration;
    const R = resolveJointRanges(m);
    assert.ok(Math.abs(R.alphaMin - cal.boomAngleMin) < 0.1, `${m.id} αmin`);
    assert.ok(Math.abs(R.alphaMax - cal.boomAngleMax) < 0.1, `${m.id} αmax`);
    assert.ok(Math.abs(R.deltaMin - cal.armRelMin) < 0.1, `${m.id} Δmin`);
    assert.ok(Math.abs(R.deltaMax - cal.armRelMax) < 0.1, `${m.id} Δmax`);
    const psiCurl = 90 - (cal.boomAngleMax + cal.armRelMax);
    assert.ok(Math.abs(R.psiCurl - psiCurl) < 0.1, `${m.id} ψ收`);
    assert.ok(Math.abs(R.psiDump - (psiCurl - 180)) < 0.1, `${m.id} ψ卸`);
  }
});

test('calibrateCylinders 由目标角反算出的安装距与行程有效', () => {
  const m = clonePreset('x20t');
  const cal = m.calibration;
  const cyl = calibrateCylinders(m, {
    alphaMin: cal.boomAngleMin,
    alphaMax: cal.boomAngleMax,
    deltaMin: cal.armRelMin,
    deltaMax: cal.armRelMax,
    psiCurl: 90 - (cal.boomAngleMax + cal.armRelMax),
    psiDump: 90 - (cal.boomAngleMax + cal.armRelMax) - 180,
  });
  for (const [k, v] of Object.entries(cyl)) {
    assert.ok(Number.isFinite(v) && v > 0, `${k} = ${v}`);
  }
  assert.ok(cyl.boomCylStroke > 100 && cyl.boomCylStroke < 3000, `动臂行程 ${cyl.boomCylStroke}`);
  assert.ok(cyl.armCylStroke > 100 && cyl.armCylStroke < 3000, `斗杆行程 ${cyl.armCylStroke}`);
  assert.ok(cyl.bktCylStroke > 100 && cyl.bktCylStroke < 3000, `铲斗行程 ${cyl.bktCylStroke}`);
});

test('回归：就地修改参数后关节角范围必须立即更新', () => {
  clearRangeCache();
  const p = clonePreset('x20t');
  const before = { ...resolveJointRanges(p) };
  const heightBefore = computeMetrics(p).values.maxDigHeight;

  // 模拟界面滑块：就地改同一个对象
  p.boomCylStroke = p.boomCylStroke * 1.12;
  const after = resolveJointRanges(p);

  assert.notEqual(
    after.alphaMax,
    before.alphaMax,
    '就地改行程后动臂仰角上限没变——说明关节角范围被对象身份缓存钉死了',
  );
  assert.ok(after.alphaMax > before.alphaMax, `行程变长后仰角上限应变大：${before.alphaMax} → ${after.alphaMax}`);
  assert.ok(
    computeMetrics(p).values.maxDigHeight > heightBefore,
    '行程变长后最大挖掘高度应变大',
  );
});

test('布置自检：三个预设的安装点口径、伸出方向与干涉全部通过', () => {
  for (const m of PRESETS) {
    clearRangeCache();
    const layout = verifyCylinderLayout(m);
    const bad = layout.checks.filter((c) => !c.ok);
    assert.ok(
      bad.length === 0,
      `${m.id} 布置自检未通过：${bad.map((c) => `${c.label}(${c.detail})`).join('；')}`,
    );
    assert.ok(layout.clearance.armToBoom > -50, `${m.id} 斗杆油缸与动臂间隙 ${layout.clearance.armToBoom.toFixed(0)}mm`);
    assert.ok(layout.clearance.bucketToArm > 0, `${m.id} 铲斗油缸与斗杆间隙 ${layout.clearance.bucketToArm.toFixed(0)}mm`);
  }
});

test('布置口径：缸筒端/活塞杆端坐标符号符合真机约定', () => {
  for (const m of PRESETS) {
    // 动臂油缸缸筒端在 A 点前下方
    assert.ok(m.boomCylBodyDX > 0, `${m.id}: 缸筒端应相对 A 前移（ΔX>0），实为 ${m.boomCylBodyDX}`);
    assert.ok(m.boomCylBodyDY < 0, `${m.id}: 缸筒端应在 A 下方（ΔY<0），实为 ${m.boomCylBodyDY}`);
    // 斗杆油缸活塞杆端在 B 后方、斗杆上平面
    assert.ok(m.armCylRodAlong < 0, `${m.id}: 杆端沿斗杆应为负，实为 ${m.armCylRodAlong}`);
    assert.ok(m.armCylRodPerp > 0, `${m.id}: 杆端垂直斗杆应为正，实为 ${m.armCylRodPerp}`);
    // 铲斗油缸与摇杆都在斗杆上方；摇杆/连杆长度在真机量级
    assert.ok(m.bktCylBodyPerp > 0, `${m.id}: 铲斗油缸缸筒端应在斗杆上方`);
    assert.ok(m.bktBellPerp > 0, `${m.id}: 摇杆铰点应在斗杆上方（或装在斗杆结构内）`);
    assert.ok(
      m.bktRockerLen > 0.08 * m.armLength && m.bktRockerLen < 0.38 * m.armLength,
      `${m.id}: 摇杆长度 ${m.bktRockerLen} 应在 0.08~0.38 倍斗杆长`,
    );
    assert.ok(
      m.bktLinkLen > 0.12 * m.armLength && m.bktLinkLen < 0.55 * m.armLength,
      `${m.id}: 连杆长度 ${m.bktLinkLen} 应在 0.12~0.55 倍斗杆长`,
    );
    // 连杆–铲斗铰点落在斗背板上（相对 C：略靠后、靠上）
    assert.ok(m.bktEAlong < 0 && m.bktEAlong > -0.4 * m.bucketRadius, `${m.id}: 连杆销应略在 C 之后`);
    assert.ok(
      m.bktEPerp > 0.2 * m.bucketRadius && m.bktEPerp < 0.8 * m.bucketRadius,
      `${m.id}: 连杆销应在斗背板上方`,
    );
  }
});

test('伸出方向：动臂抬起 / 斗杆收拢 / 铲斗全缩收斗', () => {
  for (const m of PRESETS) {
    clearRangeCache();
    const R = resolveJointRanges(m);
    // 动臂：伸出 → 仰角增大
    assert.ok(
      boomCylLength(m, R.alphaMax) > boomCylLength(m, R.alphaMin),
      `${m.id}: 动臂油缸伸出应抬起动臂`,
    );
    // 斗杆：伸出 → 收拢（Δ 减小）
    assert.ok(
      armCylLength(m, R.deltaMin) > armCylLength(m, R.deltaMax),
      `${m.id}: 斗杆油缸伸出应收拢斗杆`,
    );
    // 铲斗：全缩 → 收斗
    const b = bucketRotationRange(m);
    assert.ok(
      bucketCylLength(m, b.curl) < bucketCylLength(m, b.dump),
      `${m.id}: 铲斗油缸全缩应为收斗位（缸长较短）`,
    );
  }
});

test('回归：清空缓存后重算结果一致（缓存不影响正确性）', () => {
  const p = clonePreset('x20t');
  const a = { ...resolveJointRanges(p) };
  clearRangeCache();
  const b = { ...resolveJointRanges(p) };
  for (const k of Object.keys(a)) {
    assert.ok(Math.abs(a[k] - b[k]) < 1e-9, `${k}: ${a[k]} vs ${b[k]}`);
  }
});

test('cylinderPose 在全部指标姿态下给出有限坐标', () => {
  for (const m of PRESETS) {
    const { poses } = computeMetrics(m);
    for (const [key, pose] of Object.entries(poses)) {
      const c = cylinderPose(m, pose);
      assert.ok(c, `${m.id}/${key} 解不出油缸几何`);
      const pts = [
        c.boom.body, c.boom.rod, c.arm.body, c.arm.rod,
        c.bucket.body, c.bucket.rod,
        c.rocker.pivot, c.rocker.joint, c.link.to,
      ];
      if (c.link.from) pts.push(c.link.from);
      for (const q of pts) {
        assert.ok(Number.isFinite(q.x) && Number.isFinite(q.y), `${m.id}/${key} 出现非有限坐标`);
      }
    }
  }
});

test('cylinderPose 的缸长与正解一致（抽检）', () => {
  for (const m of PRESETS) {
    const { poses } = computeMetrics(m);
    const pose = poses.maxDigDepth;
    const c = cylinderPose(m, pose);
    const Lboom = Math.hypot(c.boom.rod.x - c.boom.body.x, c.boom.rod.y - c.boom.body.y);
    assert.ok(
      Math.abs(Lboom - boomCylLength(m, pose.alphaDeg)) < 1e-6,
      `${m.id}: 图上动臂缸长 ${Lboom.toFixed(2)} vs 正解 ${boomCylLength(m, pose.alphaDeg).toFixed(2)}`,
    );
    const Larm = Math.hypot(c.arm.rod.x - c.arm.body.x, c.arm.rod.y - c.arm.body.y);
    assert.ok(
      Math.abs(Larm - armCylLength(m, pose.deltaDeg)) < 1e-6,
      `${m.id}: 图上斗杆缸长 ${Larm.toFixed(2)} vs 正解 ${armCylLength(m, pose.deltaDeg).toFixed(2)}`,
    );
    const Lbkt = Math.hypot(c.bucket.rod.x - c.bucket.body.x, c.bucket.rod.y - c.bucket.body.y);
    assert.ok(
      Math.abs(Lbkt - bucketCylLength(m, pose.psiDeg)) < 1e-6,
      `${m.id}: 图上铲斗缸长 ${Lbkt.toFixed(2)} vs 正解 ${bucketCylLength(m, pose.psiDeg).toFixed(2)}`,
    );
  }
});

test('cylinderPose 对畸形姿态返回 null 而不是抛异常', () => {
  const m = clonePreset('x20t');
  assert.equal(cylinderPose(m, null), null);
  assert.equal(cylinderPose(m, { alphaDeg: NaN, armAbsDeg: 0, psiDeg: 0, A: { x: 0, y: 0 }, B: { x: 0, y: 0 } }), null);
});

test('jointRanges 与 resolveJointRanges 完全一致', () => {
  for (const m of PRESETS) {
    const a = jointRanges(m);
    const b = resolveJointRanges(m);
    assert.deepEqual(a.alpha, [b.alphaMin, b.alphaMax]);
    assert.deepEqual(a.delta, [b.deltaMin, b.deltaMax]);
    assert.deepEqual(a.psi, [b.psiMin, b.psiMax]);
  }
});

test('动臂行程加大 → 仰角范围与挖掘高度同步增大', () => {
  const base = clonePreset('x20t');
  const v1 = computeMetrics(base).values;
  const R1 = resolveJointRanges(base);
  const longer = { ...base, boomCylStroke: base.boomCylStroke * 1.5 };
  const R2 = resolveJointRanges(longer);
  const v2 = computeMetrics(longer).values;
  assert.ok(R2.alphaMax > R1.alphaMax, `仰角上限应变大：${R1.alphaMax} → ${R2.alphaMax}`);
  assert.ok(v2.maxDigHeight > v1.maxDigHeight, `挖掘高度应变大：${v1.maxDigHeight} → ${v2.maxDigHeight}`);
});

test('斗杆行程只改变斗杆转角范围的下限端：范围变大，而挖掘深度不变', () => {
  const base = clonePreset('x20t');
  const R1 = resolveJointRanges(base);
  const v1 = computeMetrics(base).values;

  // 斗杆油缸伸出 = 斗杆收拢，所以「安装距不变、行程加大」只会把 Δ 的下限推得更低
  const longer = { ...base, armCylStroke: base.armCylStroke * 1.3 };
  const R2 = resolveJointRanges(longer);
  const v2 = computeMetrics(longer).values;

  assert.ok(R2.deltaMin < R1.deltaMin, `斗杆转角下限应变小：${R1.deltaMin} → ${R2.deltaMin}`);
  assert.ok(
    Math.abs(R2.deltaMax - R1.deltaMax) < 1e-9,
    `安装距没变，另一端的极限不应变：${R1.deltaMax} → ${R2.deltaMax}`,
  );
  // 最大挖掘深度 = −(pivotY + L1·sinαmin − L2 − R3)，只与动臂最低角、斗杆长度有关，
  // 与斗杆油缸行程无关——这条性质能证明各油缸的作用是解耦的
  assert.ok(
    Math.abs(v2.maxDigDepth - v1.maxDigDepth) < 1e-6,
    `最大挖掘深度不应受斗杆行程影响：${v1.maxDigDepth} → ${v2.maxDigDepth}`,
  );
});

test('铲斗行程缩短 → 铲斗转角范围变小；行程过分超出连杆可达范围时被校验拦下', () => {
  const base = clonePreset('x20t');
  const b1 = bucketRotationRange(base);
  const shorter = { ...base, bktCylStroke: base.bktCylStroke * 0.9 };
  const b2 = bucketRotationRange(shorter);
  assert.ok(
    b2.max - b2.min < b1.max - b1.min,
    `铲斗转角范围应变小：${(b1.max - b1.min).toFixed(1)} → ${(b2.max - b2.min).toFixed(1)}`,
  );

  // 摇杆/连杆能覆盖的角度是有限的：行程拉到 2 倍后机构根本装配不到，
  // 这时模型给出 NaN，validateParams 必须报错（界面保留上一次有效结果），
  // 而不是把 NaN 悄悄带进指标。
  clearRangeCache();
  const tooLong = { ...base, bktCylStroke: base.bktCylStroke * 2 };
  const v = validateParams(tooLong);
  assert.equal(v.ok, false, '过分加长铲斗行程应被校验拦下');
  assert.ok(v.errors.some((e) => e.includes('铲斗相对转角')), v.errors.join('; '));
});

test('把已知真机数据代进预设后仍能复现样本指标', () => {
  // 这条同时充当「示例油缸数据自洽性」的守卫：
  // 只要有人改动预设里的油缸数字而没重跑 setup-cylinders，指标就会漂出容差
  const m = getPreset('x20t');
  const { values } = computeMetrics(m);
  assert.ok(Math.abs(values.groundMaxRadius - 9950) / 9950 < 0.005);
  assert.ok(Math.abs(values.maxDigDepth - 6600) / 6600 < 0.005);
  assert.ok(Math.abs(values.maxDigHeight - 9570) / 9570 < 0.005);
  assert.ok(Math.abs(values.dumpHeight - 6700) / 6700 < 0.005);
});

/**
 * 把世界坐标的点换算到某个「杆件坐标系」：原点 O，+x 沿 axisDeg 方向，+y 为左法向。
 * 用来验证「安装点相对末端销孔的坐标不随杆件长度变化」。
 */
function toLinkFrame(pt, O, axisDeg) {
  const t = (axisDeg * Math.PI) / 180;
  const dx = pt.x - O.x;
  const dy = pt.y - O.y;
  return { along: dx * Math.cos(t) + dy * Math.sin(t), perp: -dx * Math.sin(t) + dy * Math.cos(t) };
}

test('改「动臂长度」，斗杆油缸缸筒端跟着动臂末端销孔 B 一起走', () => {
  for (const base of PRESETS) {
    for (const dLen of [0, 900, -700]) {
      clearRangeCache();
      const p = { ...base, boomLength: base.boomLength + dLen };
      const check = validateParams(p);
      assert.ok(check.ok, `${base.id} 动臂长 ${p.boomLength}：参数应合法（${check.errors.join(';')}）`);
      const pose = computeMetrics(p).poses.maxDigHeight;
      const cyl = cylinderPose(p, pose);
      const off = toLinkFrame(cyl.arm.body, pose.B, pose.alphaDeg);
      // 自 B 起算的坐标应当恒等于参数值（与动臂长度无关）
      assert.ok(Math.abs(off.along - p.armCylBodyAlong) < 1e-6, `${base.id} ΔL=${dLen}: 沿动臂 ${off.along} vs ${p.armCylBodyAlong}`);
      assert.ok(Math.abs(off.perp - p.armCylBodyPerp) < 1e-6, `${base.id} ΔL=${dLen}: 垂直动臂 ${off.perp} vs ${p.armCylBodyPerp}`);
      // 而它到动臂根部 A 的距离必须随动臂长度变化（说明确实跟着末端移动了）
      const toA = Math.hypot(cyl.arm.body.x - pose.A.x, cyl.arm.body.y - pose.A.y);
      const expectA = Math.hypot(p.boomLength + p.armCylBodyAlong, p.armCylBodyPerp);
      assert.ok(Math.abs(toA - expectA) < 1e-6, `${base.id} ΔL=${dLen}: 到 A 的距离 ${toA} vs ${expectA}`);
      if (dLen !== 0) {
        clearRangeCache();
        const p0 = { ...base };
        const pose0 = computeMetrics(p0).poses.maxDigHeight;
        const off0 = toLinkFrame(cylinderPose(p0, pose0).arm.body, pose0.B, pose0.alphaDeg);
        assert.ok(Math.abs(off0.along - off.along) < 1e-6, `${base.id}: 改臂长后「自 B」坐标必须不变`);
      }
    }
  }
});

test('改「斗杆长度」，铲斗油缸缸筒端与摇杆铰点跟着斗杆末端销孔 C 一起走', () => {
  for (const base of PRESETS) {
    for (const dLen of [0, 600, -500]) {
      clearRangeCache();
      const p = { ...base, armLength: base.armLength + dLen };
      const pose = computeMetrics(p).poses.maxDigHeight;
      const cyl = cylinderPose(p, pose);
      const D = toLinkFrame(cyl.rocker.pivot, pose.C, pose.armAbsDeg);
      const P5 = toLinkFrame(cyl.bucket.body, pose.C, pose.armAbsDeg);
      assert.ok(Math.abs(D.along - p.bktBellAlong) < 1e-6, `${base.id} ΔL=${dLen}: 摇杆铰点自 C 沿斗杆 ${D.along} vs ${p.bktBellAlong}`);
      assert.ok(Math.abs(D.perp - p.bktBellPerp) < 1e-6, `${base.id} ΔL=${dLen}: 摇杆铰点垂直 ${D.perp} vs ${p.bktBellPerp}`);
      assert.ok(Math.abs(P5.along - p.bktCylBodyAlong) < 1e-6, `${base.id} ΔL=${dLen}: 铲斗缸缸筒端自 C 沿斗杆 ${P5.along} vs ${p.bktCylBodyAlong}`);
      assert.ok(Math.abs(P5.perp - p.bktCylBodyPerp) < 1e-6, `${base.id} ΔL=${dLen}: 铲斗缸缸筒端垂直 ${P5.perp} vs ${p.bktCylBodyPerp}`);
    }
  }
});

test('安装点必须落在杆件范围内（否则加长/缩短后安装点会掉到杆件外）', () => {
  for (const m of PRESETS) {
    const v = verifyCylinderLayout(m);
    for (const key of ['armBody', 'bktBody', 'bell']) {
      const c = v.checks.find((x) => x.key === key);
      assert.ok(c?.ok, `${m.id}: ${key} 布置检查未通过 —— ${c?.detail}`);
    }
  }
});
