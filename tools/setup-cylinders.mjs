#!/usr/bin/env node
/**
 * 油缸与连杆总标定器
 * ==========================================================================
 * 厂家样本不公开油缸安装位置、安装距、行程，也不公开铲斗连杆尺寸，
 * 所以预设机型的这些数据全部由本工具「按机型尺度构造 + 反算」得到。
 *
 * 布置口径（与界面输入、cylinders.js 求解完全一致）
 * ---------------------------------------------------------------
 *   ① 动臂油缸：缸筒端在 A 点前下方（ΔX>0, ΔY<0，装在转台前部），
 *      活塞杆端在动臂下表面（垂直动臂为负）。
 *   ② 斗杆油缸：缸筒端在动臂上表面（垂直动臂为正、约 0.5 倍动臂长处），
 *      活塞杆端在 B 点后方、斗杆上平面（沿斗杆为负、垂直斗杆为正）。
 *   ③ 铲斗油缸：缸筒端在斗杆上方（垂直斗杆为正），活塞杆端接摇臂长臂；
 *      摇臂短臂经连杆拉动铲斗上的铰点，构成标准四连杆。
 *
 * 三条油缸的伸出方向统一为「伸出 = 作业方向」：
 *   动臂伸出 → 抬起；斗杆伸出 → 收拢（挖掘）；铲斗伸出 → 收斗（挖掘）。
 *   这样重载方向都落在全活塞面积的伸出侧，与真机一致。
 *
 * 安装距 / 行程由 calibrateCylinders 从标定好的关节角反算，
 * 所以预设仍能精确复现厂家样本的作业尺寸。
 *
 *   node tools/setup-cylinders.mjs
 *   node tools/setup-cylinders.mjs --json
 */

import { pathToFileURL } from 'node:url';
import { PRESETS } from '../assets/core/presets.js';
import { PARAM_SPEC_BY_KEY } from '../assets/core/params.js';
import {
  calibrateCylinders,
  resolveJointRanges,
  bucketPsiFromLength,
  bucketCylLength,
  armCylLength,
  boomCylLength,
  verifyCylinderLayout,
} from '../assets/core/cylinders.js';
import { toRad, toDeg } from '../assets/core/geometry.js';

const P = (x, y) => ({ x, y });
const sub = (a, b) => P(a.x - b.x, a.y - b.y);
const len = (a) => Math.hypot(a.x, a.y);
const rot = (O, t, v) => P(O.x + v.x * Math.cos(t) - v.y * Math.sin(t), O.y + v.x * Math.sin(t) + v.y * Math.cos(t));
const atan2d = (v) => toDeg(Math.atan2(v.y, v.x));
const deg = (r) => toDeg(r);
const round = (v, n = 0) => {
  const f = 10 ** n;
  return Math.round(v * f) / f;
};
const roundHalf = (v) => Math.round(v * 2) / 2;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
/** 构造过程诊断开关（--probe-bucket） */
const DBG = typeof process !== 'undefined' && process.argv?.includes('--probe-bucket');

/** 确定性伪随机（可复现的搜索结果） */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 圆–圆交点（两解），装配不上时返回 null */
function circleX(c1, r1, c2, r2) {
  const d = len(sub(c2, c1));
  if (d < 1e-9 || d > r1 + r2 || d < Math.abs(r1 - r2)) return null;
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const u = P((c2.x - c1.x) / d, (c2.y - c1.y) / d);
  const base = P(c1.x + a * u.x, c1.y + a * u.y);
  return [P(base.x - h * u.y, base.y + h * u.x), P(base.x + h * u.y, base.y - h * u.x)];
}

/* ================================================================== *
 * ① 动臂油缸
 * ================================================================== */

/**
 * 动臂油缸布置：缸筒端在 A 前下方，活塞杆端在动臂中段下表面。
 * 位置按机型尺度取比例，安装距/行程随后由 α 目标反算，因此只需保证
 * 「缸长随仰角单调」和「安装距/行程落在真机量级」。
 */
function designBoom(p) {
  const L1 = p.boomLength;
  const { boomAngleMin: aMin, boomAngleMax: aMax } = p.calibration;
  const baseDy = Math.max(360, p.pivotY - p.trackHeight + 40);
  const along = Math.round(0.52 * L1);
  // 比例值（约 0.21·L1，即 22°）可能超出滑块区间——长动臂尤其明显。
  // 这里按参数规范收敛，保证工具构造出来的值永远落在界面能输入的范围内。
  const perp = clamp(-Math.round(0.52 * L1 * Math.tan(toRad(22))), PARAM_SPEC_BY_KEY.boomCylRodPerp.min, -1);
  // 缸长在「活塞杆端方向与 A→缸筒端方向共线」处取极值。
  // 杆端方向随 α 扫过 [rodDir+aMin, rodDir+aMax]，缸筒端方向必须落在这段之外，
  // 否则行程里会出现折返，反解就不唯一了。这里留 5° 余量。
  const rodDir = toDeg(Math.atan2(perp, along));
  const rodLo = rodDir + aMin;
  const rodHi = rodDir + aMax;

  let best = null;
  for (const dxr of [0.05, 0.04, 0.06, 0.03, 0.07, 0.02, 0.08]) {
    for (const dyr of [1, 1.25, 1.5, 0.8]) {
      const dx = Math.round(dxr * L1);
      const dy = -Math.round(baseDy * dyr);
      const footDir = toDeg(Math.atan2(dy, dx));
      if (!(footDir <= rodLo - 5 || footDir >= rodHi + 5)) continue;
      // ⚠️ 参数口径：boomCylRodPerp 就是动臂坐标系的垂直坐标本身（+y 指向动臂上方），
      //    真机该铰点在动臂两端点连线的另一侧，所以是负值。
      const q = { ...p, boomCylBodyDX: dx, boomCylBodyDY: dy, boomCylRodAlong: along, boomCylRodPerp: perp };
      const samples = [];
      for (let i = 0; i <= 60; i++) samples.push(boomCylLength(q, aMin + ((aMax - aMin) * i) / 60));
      if (samples.some((v) => !Number.isFinite(v))) continue;
      let mono = true;
      for (let i = 1; i < samples.length; i++) if (samples[i] <= samples[i - 1]) mono = false;
      if (!mono) continue;
      const closed = samples[0];
      const open = samples[samples.length - 1];
      const stroke = open - closed;
      if (!(closed > 0.4 * L1 && closed < 0.65 * L1)) continue;
      if (!(stroke > 0.05 * L1 && stroke < 0.2 * L1)) continue;
      // 缸筒端装在转台前部、略低于 A；安装距约半个动臂长，行程约 0.12 倍动臂长
      const score =
        Math.abs(closed - 0.5 * L1) / (0.05 * L1) +
        Math.abs(stroke - 0.12 * L1) / (0.04 * L1) +
        Math.abs(dxr - 0.05) / 0.05 +
        Math.abs(dyr - 1) / 0.6;
      if (!best || score < best.score) best = { dx, dy, along, perp, closed, open, score };
    }
  }
  if (!best) return null;
  return {
    params: {
      boomCylBodyDX: best.dx,
      boomCylBodyDY: best.dy,
      boomCylRodAlong: best.along,
      boomCylRodPerp: best.perp,
    },
    meta: { closed: best.closed, open: best.open },
  };
}

/* ================================================================== *
 * ② 斗杆油缸
 * ================================================================== */

/** 动臂上（下）表面相对轴线的距离：截面厚度线性收窄（与 cylinders.js 口径一致） */
function boomHalf(p, x) {
  const t = clamp(x, 0, p.boomLength) / p.boomLength;
  return ((p.boomWidth ?? 500) / 2) * (1 - 0.18 * t);
}

/**
 * 斗杆油缸候选评估。全部在动臂坐标系里做：A=(0,0)、B=(L1,0)。
 * 硬约束：杆端口径 / 单调且 dL/dΔ<0（伸出即收拢）/ 不穿动臂上表面 / 不穿斗杆本体。
 */
function evalArm(p, a3, b3, a4, b4) {
  const L1 = p.boomLength;
  const L2 = p.armLength;
  const dMin = p.calibration.armRelMin;
  const dMax = p.calibration.armRelMax;
  const V = P(a3, b3);
  const m = P(L1 - a3, -b3);
  if (!(a4 * m.y - b4 * m.x < 0)) return { fail: 'sense' }; // 方向：伸出 → Δ 减小

  const n = 120;
  let prev = null;
  let dir = 0;
  let lMin = Infinity;
  let lMax = -Infinity;
  let worst = Infinity;
  for (let i = 0; i <= n; i++) {
    const d = dMin + ((dMax - dMin) * i) / n;
    const th = toRad(d);
    const u = rot(P(0, 0), th, P(a4, b4));
    const W = P(L1 + u.x, u.y);
    const L = Math.hypot(W.x - V.x, W.y - V.y);
    if (!Number.isFinite(L)) return { fail: 'nan' };
    if (prev != null) {
      const s = Math.sign(L - prev);
      if (!dir) dir = s;
      else if (s !== dir) return { fail: 'fold' }; // 缸长折返
    }
    prev = L;
    lMin = Math.min(lMin, L);
    lMax = Math.max(lMax, L);

    for (let k = 0; k <= 24; k++) {
      const s = (k / 24) * Math.max(0, L - 200);
      const qx = V.x + ((W.x - V.x) * s) / L;
      const qy = V.y + ((W.y - V.y) * s) / L;
      if (qx > 0 && qx < L1 * 0.94) {
        const gap = qy - boomHalf(p, qx);
        if (gap < worst) worst = gap;
      }
    }

    // 斗杆本体：弦线与斗杆轴线线段是否相交（掐掉根部 200mm）
    const dirv = P(Math.cos(th), Math.sin(th));
    const nrm = P(-dirv.y, dirv.x);
    const sV = (V.x - L1) * nrm.x + V.y * nrm.y;
    const sW = (W.x - L1) * nrm.x + W.y * nrm.y;
    if (sV * sW < 0) {
      const t = sV / (sV - sW);
      const px = V.x + (W.x - V.x) * t;
      const py = V.y + (W.y - V.y) * t;
      const along = (px - L1) * dirv.x + py * dirv.y;
      if (along > -200 && along < L2) return { fail: 'stick' };
    }
  }
  if (dir >= 0) return { fail: 'sense' }; // 必须 dL/dΔ < 0（伸出 = 收拢）
  if (!(lMin > 0) || !(lMax > lMin)) return { fail: 'nan' };
  return { a3, b3, a4, b4, closed: lMin, open: lMax, stroke: lMax - lMin, gap: worst };
}

function designArm(p) {
  const L1 = p.boomLength;
  const L2 = p.armLength;
  let best = null;
  const stat = { tried: 0, sense: 0, window: 0, gap: 0 };
  for (const al of [0.08, 0.11, 0.14, 0.17, 0.2, 0.24, 0.28]) {
    for (const be of [0.08, 0.11, 0.14, 0.17, 0.2, 0.24, 0.28]) {
      for (let ga = 0.3; ga <= 0.9001; ga += 0.025) {
        for (const de of [0.07, 0.09, 0.11, 0.13, 0.15, 0.17, 0.19]) {
          stat.tried++;
          const r = evalArm(p, ga * L1, de * L1, -al * L2, be * L2);
          if (r.fail) { stat[r.fail] = (stat[r.fail] ?? 0) + 1; continue; }
          if (!(r.closed > 0.30 * L1 && r.closed < 0.60 * L1)) { stat.window++; continue; }
          if (!(r.stroke > 0.14 * L1 && r.stroke < 0.36 * L1)) { stat.window++; continue; }
          if (r.stroke > 0.95 * r.closed) { stat.window++; continue; }
          // 动臂鼻部（末端 6%）本就是叉形铰点区，允许轻微贴合；其余位置要求 ≥ 30mm
          if (r.gap < -60) { stat.gap++; continue; }
          const bracket = r.b3 - boomHalf(p, r.a3);
          if (!(bracket > 100 && bracket < 1150)) { stat.gap++; continue; }
          const score =
            Math.abs(r.closed - 0.4 * L1) / (0.05 * L1) +
            Math.abs(r.stroke - 0.26 * L1) / (0.05 * L1) +
            Math.abs(bracket - 350) / 600 -
            Math.min(r.gap, 400) / 500;
          if (!best || score < best.score) best = { ...r, bracket, score };
        }
      }
    }
  }
  if (!best) {
    designArm.stat = stat;
    return null;
  }
  return {
    params: {
      // ⚠️ 缸筒端按「自动臂末端销孔 B 起算、向根部为负」输出
      armCylBodyAlong: Math.round(best.a3 - L1),
      armCylBodyPerp: Math.round(best.b3),
      armCylRodAlong: Math.round(best.a4),
      armCylRodPerp: Math.round(best.b4),
    },
    meta: { closed: best.closed, open: best.open, gap: best.gap, bracket: best.bracket, stat },
  };
}

/* ================================================================== *
 * ③ 铲斗四连杆
 * ================================================================== */

/**
 * 由一组比例参数构造四连杆候选（斗杆坐标系，原点 B、+x 指向 C）。
 *
 * 机构：摇杆与连杆都是「两铰点杆」——
 *   摇杆 D→P（D 在斗杆上），P 是摇杆端、活塞杆端、连杆端共用的销轴，
 *   连杆 P→E（E 在铲斗背板上）。
 *
 * 构造规则：
 *   · |DE| 随 ψ 变化，先扫出它的极值 minDE / maxDE；
 *   · 连杆长度取 ℓ = linkScale·(maxDE+minDE)/2，保证装配条件 |r−ℓ| ≤ |DE| ≤ r+ℓ 有余量；
 *   · 摇杆长度 r 在装配可行区间里扫，取「缸长在整段 ψ 上单调 + 行程接近目标」的那一个；
 *   · 油缸缸筒端 P5 只能落在斗杆上表面（位置由 p5Along/p5Perp 定），
 *     扫描 p5Along 让「摇杆扫掠弧中点垂直于油缸轴线」——这样缸长才单调，
 *     传动也最有力（与真机布置一致）。
 *
 * @returns {object[]} 0 或 1 个候选
 */
function buildBucket(p, psiRetracted, psiExtended, o, branch, targetStroke, dir) {
  const L2 = p.armLength;
  const R3 = p.bucketRadius;
  const branchSign = branch >= 0 ? 1 : -1;
  const D = P(o.dAlong * L2, o.dPerp * L2);
  const C = P(L2, 0);
  const DC = sub(C, D);
  const psiDC = atan2d(DC);
  const psiMid = (psiRetracted + psiExtended) / 2;
  // E 的相位：基础相位让 E 相对 D 的扫掠弧张开在连杆能跟上的方向上，
  // ePhase 再整体旋转这套连杆几何，使摇杆扫掠弧能对准「垂直于油缸轴线」的方向
  // （那里缸长单调、变化最快，也正是真机的布置）
  const psiE = 90 - psiMid + psiDC + (o.ePhase ?? 0);
  const rE = o.eScale * R3;
  const e = P(rE * Math.cos(toRad(psiE)), rE * Math.sin(toRad(psiE)));

  const at = (psi) => rot(C, toRad(psi), e);
  // 连杆–铲斗铰点必须落在斗背板上（与 verifyCylinderLayout 同一口径）
  if (!(e.x > -0.4 * R3 && e.x < 0)) return [];
  if (!(e.y > 0.2 * R3 && e.y < 0.8 * R3)) return [];

  let minDE = Infinity;
  let maxDE = -Infinity;
  for (let i = 0; i <= 120; i++) {
    const dE = len(sub(at(psiExtended + ((psiRetracted - psiExtended) * i) / 120), D));
    if (dE < minDE) minDE = dE;
    if (dE > maxDE) maxDE = dE;
  }
  const linkLen = ((maxDE + minDE) / 2) * o.linkScale;
  // 装配条件 |r−ℓ| ≤ |DE| ≤ r+ℓ 对整段 ψ 成立 → r 的可行区间
  const rLo = Math.max(80, maxDE - linkLen, linkLen - minDE) * 1.01;
  const rHi = Math.min(0.3 * L2, (linkLen + minDE) * 0.99);
  if (!(rHi > rLo + 20)) return [];

  const pinAt = (psi, r) => {
    const E = at(psi);
    const dE = len(sub(E, D));
    if (dE < 1e-9 || dE > r + linkLen || dE < Math.abs(r - linkLen)) return null;
    const a = (r * r - linkLen * linkLen + dE * dE) / (2 * dE);
    const h = Math.sqrt(Math.max(0, r * r - a * a));
    const ux = (E.x - D.x) / dE;
    const uy = (E.y - D.y) / dE;
    return P(D.x + a * ux - branchSign * h * uy, D.y + a * uy + branchSign * h * ux);
  };

  const nPsi = 25;
  const psis = Array.from({ length: nPsi + 1 }, (_, i) => psiExtended + ((psiRetracted - psiExtended) * i) / nPsi);
  const p5Alongs = [];
  for (let a = 0.08; a <= Math.min(o.dAlong - 0.03, 0.62) + 1e-9; a += 0.035) p5Alongs.push(a);
  const p5Perps = [0.1, 0.14, 0.18, 0.22, 0.26].map((v) => v * L2);
  if (!p5Alongs.length) return [];

  const target = dir * targetStroke;
  let best = null;
  for (let step = 0; step <= 18; step++) {
    const r = rLo + ((rHi - rLo) * step) / 18;
    const pins = [];
    let broken = false;
    for (const psi of psis) {
      const q = pinAt(psi, r);
      if (!q) { broken = true; break; }
      pins.push(q);
    }
    if (broken) continue;
    // 摇杆扫掠弧
    const angs = pins.map((q) => atan2d(sub(q, D)));
    let acc = 0;
    let prev = angs[0];
    for (let i = 1; i < angs.length; i++) {
      let d = angs[i] - prev;
      if (d > 180) d -= 360;
      if (d < -180) d += 360;
      acc += d;
      prev = angs[i];
    }
    const sweep = Math.abs(acc);
    if (!(sweep > 30 && sweep < 160)) continue; // 扫掠太小行程不够，太大必然跨过缸长极值

    for (const p5Perp of p5Perps) {
      for (const p5Along of p5Alongs) {
        const P5 = P(p5Along * L2, p5Perp);
        const lens = pins.map((q) => len(sub(q, P5)));
        let mono = true;
        let s0 = 0;
        for (let i = 1; i < lens.length; i++) {
          const s = Math.sign(lens[i] - lens[i - 1]);
          if (!s) continue;
          if (!s0) s0 = s;
          else if (s !== s0) { mono = false; break; }
        }
        if (!mono) continue;
        // 两端离「缸长极值」（P 与 D、P5 共线）留 12° 余量，避免贴着死点
        const mid = P5;
        const dirEnd = (q) => {
          const a1 = Math.atan2(q.y - D.y, q.x - D.x);
          const a2 = Math.atan2(mid.y - D.y, mid.x - D.x);
          let d = ((a1 - a2) * 180) / Math.PI;
          d = ((d % 360) + 360) % 360;
          return Math.min(d, 360 - d);
        };
        if (dirEnd(pins[0]) < 12 || dirEnd(pins[pins.length - 1]) < 12) continue;

        const got = lens[lens.length - 1] - lens[0];
        if (!Number.isFinite(got) || Math.sign(got) !== Math.sign(target)) continue;
        const closed = Math.min(...lens);
        if (!(closed > 0.32 * L2 && closed < 0.75 * L2)) continue;
        if (Math.abs(got - target) > 0.4 * targetStroke) continue;
        const err =
          Math.abs(got - target) / (0.04 * L2) +
          Math.abs(closed - 0.5 * L2) / (0.08 * L2) +
          Math.abs(r - 0.16 * L2) / (0.05 * L2) +
          Math.abs(linkLen - 0.26 * L2) / (0.1 * L2);
        if (!best || err < best.err) best = { r, P5, linkLen, minDE, maxDE, err, sweep, closed, got };
      }
    }
  }
  if (!best) return [];
  const { r, P5 } = best;

  return [
    {
      params: {
        // ⚠️ 缸筒端与摇杆铰点按「自斗杆末端销孔 C 起算、向根部为负」输出
        bktCylBodyAlong: Math.round(P5.x - L2),
        bktCylBodyPerp: Math.round(P5.y),
        bktBellAlong: Math.round(D.x - L2),
        bktBellPerp: Math.round(D.y),
        bktRockerLen: Math.round(r),
        bktEAlong: Math.round(e.x),
        bktEPerp: Math.round(e.y),
        bktLinkLen: Math.round(linkLen),
      },
      meta: { r, linkLen, minDE, maxDE, dir, sweep: best.sweep, o },
    },
  ];
}

/** 评估一个四连杆候选：方向、单调、量级、干涉。失败时也带上已算出的量，便于诊断。 */
function evalBucket(p, psiRetracted, psiExtended, cand, branch) {
  const q = { ...p, ...cand.params, bktBranch: branch };
  const L2 = p.armLength;
  const base = { params: cand.params, branch, meta: cand.meta, r: cand.params.bktRockerLen, linkLen: cand.params.bktLinkLen };
  const n = 160;
  let prev = null;
  let mono = true;
  let dir = 0;
  const lens = [];
  for (let i = 0; i <= n; i++) {
    const psi = psiExtended + ((psiRetracted - psiExtended) * i) / n;
    const L = bucketCylLength(q, psi);
    if (!Number.isFinite(L)) return { ...base, fail: 'assemble' };
    if (prev != null) {
      const s = Math.sign(L - prev);
      if (!dir) dir = s;
      else if (s !== dir) mono = false;
    }
    prev = L;
    lens.push(L);
  }
  const closed = Math.min(...lens);
  const open = Math.max(...lens);
  const stroke = open - closed;
  Object.assign(base, { closed, open, stroke });
  if (!mono) return { ...base, fail: 'mono' };
  // 缸长端点：从全伸角扫描到全缩角，缸长应减小
  if (!(lens[lens.length - 1] < lens[0])) return { ...base, fail: 'dir' };
  if (!(closed > 0.3 * L2 && closed < 0.78 * L2)) return { ...base, fail: 'closed' };
  if (!(stroke > 0.2 * L2 && stroke < 0.46 * L2)) return { ...base, fail: 'stroke' };
  if (stroke > 1.05 * closed) return { ...base, fail: 'stroke' };
  if (!(base.r > 0.06 * L2 && base.r < 0.32 * L2)) return { ...base, fail: 'rocker' };
  if (!(base.linkLen > 0.1 * L2 && base.linkLen < 0.55 * L2)) return { ...base, fail: 'link' };
  // 连杆–铲斗铰点应落在斗背板上（相对 C：略靠后、靠上）
  const eLoc = cand.params;
  if (!(eLoc.bktEAlong > -0.4 * p.bucketRadius && eLoc.bktEAlong < 0)) return { ...base, fail: 'pin' };
  if (!(eLoc.bktEPerp > 0.2 * p.bucketRadius && eLoc.bktEPerp < 0.8 * p.bucketRadius)) return { ...base, fail: 'pin' };

  // 干涉与传动角：铲斗油缸、连杆都不得侵入斗杆本体；两处传动角不得接近死点
  let cylGap = Infinity;
  let linkGap = Infinity;
  let minTrans = Infinity;
  const D = P(L2 + cand.params.bktBellAlong, cand.params.bktBellPerp);
  const e = P(cand.params.bktEAlong, cand.params.bktEPerp);
  const C = P(L2, 0);
  const r = cand.params.bktRockerLen;
  const linkLen = cand.params.bktLinkLen;
  const branchSign = branch >= 0 ? 1 : -1;
  const P5 = P(L2 + cand.params.bktCylBodyAlong, cand.params.bktCylBodyPerp);
  const half = (p.armWidth ?? 340) / 2;
  const angleAt = (o, a, b) => {
    const v1 = { x: a.x - o.x, y: a.y - o.y };
    const v2 = { x: b.x - o.x, y: b.y - o.y };
    const c = (v1.x * v2.x + v1.y * v2.y) / (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y) || 1);
    return (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
  };
  for (let i = 0; i <= 24; i++) {
    const psi = psiExtended + ((psiRetracted - psiExtended) * i) / 24;
    const E = rot(C, toRad(psi), e);
    const dE = Math.hypot(E.x - D.x, E.y - D.y);
    if (dE < 1e-9 || dE > r + linkLen || dE < Math.abs(r - linkLen)) return { ...base, fail: 'assemble' };
    const aa = (r * r - linkLen * linkLen + dE * dE) / (2 * dE);
    const h = Math.sqrt(Math.max(0, r * r - aa * aa));
    const ux = (E.x - D.x) / dE;
    const uy = (E.y - D.y) / dE;
    const Pp = P(D.x + aa * ux - branchSign * h * uy, D.y + aa * uy + branchSign * h * ux);
    cylGap = Math.min(cylGap, chordGap(P5, Pp, L2, half, 16));
    linkGap = Math.min(linkGap, chordGap(Pp, E, L2, half, 12));
    // 传动角：连杆相对摇杆（P 处）、活塞杆相对摇杆（P 处）
    minTrans = Math.min(minTrans, angleAt(Pp, D, E), angleAt(Pp, D, P5));
  }
  if (cylGap < 25) return { ...base, cylGap, linkGap, minTrans, fail: 'clear' };
  if (linkGap < 15) return { ...base, cylGap, linkGap, minTrans, fail: 'linkclear' };
  if (!(minTrans > 25)) return { ...base, cylGap, linkGap, minTrans, fail: 'trans' };

  return { ...base, q, closed, open, stroke, dir, cylGap, linkGap, minTrans };
}

/** 弦线相对斗杆本体（轴线 y=0、半截面厚 half）的最小间隙 */
function chordGap(from, to, L2, half, samples) {
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  if (!(len > 1)) return Infinity;
  let worst = Infinity;
  for (let k = 0; k <= samples; k++) {
    const s = (k / samples) * Math.max(0, len - 160);
    const qx = from.x + ((to.x - from.x) * s) / len;
    const qy = from.y + ((to.y - from.y) * s) / len;
    if (qx > 0 && qx < L2 * 0.94) {
      const g = Math.abs(qy) - half;
      if (g < worst) worst = g;
    }
  }
  return worst;
}

function designBucket(p, psiRetracted, psiExtended) {
  const L2 = p.armLength;
  const rnd = mulberry32(0x5eed1ce);
  let best = null;
  let evaluated = 0;
  const stat = {};
  const targetStroke = 0.34 * L2; // 真机铲斗油缸行程 ≈ 0.3~0.36 倍斗杆长
  for (let iter = 0; iter < 12000; iter++) {
    const o = {
      dAlong: 0.7 + rnd() * 0.25,
      dPerp: 0.02 + rnd() * 0.18,
      eScale: 0.35 + rnd() * 0.45,
      linkScale: 0.88 + rnd() * 0.24,
      ePhase: -70 + rnd() * 140,
    };
    for (const branch of [1, -1]) {
      for (const dir of [-1, 1]) {
        for (const cand of buildBucket(p, psiRetracted, psiExtended, o, branch, targetStroke, dir)) {
          evaluated++;
          const v = evalBucket(p, psiRetracted, psiExtended, cand, branch);
          if (v.fail) { stat[v.fail] = (stat[v.fail] ?? 0) + 1; continue; }
          const params = cand.params;
          const score =
            Math.abs(v.stroke - targetStroke) / (0.04 * L2) +
            Math.abs(v.closed - 0.5 * L2) / (0.08 * L2) +
            Math.abs(v.r - 0.16 * L2) / (0.05 * L2) +
            Math.abs(v.linkLen - 0.28 * L2) / (0.08 * L2) +
            Math.abs(params.bktCylBodyAlong + L2 - 0.22 * L2) / (0.12 * L2) +
            Math.abs(params.bktCylBodyPerp - 0.16 * L2) / (0.1 * L2) +
            Math.abs(cand.meta.sweep - 120) / 60 -
            Math.min(v.minTrans - 25, 40) / 60 -
            Math.min(v.cylGap, 300) / 900;
          if (!best || score < best.score) best = { ...v, score, o };
        }
      }
    }
  }
  designBucket.evaluated = evaluated;
  designBucket.stat = stat;
  return best;
}

/* ================================================================== *
 * 总装
 * ================================================================== */

/**
 * 由「关节角层面的几何 + calibration 目标角」构造出完整的可运行机型。
 * 被本文件的 CLI 与 tools/fit-preset.mjs 共用。
 *
 * @param {object} p
 * @param {object} [opts]
 * @param {boolean} [opts.reuseBucket] 复用机型自带的铲斗连杆尺寸、跳过四连杆搜索。
 *   拟合循环里必须开这个：四连杆搜索要跑十几万次评估，而拟合要试几百个候选，
 *   而「关节角目标 → 作业尺寸」这个映射与选中哪套连杆无关——
 *   只要连杆能覆盖目标 ψ 区间，解出的角度范围就完全一样。
 * @returns {{machine, geom, cyl, target, r, dev, bkt, layout}|null}
 */
export function setupCylinders(p, opts = {}) {
  const cal = p.calibration;
  if (!cal) return null;
  const target = {
    alphaMin: cal.boomAngleMin,
    alphaMax: cal.boomAngleMax,
    deltaMin: cal.armRelMin,
    deltaMax: cal.armRelMax,
    psiRetracted: 90 - (cal.boomAngleMax + cal.armRelMax),
    psiExtended: 90 - (cal.boomAngleMax + cal.armRelMax) - 180,
  };

  const boom = designBoom(p);
  if (!boom) return null;
  const arm = designArm(p);
  if (!arm) return null;

  let bkt;
  if (opts.reuseBucket) {
    const keys = [
      'bktCylBodyAlong', 'bktCylBodyPerp', 'bktBellAlong', 'bktBellPerp',
      'bktRockerLen', 'bktEAlong', 'bktEPerp', 'bktLinkLen',
    ];
    if (!keys.every((k) => Number.isFinite(p[k]))) return null;
    bkt = {
      params: Object.fromEntries(keys.map((k) => [k, p[k]])),
      branch: p.bktBranch >= 0 ? 1 : -1,
      sweep: NaN,
      gap: NaN,
      r6: p.bktRockerLong,
      r7: p.bktRockerShort,
      linkLen: p.bktLinkLen,
    };
  } else {
    bkt = designBucket(p, target.psiRetracted, target.psiExtended);
    if (!bkt) return null;
  }

  const all = { ...boom.params, ...arm.params, ...bkt.params, bktBranch: bkt.branch };
  const withGeom = { ...p, ...all };
  const cyl = calibrateCylinders(withGeom, target);
  if (!Object.values(cyl).every((v) => Number.isFinite(v) && v > 0)) return null;

  const machine = { ...withGeom, ...cyl };
  const r = resolveJointRanges(machine);
  if (![r.alphaMin, r.alphaMax, r.deltaMin, r.deltaMax, r.psiRetracted, r.psiExtended].every(Number.isFinite)) return null;

  // 正反解回代校验（ψ 区间）
  let rtErr = 0;
  for (let i = 0; i <= 40; i++) {
    const psi = r.psiExtended + ((r.psiRetracted - r.psiExtended) * i) / 40;
    const L = bucketCylLength(machine, psi);
    const back = bucketPsiFromLength(machine, L);
    if (!Number.isFinite(L) || !Number.isFinite(back)) { rtErr = Infinity; break; }
    let d = Math.abs(back - psi);
    if (d > 180) d = 360 - d;
    rtErr = Math.max(rtErr, d);
  }

  const dev = {
    alphaMin: r.alphaMin - target.alphaMin,
    alphaMax: r.alphaMax - target.alphaMax,
    deltaMin: r.deltaMin - target.deltaMin,
    deltaMax: r.deltaMax - target.deltaMax,
    psiRetracted: r.psiRetracted - target.psiRetracted,
    psiExtended: r.psiExtended - target.psiExtended,
  };
  const layout = verifyCylinderLayout(machine);
  return { machine, geom: all, cyl, target, r, dev, bkt, rtErr, layout, boomMeta: boom.meta, armMeta: arm.meta };
}

/* ---------------- CLI ---------------- */
const isMain = (() => {
  try {
    return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const wantJson = process.argv.includes('--json');
  if (process.argv.includes('--probe-bucket')) {
    // 诊断：固定几组比例，打印四连杆构造过程的中间量
    const p = PRESETS[0];
    const psiRetracted = 90 - (p.calibration.boomAngleMax + p.calibration.armRelMax);
    const psiExtended = psiRetracted - 180;
    for (const o of [
      { dAlong: 0.9, dPerp: 0.08, eScale: 0.55, linkScale: 1.0, p5Along: 0.3, p5Perp: 0.18 },
      { dAlong: 0.85, dPerp: 0.1, eScale: 0.55, linkScale: 0.95, p5Along: 0.3, p5Perp: 0.18 },
      { dAlong: 0.92, dPerp: 0.06, eScale: 0.45, linkScale: 1.05, p5Along: 0.25, p5Perp: 0.2 },
    ]) {
      for (const branch of [1, -1]) {
        for (const dir of [-1, 1]) {
          const out = buildBucket(p, psiRetracted, psiExtended, o, branch, 0.34 * p.armLength, dir);
          console.log(`${JSON.stringify(o)} branch=${branch} dir=${dir} → 候选 ${out.length}`);
          for (const c of out) {
            const v = evalBucket(p, psiRetracted, psiExtended, c, branch);
            console.log(
              `   摇杆=${c.params.bktRockerLen} 连杆=${c.params.bktLinkLen} 行程=${Math.round(v.stroke)} 全缩=${Math.round(v.closed)} 缸间隙=${Number.isFinite(v.cylGap) ? Math.round(v.cylGap) : '—'} 连杆间隙=${Number.isFinite(v.linkGap) ? Math.round(v.linkGap) : '—'} fail=${v.fail ?? 'OK'}`,
            );
          }
        }
      }
    }
    process.exit(0);
  }
  const results = PRESETS.map((p) => ({ p, s: setupCylinders(p) }));

  if (wantJson) {
    console.log(JSON.stringify(results.map((x) => ({ id: x.p.id, geom: x.s?.geom, cyl: x.s?.cyl })), null, 2));
    process.exit(0);
  }

  let worstAll = 0;
  for (const { p, s } of results) {
    console.log('');
    console.log('='.repeat(92));
    console.log(`机型：${p.name}  [${p.id}]`);
    console.log('='.repeat(92));
    if (!s) {
      console.log('  ✗ 未找到可行布置');
      const psiRetracted = 90 - (p.calibration.boomAngleMax + p.calibration.armRelMax);
      const boom = designBoom(p);
      const arm = designArm(p);
      const bkt = designBucket(p, psiRetracted, psiRetracted - 180);
      console.log(`     动臂油缸: ${boom ? 'OK' : '失败'}`);
      console.log(`     斗杆油缸: ${arm ? 'OK' : '失败'}  ${JSON.stringify(designArm.stat ?? {})}`);
      console.log(`     铲斗四连杆: ${bkt ? 'OK' : '失败'}  ${JSON.stringify(designBucket.stat ?? {})}`);
      continue;
    }
    console.log(
      `  动臂油缸：缸筒端 A+(${s.geom.boomCylBodyDX}, ${s.geom.boomCylBodyDY})  杆端 (${s.geom.boomCylRodAlong}, ${s.geom.boomCylRodPerp})`,
    );
    console.log(
      `  斗杆油缸：缸筒端 自B(${s.geom.armCylBodyAlong}, ${s.geom.armCylBodyPerp}) 支座高 ${s.armMeta.bracket.toFixed(0)}mm  杆端 (${s.geom.armCylRodAlong}, ${s.geom.armCylRodPerp})  对动臂间隙 ${s.armMeta.gap.toFixed(0)}mm`,
    );
    console.log(
      `  铲斗四连杆：摇杆 ${s.geom.bktRockerLen}  连杆 ${s.geom.bktLinkLen}  摇杆铰点D 自C(${s.geom.bktBellAlong}, ${s.geom.bktBellPerp})  缸筒端 自C(${s.geom.bktCylBodyAlong}, ${s.geom.bktCylBodyPerp})  连杆销E(${s.geom.bktEAlong}, ${s.geom.bktEPerp})  摇杆扫掠 ${Number.isFinite(s.bkt.meta?.sweep) ? s.bkt.meta.sweep.toFixed(1) : '—'}°  分支 ${s.bkt.branch}`,
    );
    console.log('');
    console.log('  反解校验（目标角度 → 由缸长解出的角度）：');
    const rows = [
      ['动臂仰角下限', s.target.alphaMin, s.r.alphaMin, s.dev.alphaMin],
      ['动臂仰角上限', s.target.alphaMax, s.r.alphaMax, s.dev.alphaMax],
      ['斗杆转角下限', s.target.deltaMin, s.r.deltaMin, s.dev.deltaMin],
      ['斗杆转角上限', s.target.deltaMax, s.r.deltaMax, s.dev.deltaMax],
      ['铲斗全缩 ψ缩', s.target.psiRetracted, s.r.psiRetracted, s.dev.psiRetracted],
      ['铲斗全伸 ψ伸', s.target.psiExtended, s.r.psiExtended, s.dev.psiExtended],
    ];
    let worst = 0;
    for (const [label, t, v, d] of rows) {
      worst = Math.max(worst, Math.abs(d));
      console.log(
        `    ${label.padEnd(12)} 目标 ${t.toFixed(3).padStart(9)}°   解出 ${v.toFixed(3).padStart(9)}°   偏差 ${d.toFixed(4)}°`,
      );
    }
    worstAll = Math.max(worstAll, worst);
    console.log(`    最大偏差 ${worst.toFixed(4)}°  ${worst < 0.1 ? '✅' : '❌'}`);
    console.log('');
    console.log(
      `  油缸（安装距/行程）：动臂 ${s.cyl.boomCylClosed} / ${s.cyl.boomCylStroke}   斗杆 ${s.cyl.armCylClosed} / ${s.cyl.armCylStroke}   铲斗 ${s.cyl.bktCylClosed} / ${s.cyl.bktCylStroke}`,
    );
    console.log(`  ψ 正反解回代最大误差 ${Number.isFinite(s.rtErr) ? s.rtErr.toFixed(4) : '∞'}°`);
    console.log('  布置自检：');
    for (const c of s.layout.checks) console.log(`    ${c.ok ? '✅' : '❌'} ${c.label}  —— ${c.detail}`);
  }

  console.log('');
  console.log('把下面各机型参数块粘进 assets/core/presets.js：');
  for (const { p, s } of results) {
    if (!s) continue;
    console.log('');
    console.log(`  // ---- ${p.name} ----`);
    for (const [k, v] of Object.entries({ ...s.geom, ...s.cyl })) {
      console.log(`    ${k}: ${v},`);
    }
  }
  console.log('');
  console.log(worstAll < 0.1 ? '全部机型反解偏差 < 0.1° ✅' : `存在 ${worstAll.toFixed(3)}° 偏差 ❌`);
}

export function probeBuildDebug(p, psiRetracted, psiExtended, o) {
  const L2 = p.armLength, R3 = p.bucketRadius;
  const D = { x: o.dAlong*L2, y: o.dPerp*L2 }, C = { x: L2, y: 0 };
  const rDC = Math.hypot(C.x-D.x, C.y-D.y);
  const psiDC = Math.atan2(C.y-D.y, C.x-D.x)*180/Math.PI;
  const psiMid = (psiRetracted+psiExtended)/2;
  const psiE = 90 - psiMid + psiDC;
  const rE = o.eScale*R3;
  const e = { x: rE*Math.cos(psiE*Math.PI/180), y: rE*Math.sin(psiE*Math.PI/180) };
  const minDE = Math.abs(rDC-rE), maxDE = rDC+rE;
  const linkLen = (maxDE+minDE)/2, r7 = ((maxDE-minDE)/2)*o.margin;
  const rotd = (O,t,v) => ({ x: O.x+v.x*Math.cos(t)-v.y*Math.sin(t), y: O.y+v.x*Math.sin(t)+v.y*Math.cos(t) });
  const pin = (psi, br) => { const E = rotd(C, psi*Math.PI/180, e); const dE = Math.hypot(E.x-D.x, E.y-D.y); if (dE<1e-9||dE>r7+linkLen||dE<Math.abs(r7-linkLen)) return null; const a=(r7*r7-linkLen*linkLen+dE*dE)/(2*dE); const h=Math.sqrt(Math.max(0,r7*r7-a*a)); const ux=(E.x-D.x)/dE, uy=(E.y-D.y)/dE; return { x: D.x+a*ux-br*h*uy, y: D.y+a*uy+br*h*ux }; };
  const out = {};
  for (const br of [1,-1]) { const P0 = pin(psiRetracted, br); if (!P0) { out['br'+br] = 'no-assemble'; continue; }
    const psi7 = Math.atan2(P0.y-D.y, P0.x-D.x)*180/Math.PI; let prev = psi7, acc = 0;
    for (let i=1;i<=120;i++){ const psi = psiExtended + (psiRetracted-psiExtended)*i/120; const P7 = pin(psi, br); if(!P7){acc=NaN;break;} const raw=Math.atan2(P7.y-D.y,P7.x-D.x)*180/Math.PI; let d=raw-prev; if(d>180)d-=360; if(d<-180)d+=360; acc+=d; prev=raw; }
    out['br'+br] = { sweep: +acc.toFixed(1), r7: Math.round(r7), linkLen: Math.round(linkLen), minDE: Math.round(minDE), maxDE: Math.round(maxDE) }; }
  return out; }

