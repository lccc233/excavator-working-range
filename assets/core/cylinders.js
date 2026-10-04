/**
 * 油缸—连杆机构正/反解
 * ==========================================================================
 *
 * 引入这一层之后，关节角不再是直接输入量，而是由三个油缸的
 * 「安装位置 + 安装距 + 行程」反解出来的派生量：
 *
 *   动臂油缸  缸筒端在转台（整机坐标），活塞杆端在动臂   → 解出动臂仰角 α
 *   斗杆油缸  缸筒端在动臂上表面，活塞杆端在斗杆上表面   → 解出斗杆相对转角 Δ
 *   铲斗油缸  缸筒端在斗杆上表面，活塞杆端在摇臂长臂；
 *             摇臂绕斗杆上的铰点 D 转动，短臂经连杆拉动铲斗上的铰点 E
 *             （标准的 斗杆–摇臂–连杆–铲斗 四连杆） → 解出铲斗相对转角 ψ
 *
 * 坐标系约定（与界面上的输入口径完全一致）
 * ---------------------------------------------------------------
 *   整机坐标系   原点 = 回转中心在停机面的投影，+x 向前（挖掘侧），+y 向上
 *   动臂坐标系   原点 A（动臂根部铰点），+x 指向 B。
 *                动臂油缸缸筒端以「相对 A 的 dx/dy」给出（dx 一般取正值，
 *                即缸筒端在 A 的前下方，装在转台前部）；
 *                斗杆油缸缸筒端以 (沿动臂, 垂直动臂) 给出，一般位于动臂上表面。
 *   斗杆坐标系   原点 B，+x 指向 C。
 *                斗杆油缸活塞杆端以 (沿斗杆, 垂直斗杆) 给出——真机布置里
 *                该铰点位于 B 点后方、斗杆上平面，即「沿斗杆为负、垂直斗杆为正」。
 *   铲斗坐标系   原点 C，+x 指向斗齿尖 T
 *
 * 伸出方向约定
 * ---------------------------------------------------------------
 *   动臂油缸伸出 → 动臂抬起（α 增大）
 *   斗杆油缸伸出 → 斗杆向内收拢（Δ 减小，即挖掘方向）
 *   铲斗油缸全缩 → 收斗（ψ 增大，最大挖掘高度方向）；全伸 → 卸料
 *   三者都由安装几何唯一决定，verifyCylinderLayout() 会逐条校验，
 *   界面上的「行程/安装距」比例也一并检查，防止调出装不上的机构。
 *
 * 所有反解都是解析闭式（余弦定理 + 圆交点），没有迭代，可实时调用。
 */

import { toRad, toDeg, clamp } from './geometry.js';

/** 在某个连杆坐标系里：把局部坐标 (a,b) 旋转 t 弧度后叠加到原点 O 上 */
function rot(O, t, a, b) {
  const c = Math.cos(t);
  const s = Math.sin(t);
  return { x: O.x + a * c - b * s, y: O.y + a * s + b * c };
}

/* ================================================================== *
 * 一、动臂油缸：解动臂仰角 α
 * ================================================================== */

/**
 * 动臂油缸缸筒端铰点的整机坐标。
 * 输入是「相对动臂根部铰点 A 的偏移」——x 一般取正值（在 A 前方），
 * y 一般取负值（在 A 下方，装在转台前部）。
 */
export function boomCylBodyPoint(p) {
  return { x: p.pivotX + p.boomCylBodyDX, y: p.pivotY + p.boomCylBodyDY };
}

/**
 * 动臂油缸活塞杆端在动臂坐标系（原点 A，+x 指向 B，+y 指向动臂上方）里的真实坐标。
 *
 * 参数就是动臂坐标系的垂直坐标本身，不做任何换算：
 * 真机该铰点落在动臂两端点 A–B 连线的**另一侧**（+y 的反侧，即动臂下侧），
 * 所以取负值。杆端在动臂两端点连线哪一侧，就看这个值的正负，不要在这里翻符号。
 */
function boomRodLocal(p) {
  return { along: p.boomCylRodAlong, perp: p.boomCylRodPerp };
}

/** 正解：给定动臂仰角，算油缸长度 */
export function boomCylLength(p, alphaDeg) {
  const P1 = boomCylBodyPoint(p);
  const A = { x: p.pivotX, y: p.pivotY };
  const L = boomRodLocal(p);
  const P2 = rot(A, toRad(alphaDeg), L.along, L.perp);
  return Math.hypot(P2.x - P1.x, P2.y - P1.y);
}

/** 反解：给定油缸长度，算动臂仰角。长度随仰角单调递增，取唯一分支。 */
export function boomAngleFromLength(p, L) {
  const dx = p.boomCylBodyDX;
  const dy = p.boomCylBodyDY;
  const d = Math.hypot(dx, dy);
  const phiA = Math.atan2(dy, dx); // A→缸筒端 的方向
  const loc = boomRodLocal(p);
  const r2 = Math.hypot(loc.along, loc.perp);
  const beta2 = Math.atan2(loc.perp, loc.along); // 活塞杆端相对动臂轴线的偏角
  if (!(d > 1e-9) || !(r2 > 1e-9)) return NaN;
  const cosT = (d * d + r2 * r2 - L * L) / (2 * d * r2);
  return toDeg(phiA - beta2 + Math.acos(clamp(cosT, -1, 1)));
}

/* ================================================================== *
 * 二、斗杆油缸：解斗杆相对转角 Δ
 * ================================================================== */

/**
 * 正解：给定斗杆相对转角，算油缸长度。
 * 两个安装点分别固定在动臂和斗杆上，所以长度只取决于 Δ，与动臂仰角无关。
 *
 * ⚠️ 缸筒端现在按「动臂坐标系（原点 = 动臂末端销孔 B，+x 指向动臂根部为负）」给坐标，
 *    这样改「动臂长度」时安装点跟着 B 一起走，不会留在离 A 固定的老位置上。
 */
export function armCylLength(p, deltaDeg) {
  const vx = p.armCylBodyAlong;
  const vy = p.armCylBodyPerp;
  const w = rot({ x: 0, y: 0 }, toRad(deltaDeg), p.armCylRodAlong, p.armCylRodPerp);
  return Math.hypot(vx - w.x, vy - w.y);
}

/**
 * 斗杆油缸活塞杆端相对「动臂两端点连线 A–B」的垂直距离（mm，正 = 在连线上方）。
 *
 * 口径与 boomCylRodPerp 完全一致，可以并排看：
 *   动臂坐标系原点取 B，+x 沿 A→B，+y 指向动臂上方；A–B 连线就是这个坐标系的 x 轴。
 *   杆端是斗杆上的点，随斗杆转过 Δ，所以它在动臂坐标系里的 y 分量就是本函数：
 *       y = |w|·sin(Δ + θ)，w = (armCylRodAlong, armCylRodPerp)，θ = atan2(perp, along)
 *   符号为正即落在动臂两端点连线上方。
 */
export function armRodPerpInBoom(p, deltaDeg) {
  const t = toRad(deltaDeg);
  return p.armCylRodAlong * Math.sin(t) + p.armCylRodPerp * Math.cos(t);
}

/** dL/dΔ 的符号：∝ V × u，u 为杆端相对 B 的向量、V 为缸筒端相对 B 的向量。沿同一支不变。 */
function armSlopeSign(p, deltaDeg) {
  const t = toRad(deltaDeg);
  const ux = p.armCylRodAlong * Math.cos(t) - p.armCylRodPerp * Math.sin(t);
  const uy = p.armCylRodAlong * Math.sin(t) + p.armCylRodPerp * Math.cos(t);
  return Math.sign(p.armCylBodyAlong * uy - p.armCylBodyPerp * ux) || 0;
}

/**
 * 圆交点的一支：Δ = φ ± acos(cosθ)，s = +1 取「+」支、−1 取「−」支。
 * 返回「度」；安装几何退化（缸长与安装点共线）时返回 NaN。
 */
function armRootAt(p, L, s) {
  const vx = p.armCylBodyAlong;
  const vy = p.armCylBodyPerp;
  const a4 = p.armCylRodAlong;
  const b4 = p.armCylRodPerp;
  const v2 = vx * vx + vy * vy;
  const r4sq = a4 * a4 + b4 * b4;
  // V·Rot(Δ)w = P·cosΔ + Q·sinΔ = R·cos(Δ − φ)，且 R = |V|·|w|
  const P = vx * a4 + vy * b4;
  const Q = -vx * b4 + vy * a4;
  const R = Math.hypot(P, Q);
  if (!(R > 1e-9)) return NaN;
  const phi = Math.atan2(Q, P);
  const cosT = (v2 + r4sq - L * L) / (2 * R);
  const acosT = Math.acos(clamp(cosT, -1, 1));
  return toDeg(phi + s * acosT);
}

/**
 * 某一支在整条行程上的杆端垂直坐标范围。
 *
 * y(Δ) 是 Δ 的正弦函数（周期 360°），所以区间内极值只可能出现在两个行程端点
 * 或内部驻点 Δ = 90° − θ（极大）与 Δ = −90° − θ（极小）处——这里逐个精确取到，
 * 不做取样近似，免得支的判定在阈值附近抖动。
 */
function armBranchSpan(p, s, lo, hi) {
  const d1 = armRootAt(p, lo, s);
  const d2 = armRootAt(p, hi, s);
  if (!Number.isFinite(d1) || !Number.isFinite(d2)) return null;
  const a = Math.min(d1, d2);
  const b = Math.max(d1, d2);
  let min = Math.min(armRodPerpInBoom(p, a), armRodPerpInBoom(p, b));
  let max = Math.max(armRodPerpInBoom(p, a), armRodPerpInBoom(p, b));
  const theta = toDeg(Math.atan2(p.armCylRodPerp, p.armCylRodAlong));
  for (const t of [-90 - theta, 90 - theta, -90 - theta + 360, 90 - theta - 360]) {
    if (t > a && t < b) {
      const v = armRodPerpInBoom(p, t);
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return { min, max, deltaLo: d1, deltaHi: d2 };
}

/**
 * 设计装配支（现行判据）：dL/dΔ 在 Δ 处的符号与安装几何自带的符号一致。
 * 该符号沿一支不变，所以只需在其中一处判一次即可定支。
 */
function designBranch(p, lo, hi) {
  const vx = p.armCylBodyAlong;
  const vy = p.armCylBodyPerp;
  const a4 = p.armCylRodAlong;
  const b4 = p.armCylRodPerp;
  const sense = Math.sign(b4 * vx - a4 * vy) || 1;
  const Lmid = (lo + hi) / 2;
  for (const s of [1, -1]) {
    const d = armRootAt(p, Lmid, s);
    if (Number.isFinite(d) && armSlopeSign(p, d) === sense) return s;
  }
  return 1; // 与旧实现一致：两条都不带设计符号时取「+」支
}

const armBranchCache = new Map();

/**
 * 装配支判定（按参数取值签名缓存，与关节角范围缓存同步失效）。
 *
 * ⚠️ 支是「这台机器的装配方案」，只跟安装几何与行程有关，与当前缸长无关。
 *    若把它做成「每个缸长各自挑一个解」，行程中一旦判据翻面，图上的斗杆会
 *    整支跳过去（实测有 5% 的参数组会跳几十度到三百多度）。所以这里一次定支、
 *    全程沿用，L → Δ 才是连续单调的。
 *
 * 判据优先级：
 *   ① 用户口径 —— 活塞杆端必须落在动臂两端点连线 A–B 上方：整条行程都在上方的
 *      那一支才是真机装配支（真机斗杆油缸装在动臂上表面，杆端铰点全程高于 A–B 连线）。
 *   ② 两支都在上方 / 都不在上方（该口径不判别）时，退回设计支判据（见 designBranch）。
 */
function armBranchInfo(p) {
  const key = RANGE_CACHE_KEYS.map((k) => p[k]).join('|');
  const hit = armBranchCache.get(key);
  if (hit) return hit;

  const Lc = p.armCylClosed;
  const Lo = p.armCylClosed + p.armCylStroke;
  const lo = Math.min(Lc, Lo);
  const hi = Math.max(Lc, Lo);

  const sp1 = armBranchSpan(p, 1, lo, hi);
  const sp2 = armBranchSpan(p, -1, lo, hi);
  const up1 = !!sp1 && sp1.min > 0;
  const up2 = !!sp2 && sp2.min > 0;

  const branch = up1 !== up2 ? (up1 ? 1 : -1) : designBranch(p, lo, hi);
  const span = (branch === 1 ? sp1 : sp2) ?? armBranchSpan(p, branch, lo, hi);

  const info = {
    branch,
    minPerp: span ? span.min : NaN,
    maxPerp: span ? span.max : NaN,
    above: !!span && span.min > 0,
  };
  if (armBranchCache.size >= RANGE_CACHE_MAX) armBranchCache.clear();
  armBranchCache.set(key, info);
  return info;
}

/**
 * 反解：给定油缸长度，算斗杆相对转角。
 *
 * 余弦定理给出两个解（Δ = φ ± acos），它们对应「同一条缸长下活塞杆端落在
 * V–B 连线两侧」的两个装配姿态，只有一个是这台机器的实际姿态——支的判定见
 * armBranchInfo()，与缸长无关，因此本函数沿支连续、单调，不会中途跳支。
 */
export function armDeltaFromLength(p, L) {
  return armRootAt(p, L, armBranchInfo(p).branch);
}

/**
 * 装配支的杆端垂直坐标范围（相对 A–B 连线，mm）。
 * 供「油缸布置自检」与参数表使用：min > 0 即全程都在动臂两端点连线上方。
 */
export function armRodPerpSpan(p) {
  const info = armBranchInfo(p);
  return { min: info.minPerp, max: info.maxPerp, above: info.above, branch: info.branch };
}

/* ================================================================== *
 * 三、铲斗油缸 + 摇臂 + 连杆 + 铲斗（四连杆）
 * ================================================================== */

/**
 * 铲斗连杆机构（反向铲的标准形式：两根「两铰点杆」）
 * ---------------------------------------------------------------------------
 *   摇杆：一端铰接在斗杆上的 D 点，另一端 P 与铲斗油缸活塞杆、连杆共用一个销轴
 *   连杆：一端与摇杆在 P 点共铰，另一端铰接在铲斗上的 E 点
 *
 * 也就是说 P 点上有三个构件（摇杆、活塞杆、连杆），不存在「三角形摇臂」；
 * 斗杆—摇杆—连杆—铲斗构成四连杆，铲斗油缸通过推动 P 点驱动整套机构。
 *
 * 几何全部在斗杆坐标系里（原点 B，+x 指向 C），与 Δ、α 无关。
 */
function bucketLinkageGeom(p) {
  const C = { x: p.armLength, y: 0 };
  // ⚠️ 摇杆铰点 D、铲斗油缸缸筒端都按「自斗杆末端销孔 C 起算」给坐标
  //    （沿斗杆向根部方向为负），这样改「斗杆长度」时它俩跟着 C 一起走。
  return {
    C,
    D: { x: C.x + p.bktBellAlong, y: p.bktBellPerp }, // 摇杆在斗杆上的铰点
    P5: { x: C.x + p.bktCylBodyAlong, y: p.bktCylBodyPerp }, // 铲斗油缸缸筒端（斗杆上方）
    rocker: p.bktRockerLen, // 摇杆长度 D→P
    e: { x: p.bktEAlong, y: p.bktEPerp }, // 连杆–铲斗铰点（相对 C，铲斗坐标系）
    linkLen: p.bktLinkLen, // 连杆长度
    branch: p.bktBranch >= 0 ? 1 : -1, // 圆交点的两支装配方案
  };
}

/** 圆–圆交点：求 P，使其到 D 距离 r、到 E 距离 linkLen（P 即摇杆端/活塞杆端/连杆端共用的销轴） */
export function solveRockerJoint(D, r, E, linkLen, branch) {
  const dx = E.x - D.x;
  const dy = E.y - D.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-9) return null;
  if (d > r + linkLen || d < Math.abs(r - linkLen)) return null; // 装配不上
  const a = (r * r - linkLen * linkLen + d * d) / (2 * d);
  const h2 = r * r - a * a;
  const h = Math.sqrt(Math.max(0, h2));
  const ux = dx / d;
  const uy = dy / d;
  return { x: D.x + a * ux - branch * h * uy, y: D.y + a * uy + branch * h * ux };
}

/**
 * 正解：给定铲斗相对转角 ψ，求油缸长度。
 * E 由 ψ 定出 → P 由「摇杆 + 连杆」两个圆的交点定出 → 缸长 = |P5 − P|。
 */
export function bucketCylLength(p, psiDeg) {
  const g = bucketLinkageGeom(p);
  const E = rot(g.C, toRad(psiDeg), g.e.x, g.e.y);
  const P = solveRockerJoint(g.D, g.rocker, E, g.linkLen, g.branch);
  if (!P) return NaN;
  return Math.hypot(P.x - g.P5.x, P.y - g.P5.y);
}

/** 给定 ψ，解出摇杆端（共用销轴）P 的斗杆坐标 */
export function rockerJointAt(p, psiDeg) {
  const g = bucketLinkageGeom(p);
  const E = rot(g.C, toRad(psiDeg), g.e.x, g.e.y);
  const P = solveRockerJoint(g.D, g.rocker, E, g.linkLen, g.branch);
  if (!P) return null;
  return { D: g.D, P, E, P5: g.P5 };
}

/**
 * 扫描 ψ 轴，切出「可装配且严格单调」的区段。
 *
 * 之所以不用圆交点做解析反解：四连杆有两个装配方案，两个方案在 ψ 与缸长之间
 * 都是一对多，解析式必须额外带一个装配分支参数，而分支判据在边界附近很容易选错。
 * 换成这里直接扫出单调区段，反解就退化成区段内的一维求根，
 * 不需要任何分支参数，也不会出现「误差恰好 180°」这类镜像错误。
 */
function monotonicRuns(p, step = 1.5, lo = -195, hi = 195) {
  const runs = [];
  let cur = null;
  let prev = null;
  for (let psi = lo; psi <= hi + 1e-9; psi += step) {
    const L = bucketCylLength(p, psi);
    if (!Number.isFinite(L)) {
      if (cur) runs.push(cur);
      cur = null;
      prev = null;
      continue;
    }
    if (!prev) {
      cur = { psi0: psi, psi1: psi, L0: L, L1: L, dir: 0 };
      prev = { psi, L };
      continue;
    }
    const d = L - prev.L;
    if (Math.abs(d) < 1e-6) {
      if (cur) runs.push(cur);
      cur = null;
      prev = { psi, L };
      continue;
    }
    const s = Math.sign(d);
    if (!cur || cur.dir === 0) {
      if (cur) { cur.dir = s; cur.psi1 = psi; cur.L1 = L; }
    } else if (s === cur.dir) {
      cur.psi1 = psi;
      cur.L1 = L;
    } else {
      runs.push(cur);
      cur = { psi0: prev.psi, psi1: psi, L0: prev.L, L1: L, dir: s };
    }
    prev = { psi, L };
  }
  if (cur) runs.push(cur);
  for (const r of runs) {
    r.Lmin = Math.min(r.L0, r.L1);
    r.Lmax = Math.max(r.L0, r.L1);
    r.span = Math.abs(r.psi1 - r.psi0);
  }
  return runs;
}

/** 在单调区段内二分求 L 对应的 ψ */
function psiAtL(p, run, L) {
  let a = Math.min(run.psi0, run.psi1);
  let b = Math.max(run.psi0, run.psi1);
  const dir = run.dir || 1;
  for (let i = 0; i < 80; i++) {
    const m = (a + b) / 2;
    const lm = bucketCylLength(p, m);
    if (!Number.isFinite(lm)) break;
    // 区段内 L 关于 ψ 单调，dir>0 时 L 随 ψ 增大
    if ((lm - L) * dir > 0) b = m;
    else a = m;
  }
  return (a + b) / 2;
}

/** 正解：给定油缸长度，算铲斗相对转角 ψ（在整条工作区段内求根） */
export function bucketPsiFromLength(p, L) {
  const runs = monotonicRuns(p);
  const lo = Math.min(p.bktCylClosed, p.bktCylClosed + p.bktCylStroke);
  const hi = Math.max(p.bktCylClosed, p.bktCylClosed + p.bktCylStroke);
  let best = null;
  for (const r of runs) {
    if (r.Lmin <= lo + 1e-6 && r.Lmax >= hi - 1e-6) {
      if (!best || r.span > best.span) best = r;
    }
  }
  if (!best) return NaN;
  return psiAtL(p, best, L);
}

/* ================================================================== *
 * 四、供绘图使用：给定姿态，解出三个油缸与铲斗连杆各铰点的整机坐标
 * ================================================================== */

/** 把斗杆坐标系里的点搬到整机坐标：B + Rot(γ)·(a, b) */
function armToWorld(B, gammaRad, a, b) {
  const c = Math.cos(gammaRad);
  const s = Math.sin(gammaRad);
  return { x: B.x + a * c - b * s, y: B.y + a * s + b * c };
}

/**
 * @param {object} p 机型参数
 * @param {object} pose solvePose 的结果（含 A/B/C/T、alphaDeg、armAbsDeg、psiDeg）
 * @returns {null|{boom,arm,bucket,bellcrank,link,points}} 各段端点的整机坐标
 */
export function cylinderPose(p, pose) {
  if (!pose || !Number.isFinite(pose.alphaDeg) || !Number.isFinite(pose.psiDeg)) return null;
  const aRad = toRad(pose.alphaDeg);
  const gRad = toRad(pose.armAbsDeg);
  const psiRad = toRad(pose.psiDeg);
  const A = pose.A;
  const B = pose.B;

  const world = (O, t, a, b) => ({
    x: O.x + a * Math.cos(t) - b * Math.sin(t),
    y: O.y + a * Math.sin(t) + b * Math.cos(t),
  });

  // 动臂油缸：缸筒端固定于转台，活塞杆端随动臂（垂直动臂坐标即为参数本身，见 boomRodLocal）
  const boomLoc = boomRodLocal(p);
  const boom = {
    body: boomCylBodyPoint(p),
    rod: world(A, aRad, boomLoc.along, boomLoc.perp),
  };

  // 斗杆油缸：缸筒端在动臂上表面（自动臂末端销孔 B 起算，随 B 移动），活塞杆端在斗杆上表面
  const arm = {
    body: world(B, aRad, p.armCylBodyAlong, p.armCylBodyPerp),
    rod: world(B, gRad, p.armCylRodAlong, p.armCylRodPerp),
  };

  // 铲斗四连杆：全部先在斗杆坐标系里解，再统一搬到整机坐标。
  // ⚠️ 指标姿态里有一个「斗底贴壁」姿态（ψ = 斗底安装角），它可能超出铲斗油缸
  //    能驱动的 ψ 区间——那是几何定义姿态、不是可达姿态。绘图时把 ψ 收到
  //    机构能装上的极限，避免图上出现「装不上的连杆」。
  const g = bucketLinkageGeom(p);
  const assembleAt = (psi) => {
    const E = rot(g.C, toRad(psi), g.e.x, g.e.y);
    return solveRockerJoint(g.D, g.rocker, E, g.linkLen, g.branch) ? E : null;
  };
  let psiUse = pose.psiDeg;
  let Earm = assembleAt(psiUse);
  if (!Earm) {
    const R = resolveJointRanges(p);
    const lo = Number.isFinite(R.psiMin) ? R.psiMin : -180;
    const hi = Number.isFinite(R.psiMax) ? R.psiMax : 180;
    const target = Math.min(Math.max(psiUse, lo), hi);
    if (assembleAt(target)) {
      psiUse = target;
      Earm = assembleAt(target);
    } else {
      // 区间内也不行（参数被改坏）时，二分找到最近的可装配角
      let a = psiUse;
      let b = target;
      for (let i = 0; i < 40; i++) {
        const m = (a + b) / 2;
        if (assembleAt(m)) b = m;
        else a = m;
      }
      psiUse = b;
      Earm = assembleAt(b);
    }
  }
  const Parm = Earm ? solveRockerJoint(g.D, g.rocker, Earm, g.linkLen, g.branch) : null;

  return {
    boom,
    arm,
    // 铲斗油缸：缸筒端在斗杆上，活塞杆端与摇杆端共用一个销轴 P
    bucket: {
      body: armToWorld(B, gRad, g.P5.x, g.P5.y),
      rod: Parm ? armToWorld(B, gRad, Parm.x, Parm.y) : null,
    },
    // 摇杆：斗杆上 D 点 ↔ 共用销轴 P（连杆也铰在 P 上）
    rocker: {
      pivot: armToWorld(B, gRad, g.D.x, g.D.y),
      joint: Parm ? armToWorld(B, gRad, Parm.x, Parm.y) : null,
    },
    link: {
      from: Parm ? armToWorld(B, gRad, Parm.x, Parm.y) : null,
      to: Earm ? armToWorld(B, gRad, Earm.x, Earm.y) : null,
    },
  };
}

/* ================================================================== *
 * 五、关节角范围（由油缸行程推导）
 * ================================================================== */

/**
 * 关节角范围的缓存。
 *
 * ⚠️ 这里必须按「取值签名」缓存，不能按对象身份（WeakMap）缓存。
 * 界面上的滑块是就地修改同一个 params 对象的，若按对象身份缓存，
 * 第一次算完就把结果钉死了——拖动油缸行程滑块时关节角范围纹丝不动，
 * 图和指标全都不更新（这个坑真实踩过）。
 */
const RANGE_CACHE_KEYS = [
  'pivotX', 'pivotY', 'boomLength', 'armLength', 'bucketRadius',
  'boomCylBodyDX', 'boomCylBodyDY', 'boomCylRodAlong', 'boomCylRodPerp', 'boomCylClosed', 'boomCylStroke',
  'armCylBodyAlong', 'armCylBodyPerp', 'armCylRodAlong', 'armCylRodPerp', 'armCylClosed', 'armCylStroke',
  'bktCylBodyAlong', 'bktCylBodyPerp', 'bktCylClosed', 'bktCylStroke',
  'bktBellAlong', 'bktBellPerp', 'bktRockerLen',
  'bktEAlong', 'bktEPerp', 'bktLinkLen', 'bktBranch',
];
const RANGE_CACHE_MAX = 64;
const rangeCache = new Map();

/** 清空关节角范围缓存与斗杆装配支缓存（测试用；界面改参数后也必须一起清） */
export function clearRangeCache() {
  rangeCache.clear();
  armBranchCache.clear();
}

/**
 * 由「安装距 + 行程」推出全部关节角范围。
 * 这是整个模型里唯一的关节角来源——metrics / envelope 都从这里取，
 * 保证不会出现「油缸说一套、角度说另一套」的自相矛盾。
 *
 * @returns {{alphaMin,alphaMax,deltaMin,deltaMax,psiMin,psiMax,psiCurl,psiDump}}
 */
export function resolveJointRanges(p) {
  const key = RANGE_CACHE_KEYS.map((k) => p[k]).join('|');
  const hit = rangeCache.get(key);
  if (hit) return hit;

  // 区间端点由「全缩 / 全伸」两个长度解出。
  // 这里取 min/max，而不是假定「全缩一定对应下限」：
  // 界面上的伸出方向约定是「伸出 = 作业方向」，但油缸装在哪一侧决定了
  // 全缩对应区间哪一端，模型只负责给出可达区间本身。
  const a1 = boomAngleFromLength(p, p.boomCylClosed);
  const a2 = boomAngleFromLength(p, p.boomCylClosed + p.boomCylStroke);
  const d1 = armDeltaFromLength(p, p.armCylClosed);
  const d2 = armDeltaFromLength(p, p.armCylClosed + p.armCylStroke);
  const alphaMin = Math.min(a1, a2);
  const alphaMax = Math.max(a1, a2);
  const deltaMin = Math.min(d1, d2);
  const deltaMax = Math.max(d1, d2);
  const psiCurl = bucketPsiFromLength(p, p.bktCylClosed); // 铲斗油缸全缩 → 收斗
  const psiDump = bucketPsiFromLength(p, p.bktCylClosed + p.bktCylStroke); // 全伸 → 卸料

  const out = {
    alphaMin,
    alphaMax,
    deltaMin,
    deltaMax,
    psiCurl,
    psiDump,
    psiMin: Math.min(psiCurl, psiDump),
    psiMax: Math.max(psiCurl, psiDump),
  };
  if (rangeCache.size >= RANGE_CACHE_MAX) rangeCache.clear();
  rangeCache.set(key, out);
  return out;
}

/**
 * 标定工具用：给定三个油缸的安装几何与目标关节角范围，
 * 反算「安装距」与「行程」。
 *
 * 约定：安装距 = 全缩长度（两端中较短的那个），行程 = 两端之差。
 *   动臂：全缩 → 动臂最低（αmin）；全伸 → 仰角最大（αmax）
 *   斗杆：全缩 → 斗杆最外伸（Δmax）；全伸 → 斗杆收拢（Δmin）   ← 伸出即收斗杆
 *   铲斗：全缩 → 卸料（ψ卸）；全伸 → 收斗（ψ收）               ← 伸出即收斗
 * 这里统一取 min/max，避免任一机构的正负号约定不同时算出负行程。
 */
export function calibrateCylinders(p, targets) {
  const boomA = boomCylLength(p, targets.alphaMin);
  const boomB = boomCylLength(p, targets.alphaMax);
  const armA = armCylLength(p, targets.deltaMin);
  const armB = armCylLength(p, targets.deltaMax);
  const bktA = bucketCylLength(p, targets.psiCurl);
  const bktB = bucketCylLength(p, targets.psiDump);

  return {
    boomCylClosed: round1(Math.min(boomA, boomB)),
    boomCylStroke: round1(Math.abs(boomB - boomA)),
    armCylClosed: round1(Math.min(armA, armB)),
    armCylStroke: round1(Math.abs(armB - armA)),
    bktCylClosed: round1(Math.min(bktA, bktB)),
    bktCylStroke: round1(Math.abs(bktB - bktA)),
  };
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

/* ================================================================== *
 * 六、布置自检：安装点口径、伸出方向、与动臂/斗杆本体的干涉
 * ================================================================== */

/** 动臂上（下）表面相对动臂轴线的距离：截面厚度按线性收窄 */
function boomHalfThickness(p, x) {
  const t = Math.max(0, Math.min(x, p.boomLength)) / p.boomLength;
  return ((p.boomWidth ?? 500) / 2) * (1 - 0.18 * t);
}

/**
 * 油缸轴线到「动臂/斗杆本体」的最小间隙（mm，负值表示侵入）。
 * 判定方式：把油缸两端点连成弦，弦上取样点相对目标杆件轴线的法向距离，
 * 减去该处的半截面厚度即为间隙。
 * 两处豁免（真机上它们本来就是叉形/铰点区域，侧视图必然重叠）：
 *   · 靠近活塞杆端 200 mm 的一段（杆端支座本身装在目标杆件上）
 *   · 杆件长度末端 6%（动臂鼻部 / 斗杆根部铰点区）
 */
function cylinderClearance(from, to, opts) {
  const { memberLen, alongOf, halfAt, samples = 60 } = opts;
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  if (!(len > 1)) return Infinity;
  let worst = Infinity;
  for (let k = 0; k <= samples; k++) {
    const s = (k / samples) * Math.max(0, len - 200);
    const q = { x: from.x + ((to.x - from.x) * s) / len, y: from.y + ((to.y - from.y) * s) / len };
    const along = alongOf(q);
    if (Math.abs(along - memberLen / 2) > memberLen * 0.44) continue; // 末端 6% 豁免
    const gap = Math.abs(q.y) - halfAt(along); // 法向距离 − 半截面厚 = 间隙
    if (gap < worst) worst = gap;
  }
  return worst;
}

/**
 * 布置自检。返回每一项的口径检查结果，供界面告警、测试与标定工具共用。
 *
 * @returns {{ok:boolean, checks:Array<{key,label,ok,detail}>, cyl:object, clearance:object}}
 */
export function verifyCylinderLayout(p) {
  const R = resolveJointRanges(p);
  const checks = [];
  const add = (key, label, ok, detail) => checks.push({ key, label, ok: !!ok, detail });

  // ① 安装点口径。⚠️ 缸筒端/摇杆铰点的沿杆坐标一律「自末端销孔起算、向根部为负」，
  //    这样加长动臂（斗杆）时安装点自动跟着末端销孔走，不会掉到杆件外面去。
  add('boomFoot', '动臂油缸缸筒端在 A 点前下方（x>0, y<0）', p.boomCylBodyDX > 0 && p.boomCylBodyDY < 0,
    `相对 A：(${p.boomCylBodyDX}, ${p.boomCylBodyDY}) mm`);
  add('boomRod', '动臂油缸活塞杆端在动臂两端点连线的另一侧（动臂下侧，故为负）', p.boomCylRodPerp < 0,
    `${p.boomCylRodPerp} mm`);
  add('armRod', '斗杆油缸活塞杆端在 B 后方、斗杆上平面（沿斗杆<0, 垂直斗杆>0）',
    p.armCylRodAlong < 0 && p.armCylRodPerp > 0, `(${p.armCylRodAlong}, ${p.armCylRodPerp}) mm`);
  add('armBody', '斗杆油缸缸筒端在动臂上表面且在动臂范围内（自 B：−动臂长 < 沿 < 0，垂直>0）',
    p.armCylBodyAlong < 0 && p.armCylBodyAlong > -p.boomLength && p.armCylBodyPerp > 0,
    `自 B：(${p.armCylBodyAlong}, ${p.armCylBodyPerp}) mm / 动臂长 ${p.boomLength}`);
  add('bktBody', '铲斗油缸缸筒端在斗杆上方且在斗杆范围内（自 C：−斗杆长 < 沿 < 0）',
    p.bktCylBodyAlong < 0 && p.bktCylBodyAlong > -p.armLength && p.bktCylBodyPerp > 0,
    `自 C：(${p.bktCylBodyAlong}, ${p.bktCylBodyPerp}) mm / 斗杆长 ${p.armLength}`);
  add('bell', '摇杆铰点在斗杆上平面且在斗杆范围内（自 C：−斗杆长 < 沿 < 0）',
    p.bktBellAlong < 0 && p.bktBellAlong > -p.armLength && p.bktBellPerp > 0,
    `自 C：(${p.bktBellAlong}, ${p.bktBellPerp}) mm / 斗杆长 ${p.armLength}`);
  const L2 = p.armLength;
  add('rockerLen', '摇杆长度在 0.08~0.38 倍斗杆长',
    p.bktRockerLen > 0.08 * L2 && p.bktRockerLen < 0.38 * L2, `${p.bktRockerLen} mm`);
  add('linkLen', '连杆长度在 0.12~0.55 倍斗杆长',
    p.bktLinkLen > 0.12 * L2 && p.bktLinkLen < 0.55 * L2, `${p.bktLinkLen} mm`);
  add('linkPin', '连杆–铲斗铰点在斗背板上（相对 C：−0.35~0 R3、0.2~0.75 R3）',
    p.bktEAlong > -0.35 * p.bucketRadius && p.bktEAlong < 0 && p.bktEPerp > 0.2 * p.bucketRadius && p.bktEPerp < 0.75 * p.bucketRadius,
    `(${p.bktEAlong}, ${p.bktEPerp}) mm / R3=${p.bucketRadius}`);

  // ② 装配支：斗杆油缸活塞杆端必须全程落在动臂两端点连线 A–B 上方。
  //    真机斗杆油缸装在动臂上表面，杆端铰点全程高于 A–B 连线；这一条同时定出
  //    圆交点里哪一支是本机的装配支（见 armBranchInfo），所以放在伸出方向之前。
  const rodSpan = armRodPerpSpan(p);
  add('armRodAbove', '斗杆油缸活塞杆端全程在动臂两端点连线上方（相对 A–B 连线垂直 > 0）',
    rodSpan.above,
    Number.isFinite(rodSpan.min)
      ? `行程内 ${rodSpan.min.toFixed(0)} ~ ${rodSpan.max.toFixed(0)} mm`
      : '安装几何退化，解不出装配支');

  // ③ 伸出方向：三条油缸的伸出端都必须是作业重载方向
  const boomClosed = boomCylLength(p, R.alphaMin);
  const boomOpen = boomCylLength(p, R.alphaMax);
  const armClosed = armCylLength(p, R.deltaMax);
  const armOpen = armCylLength(p, R.deltaMin);
  const bktClosed = bucketCylLength(p, R.psiCurl); // 全缩 = 收斗
  const bktOpen = bucketCylLength(p, R.psiDump); // 全伸 = 卸料
  add('boomDir', '动臂油缸伸出 → 动臂抬起', boomOpen > boomClosed,
    `${boomClosed.toFixed(0)} → ${boomOpen.toFixed(0)} mm`);
  add('armDir', '斗杆油缸伸出 → 斗杆收拢（挖掘方向）', armOpen > armClosed,
    `${armClosed.toFixed(0)} → ${armOpen.toFixed(0)} mm`);
  add('bktDir', '铲斗油缸全缩 → 收斗（挖掘方向）', bktOpen > bktClosed,
    `全缩 ${bktClosed.toFixed(0)} / 全伸 ${bktOpen.toFixed(0)} mm`);

  // ④ 行程 / 安装距比例（动臂油缸本身偏小，下限放宽到 15%）
  const ratio = (c, o) => (o > 0 ? (o - c) / c : 0);
  for (const [k, label, c, o, lo] of [
    ['boomRatio', '动臂油缸', boomClosed, boomOpen, 0.15],
    ['armRatio', '斗杆油缸', armClosed, armOpen, 0.3],
    ['bktRatio', '铲斗油缸', bktClosed, bktOpen, 0.3],
  ]) {
    const r = ratio(c, o);
    add(k, `${label} 行程/安装距 在 ${(lo * 100).toFixed(0)}%~115%`, r > lo && r < 1.15, `${(r * 100).toFixed(0)}%`);
  }

  // ⑤ 干涉：斗杆油缸不与动臂本体相交，铲斗油缸不与斗杆本体相交
  //    这里的「本体」是按截面厚度近似出来的矩形带，末端 6% 与杆端 200mm 已豁免；
  //    真实动臂鼻部是叉形结构、且截面带线性收窄，因此留 20mm 建模容差。
  const worstArm = armCylClearanceVsBoom(p, 60);
  add('armClear', '斗杆油缸不侵入动臂本体（间隙 ≥ −20mm 建模容差）', worstArm >= -20,
    `最小间隙 ${worstArm.toFixed(0)} mm`);

  const bktProbe = bucketLinkClearanceVsArm(p, 60);
  add('bktClear', '铲斗油缸不侵入斗杆本体（间隙 ≥ 0）', bktProbe.assembles && bktProbe.cylGap >= 0,
    bktProbe.assembles ? `最小间隙 ${bktProbe.cylGap.toFixed(0)} mm` : '四连杆在某姿态装配不上');
  add('linkClear', '连杆不侵入斗杆本体（间隙 ≥ 0）', bktProbe.assembles && bktProbe.linkGap >= 0,
    bktProbe.assembles ? `最小间隙 ${bktProbe.linkGap.toFixed(0)} mm` : '四连杆在某姿态装配不上');
  add('linkAssemble', '四连杆在整条 ψ 区间都能装配', bktProbe.assembles, bktProbe.assembles ? 'OK' : '存在装配不上的姿态');
  return {
    ok: checks.every((c) => c.ok),
    checks,
    cyl: {
      boom: { closed: boomClosed, open: boomOpen },
      arm: { closed: armClosed, open: armOpen },
      bucket: { closed: bktClosed, open: bktOpen },
    },
    clearance: { armToBoom: worstArm, bucketToArm: bktProbe.cylGap, linkToArm: bktProbe.linkGap },
  };
}

/**
 * 斗杆油缸在整条 Δ 行程上与动臂本体的最小间隙（mm，负值 = 侵入）。
 * 斗杆油缸两端分别装在动臂与斗杆上，Δ 一定时它在动臂坐标系里的位置就定了。
 */
export function armCylClearanceVsBoom(p, samples = 40) {
  const R = resolveJointRanges(p);
  // 动臂坐标系原点在 A，B 在 (boomLength, 0)；缸筒端坐标是自 B 起算的，这里换算过来
  const from = { x: p.boomLength + p.armCylBodyAlong, y: p.armCylBodyPerp };
  let worst = Infinity;
  for (let i = 0; i <= samples; i++) {
    const d = R.deltaMin + ((R.deltaMax - R.deltaMin) * i) / samples;
    const body = rot({ x: 0, y: 0 }, toRad(d), p.armCylRodAlong, p.armCylRodPerp);
    const to = { x: p.boomLength + body.x, y: body.y };
    const gap = cylinderClearance(from, to, {
      memberLen: p.boomLength,
      alongOf: (q) => q.x,
      halfAt: (along) => boomHalfThickness(p, along),
      samples: 24,
    });
    if (gap < worst) worst = gap;
  }
  return worst;
}

/** 铲斗油缸与连杆在整条 ψ 行程上与斗杆本体的最小间隙；同时报告四连杆能否全程装配 */
export function bucketLinkClearanceVsArm(p, samples = 40) {
  const R = resolveJointRanges(p);
  const g = bucketLinkageGeom(p);
  let cylGap = Infinity;
  let linkGap = Infinity;
  const armOpt = {
    memberLen: p.armLength,
    alongOf: (q) => q.x,
    halfAt: () => (p.armWidth ?? 340) / 2,
    samples: 24,
  };
  for (let i = 0; i <= samples; i++) {
    const psi = R.psiDump + ((R.psiCurl - R.psiDump) * i) / samples;
    const E = rot(g.C, toRad(psi), g.e.x, g.e.y);
    const P = solveRockerJoint(g.D, g.rocker, E, g.linkLen, g.branch);
    if (!P) return { cylGap: -Infinity, linkGap: -Infinity, assembles: false };
    cylGap = Math.min(cylGap, cylinderClearance(g.P5, P, armOpt));
    linkGap = Math.min(linkGap, cylinderClearance(P, E, { ...armOpt, samples: 16 }));
  }
  return { cylGap, linkGap, assembles: true };
}
