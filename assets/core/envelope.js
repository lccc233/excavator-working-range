/**
 * 作业范围包络（八段圆弧作图法）
 * ==========================================================================
 *
 * 包络不是「斗齿尖可达域的边界」，而是按下面这套作图法画出来的**闭合轮廓**：
 * 起始姿态定好之后，每次只动一个油缸、其余两个保持不动，齿尖就画出一段圆弧；
 * 八段首尾相接，正好绕回起点。
 *
 *   起点：动臂油缸最长（α = αmax）、斗杆油缸最短（Δ = Δmax）、铲斗油缸最短（ψ = ψmax）
 *
 *   ① 顺时针转铲斗（伸出铲斗缸，动臂/斗杆不动）→ 至 A、C、T 共线（齿尖在 C 外侧）
 *   ② 顺时针转动臂（收回动臂缸）→ 至动臂缸最短（α = αmin）
 *   ③ 顺时针转斗杆（伸出斗杆缸）→ 至斗杆缸最长（Δ = Δmin）
 *   ④ 顺时针转铲斗（伸出铲斗缸）→ 至 A、T、C 共线（齿尖转到朝 A 的一侧）
 *   ⑤ 逆时针转动臂（伸出动臂缸）→ 至动臂缸最长（α = αmax）
 *   ⑥ 顺时针转铲斗（伸出铲斗缸）→ 至铲斗缸最长（ψ = ψmin）
 *   ⑦ 逆时针转斗杆（收回斗杆缸）→ 至斗杆缸最短（Δ = Δmax）
 *   ⑧ 逆时针转铲斗（收回铲斗缸）→ 至铲斗缸最短（ψ = ψmax），回到起点
 *
 * 其中 A = 动臂根部铰点、C = 斗杆末端（铲斗）铰点、T = 铲斗齿尖。
 * ①②段给出最大挖掘半径圆弧，③④段给到最大挖掘深度，⑥⑦段把齿尖从机身前方收回来，
 * ⑧段回到最大挖掘高度——四个标称尺寸就落在这条线上。
 *
 * 与厂家样本图逐点叠合验证过：整条轮廓（含伸到机身下方的那一段）与样本图上的细线重合。
 *
 * 说明：这条闭合线是**作业范围**（极值包络），不是「斗齿尖严格可达域」——后者在
 * 42°~44.5° 方向上会被铲斗行程切成三段，中间空一块够不到的地方。样本图和这里都按
 * 作图法画极值包络，不画那块空当。
 */

import { solvePose, toDeg, toRad, RAD, bucketLocalShape } from './geometry.js';
import { jointRanges } from './params.js?v=20261005c';

const lerpRange = ([lo, hi], i, n) => (n <= 1 ? lo : lo + ((hi - lo) * i) / (n - 1));

const TWO_PI = 2 * Math.PI;

/**
 * 斗体轮廓的「换顶点角」：g(θ) 是若干正弦函数的逐点最大值，换顶点只可能发生在
 * 两条正弦的交点上。这些角度只与轮廓形状有关。
 *
 * 斗形现在随参数变（见 geometry.js 的「切掉一部分的半圆」），所以换顶点角不能再
 * 在模块加载时算死：geometry.js 对同一组归一化坐标返回同一个数组对象，这里就用
 * 那个数组当键缓存——同一机型（或形状相同的机型）只算一次。
 */
const profileCache = new WeakMap();

function bucketProfile(shape) {
  const hit = profileCache.get(shape);
  if (hit) return hit;

  const flat = Float64Array.from(shape.flat());
  const cross = [];
  for (let i = 0; i < shape.length; i++) {
    for (let j = i + 1; j < shape.length; j++) {
      const dx = shape[i][0] - shape[j][0];
      const dy = shape[i][1] - shape[j][1];
      if (Math.abs(dy) < 1e-12) continue; // 平行：没有交点
      const base = Math.atan2(dx, dy); // tanθ = (lx_i−lx_j)/(ly_i−ly_j)
      cross.push(base, base + Math.PI);
    }
  }
  const prof = {
    flat,
    cross: cross.map((t) => ((t % TWO_PI) + TWO_PI) % TWO_PI).sort((a, b) => a - b),
  };
  profileCache.set(shape, prof);
  return prof;
}

/** 斗体轮廓在朝向 θ 下的「最前缘系数」：g(θ) = max_v (lx·cosθ − ly·sinθ)（单位 R3） */
function bucketReachAt(prof, theta) {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  let m = -Infinity;
  const flat = prof.flat;
  for (let i = 0; i < flat.length; i += 2) {
    const v = flat[i] * c - flat[i + 1] * s;
    if (v > m) m = v;
  }
  return m;
}

/**
 * 斗体在可达朝向区间 [thetaLo, thetaHi]（宽度不超过 2π）内的最小「最前缘系数」。
 *
 * g(θ) 是若干正弦函数的逐点最大值，区间内的最小值只可能出现在端点或换顶点处，
 * 所以把换顶点角逐个比一遍就是精确解——ψ 方向不再需要取样，铲斗轮廓怎么改，
 * 最小回转半径都不会因为采样点恰好错过谷底而算错。
 */
function bucketReachMin(prof, thetaLo, thetaHi) {
  let best = Math.min(bucketReachAt(prof, thetaLo), bucketReachAt(prof, thetaHi));
  const lo = ((thetaLo % TWO_PI) + TWO_PI) % TWO_PI;
  const cross = prof.cross;
  const n = cross.length;
  if (!n) return best;
  // 二分找到第一个 ≥ lo 的换顶点角，然后绕一圈（区间宽度 ≤ 2π）
  let a = 0;
  let b = n;
  while (a < b) {
    const mid = (a + b) >> 1;
    if (cross[mid] < lo) a = mid + 1;
    else b = mid;
  }
  const start = a % n;
  for (let k = 0; k < n; k++) {
    const c = cross[(start + k) % n];
    const th = thetaLo + (((c - lo) % TWO_PI) + TWO_PI) % TWO_PI;
    if (th > thetaHi + 1e-12) break;
    const v = bucketReachAt(prof, th);
    if (v < best) best = v;
  }
  return best;
}

/**
 * 「A、C、T 三点共线」时齿尖相对斗杆的转角 ψ。
 * @param {boolean} outward true = 齿尖在 C 外侧（A–C–T），false = 齿尖朝 A 侧（A–T–C）
 */
function alignPsi(p, A, alphaDeg, deltaDeg, outward) {
  const C = solvePose(p, alphaDeg, deltaDeg, 0).C;
  const dir = toDeg(Math.atan2(C.y - A.y, C.x - A.x)) + (outward ? 0 : 180);
  let psi = dir - (alphaDeg + deltaDeg);
  while (psi > 180) psi -= 360;
  while (psi < -180) psi += 360;
  return psi;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * 计算包络。
 * @param {object} p 机型参数
 * @param {object} [opts]
 * @param {number} [opts.stepDeg=0.75] 圆弧采样角步距（度）
 * @param {number} [opts.tol=1]        Douglas–Peucker 简化容差 (mm)
 * @returns {{A:{x,y}, outer:Array<{x,y}>, region:Array<{x,y}>, segments:Array, bounds:object, sampling:object}}
 *          outer / region 都是同一条闭合折线（首尾相接，不含重复末点）
 */
export function computeEnvelope(p, opts = {}) {
  const r = jointRanges(p);
  const A = { x: p.pivotX, y: p.pivotY };
  const [aMin, aMax] = r.alpha;
  const [dMin, dMax] = r.delta; // 斗杆缸全缩 → Δmax（伸出 = 收拢 = Δ 减小）
  const [pMin, pMax] = r.psi; // 标准布置：全伸收斗 → ψ 最小，全缩开斗 → ψ 最大
  const stepDeg = Math.max(0.1, opts.stepDeg ?? 0.75);
  const tol = opts.tol ?? 1;

  const pts = [];
  const segments = [];
  const push = (alpha, delta, psi) => {
    const T = solvePose(p, alpha, delta, psi).T;
    const last = pts[pts.length - 1];
    if (last && Math.hypot(last.x - T.x, last.y - T.y) < 1e-9) return;
    pts.push({ x: T.x, y: T.y });
  };
  /** 只动一个参数，其余保持不动：齿尖画出一段圆弧 */
  const arc = (which, from, to, alpha, delta, psi) => {
    const i0 = pts.length;
    const n = Math.max(2, Math.ceil(Math.abs(to - from) / stepDeg));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      push(
        which === 'a' ? from + (to - from) * t : alpha,
        which === 'd' ? from + (to - from) * t : delta,
        which === 'p' ? from + (to - from) * t : psi,
      );
    }
    segments.push({
      index: segments.length + 1,
      which: which === 'a' ? 'boom' : which === 'd' ? 'arm' : 'bucket',
      from: +from.toFixed(3), // 该段参数的起值（度）
      to: +to.toFixed(3), // 该段参数的终值（度）
      ptFrom: i0, // 在 outer 点列中的起止序号
      ptTo: pts.length - 1,
    });
  };

  const psi1 = clamp(alignPsi(p, A, aMax, dMax, true), pMin, pMax); // ①末：A–C–T 共线
  const psi2 = clamp(alignPsi(p, A, aMin, dMin, false), pMin, pMax); // ④末：A–T–C 共线

  arc('p', pMax, psi1, aMax, dMax, 0); // ① 齿尖从最大挖掘高度转到 A–C–T 共线
  arc('a', aMax, aMin, 0, dMax, psi1); // ② 动臂缸收到底 → 最大挖掘半径圆弧
  arc('d', dMax, dMin, aMin, 0, psi1); // ③ 斗杆缸伸到头
  arc('p', psi1, psi2, aMin, dMin, 0); // ④ 齿尖自外向内扫过 → 最大挖掘深度
  arc('a', aMin, aMax, 0, dMin, psi2); // ⑤ 动臂抬到最高
  arc('p', psi2, pMin, aMax, dMin, 0); // ⑥ 铲斗缸伸到头（卸料位）
  arc('d', dMin, dMax, aMax, 0, pMin); // ⑦ 斗杆缸收到底
  arc('p', pMin, pMax, aMax, dMax, 0); // ⑧ 铲斗缸收到底 → 回到起点

  const closed = pts.length > 2 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) < 1e-6;
  const outer = simplify(pts, tol);
  return {
    A,
    outer,
    // 闭合轮廓：region 与 outer 同源，画图时用同一条 path 填充 + 描边
    region: outer,
    segments,
    closed,
    bounds: boundsOf(outer),
    sampling: { stepDeg, tol, points: pts.length },
  };
}

/* ------------------------------------------------------------------ *
 * 几何工具
 * ------------------------------------------------------------------ */

export function boundsOf(points) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const pt of points) {
    if (pt.x < minX) minX = pt.x;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.y > maxY) maxY = pt.y;
  }
  if (!Number.isFinite(minX)) return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  return { minX, maxX, minY, maxY };
}

/** Douglas–Peucker 折线简化（保留首尾点） */
export function simplify(points, tol) {
  if (points.length <= 2 || !(tol > 0)) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];

  while (stack.length) {
    const [s, e] = stack.pop();
    if (e - s < 2) continue;
    const a = points[s];
    const b = points[e];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    let maxD = -1;
    let maxI = -1;
    for (let i = s + 1; i < e; i++) {
      const pt = points[i];
      const d =
        len < 1e-9
          ? Math.hypot(pt.x - a.x, pt.y - a.y)
          : Math.abs(dy * pt.x - dx * pt.y + b.x * a.y - b.y * a.x) / len;
      if (d > maxD) {
        maxD = d;
        maxI = i;
      }
    }
    if (maxD > tol) {
      keep[maxI] = 1;
      stack.push([s, maxI], [maxI, e]);
    }
  }

  const out = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

/**
 * 最小回转半径
 * --------------------------------------------------------------------------
 * 定义：工作装置收拢到最紧凑姿态时，回转中心到「工作装置最前缘」的水平距离。
 * 注意它并不包含机尾——机尾另有「尾部回转半径」这个独立参数。
 *
 * 实现上取工作装置全部轮廓点 x 坐标的最大值，再对所有姿态取最小。
 */
export function computeMinSwingRadius(p, opts = {}) {
  const n = opts.samples ?? 25;
  const r = jointRanges(p);
  const prof = bucketProfile(bucketLocalShape(p));

  const halfBoom = (p.boomWidth ?? 520) / 2;
  const halfArm = (p.armWidth ?? 340) / 2;
  // 下限取回转平台前端：工作装置再怎么收，机器最前缘也不会缩到平台里面去。
  const platformFloor = Math.max(0, p.platformFront ?? 0);
  const psiLo = Math.min(r.psi[0], r.psi[1]);
  const psiHi = Math.max(r.psi[0], r.psi[1]);
  const span = psiHi - psiLo;

  let best = Infinity;
  // 斗体项只与「斗体绝对角」有关：α、δ 取规则网格时 θlo 的不同取值远少于 (α,δ) 组合数，
  // 按 θlo 记忆一下就能省掉大部分重复计算（纯函数，结果不变）。
  const reachMemo = new Map();
  const spanRad = toRad(span);
  for (let i = 0; i < n; i++) {
    const alpha = lerpRange(r.alpha, i, n);
    for (let j = 0; j < n; j++) {
      const delta = lerpRange(r.delta, j, n);
      // C 点只与 α、δ 有关，ψ 只让斗体绕 C 转，所以 ψ 方向可以精确求解（见 bucketReachMin）
      const pose = solvePose(p, alpha, delta, psiLo);
      const thetaLo = toRad(pose.bucketAbsDeg);
      const key = thetaLo.toFixed(9);
      let reach = reachMemo.get(key);
      if (reach === undefined) {
        reach = p.bucketRadius * bucketReachMin(prof, thetaLo, thetaLo + spanRad);
        if (reachMemo.size < 4096) reachMemo.set(key, reach);
      }
      const m = Math.max(
        pose.A.x + halfBoom,
        pose.B.x + halfBoom,
        platformFloor,
        pose.C.x + halfArm,
        pose.C.x + reach,
      );
      if (m < best) best = m;
    }
  }
  return best;
}

/** 从包络直接读出可交叉校验的极值 */
export function envelopeExtremes(env) {
  let maxX = -Infinity;
  let maxY = -Infinity;
  let minY = Infinity;
  for (const pt of env.outer) {
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y > maxY) maxY = pt.y;
    if (pt.y < minY) minY = pt.y;
  }
  return { maxX, maxY, maxDepth: -minY };
}
