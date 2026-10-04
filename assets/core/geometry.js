/**
 * 反铲液压挖掘机工作装置 —— 平面连杆运动学
 * ==========================================
 *
 * 坐标系（全部为 mm，角度为「度」）
 * ---------------------------------------------------------------
 *   原点 O = 回转中心在停机面上的投影
 *   x 轴：水平向前（挖掘侧）为正
 *   y 轴：竖直向上为正，y = 0 即停机面
 *   角度：逆时针为正，0° 指向 +x
 *
 * 连杆模型（3 连杆、3 自由度）
 * ---------------------------------------------------------------
 *   A = 动臂铰点（boom foot）        = (pivotX, pivotY)
 *   B = 动臂–斗杆铰点                = A + boomLength · u(alpha)
 *   C = 斗杆–铲斗铰点                = B + armLength  · u(alpha + delta)
 *   T = 斗齿尖（bucket tooth tip）   = C + bucketRadius · u(alpha + delta + psi)
 *
 *   其中 u(t) = (cos t, sin t)
 *
 * 关节角约定
 * ---------------------------------------------------------------
 *   alpha (动臂仰角)      绝对角，相对 +x 轴。动臂油缸全缩 → 最低 → alphaMin
 *   delta (斗杆相对转角)  相对动臂。0° = 与动臂共线前伸（斗杆油缸全缩）；
 *                         负值 = 斗杆向机身内收（向下折），这是反铲的作业方向
 *   psi   (铲斗相对转角)  相对斗杆。斗齿尖绕 C 点转动
 *
 * 单位说明：本文件内所有长度参数一律 mm，所有对外接口角度参数一律「度」，
 *          内部三角函数运算前统一转弧度。
 */

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

export const toRad = (deg) => deg * DEG;
export const toDeg = (rad) => rad * RAD;

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 归一化到 (-180, 180]（注意把 -0 归成 +0，否则 JSON 与断言里会出现 -0） */
export function normalizeDeg(deg) {
  let a = deg % 360;
  if (a <= -180) a += 360;
  if (a > 180) a -= 360;
  return a === 0 ? 0 : a;
}

/** 单位方向向量 */
export function unit(rad) {
  return { x: Math.cos(rad), y: Math.sin(rad) };
}

export const vAdd = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
export const vSub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
export const vScale = (a, s) => ({ x: a.x * s, y: a.y * s });
export const vLen = (a) => Math.hypot(a.x, a.y);
export const vDist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** 点沿角度 rad 方向前进 len 得到的新点 */
export function step(from, rad, len) {
  return { x: from.x + len * Math.cos(rad), y: from.y + len * Math.sin(rad) };
}

/**
 * 正运动学：给定三个关节角，解出 A / B / C / T 四点。
 * 纯函数，无副作用。
 */
export function solvePose(p, alphaDeg, deltaDeg, psiDeg) {
  const a = toRad(alphaDeg);
  const d = toRad(deltaDeg);
  const s = toRad(psiDeg);

  const A = { x: p.pivotX, y: p.pivotY };
  const B = step(A, a, p.boomLength);
  const armAbs = a + d;
  const C = step(B, armAbs, p.armLength);
  const bucketAbs = armAbs + s;
  const T = step(C, bucketAbs, p.bucketRadius);

  return { A, B, C, T, alphaDeg, deltaDeg, psiDeg, armAbsDeg: toDeg(armAbs), bucketAbsDeg: toDeg(bucketAbs) };
}

/* ------------------------------------------------------------------ *
 * 外形轮廓（用于绘图与最小回转半径）
 * ------------------------------------------------------------------ */

/**
 * 把一条连杆表示成沿其轴线、两端宽度不同的四边形。
 * 用于把「一条线」画成「一根有粗细的杆件」。
 */
export function taperedQuad(from, to, wFrom, wTo) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  // 轴线法向
  const nx = -dy / len;
  const ny = dx / len;

  return [
    { x: from.x + nx * wFrom * 0.5, y: from.y + ny * wFrom * 0.5 },
    { x: to.x + nx * wTo * 0.5, y: to.y + ny * wTo * 0.5 },
    { x: to.x - nx * wTo * 0.5, y: to.y - ny * wTo * 0.5 },
    { x: from.x - nx * wFrom * 0.5, y: from.y - ny * wFrom * 0.5 },
  ];
}

/**
 * 弯臂折线：真实动臂是弯的。把 A→B 拆成四段，按二次曲线（偏移 ∝ 4t(1−t)）
 * 向「下后方」平滑过渡——只用中点折一下会在图上留一个明显的硬拐角。
 * boomBend 为 0 时退化为直线。
 */
export function boomPolyline(A, B, boomBend, alphaRad) {
  if (!boomBend) return [A, B];
  // 沿动臂法向（指向机身下方）偏移
  const nx = -Math.sin(alphaRad);
  const ny = Math.cos(alphaRad);
  const k = Math.sign(boomBend) || 1;
  const off = Math.abs(boomBend) * k;
  const pts = [A];
  for (const t of [0.25, 0.5, 0.75]) {
    const s = 4 * t * (1 - t); // 二次 Bezier 的偏移分布：0.75 / 1 / 0.75
    pts.push({
      x: A.x + (B.x - A.x) * t + nx * off * s,
      y: A.y + (B.y - A.y) * t + ny * off * s,
    });
  }
  pts.push(B);
  return pts;
}

/**
 * 铲斗外形：一个「切掉一部分的半圆」
 * ==========================================================================
 * 局部坐标系（单位 R3 = 参数 bucketRadius =「铲斗销轴→斗齿尖」距离）：
 *   原点 = 铲斗铰点 C，+x 指向斗齿尖 T，因此 T 恒为 (1, 0)。
 *
 * 作图法（三个特征点全部由既有铰点参数推出，不新增参数）
 * --------------------------------------------------------------------------
 *   ① 半圆的「直边」（直径）躺在 C→T 这条直线上，斗齿尖 T 是直边的一个端点；
 *      直边另一端 Q 随被切掉的那一块一起消失。
 *   ② 连杆–铲斗铰点 E = (bktEAlong, bktEPerp)/R3 落在圆弧上。半圆的圆心就是
 *      直径中点、必在直边所在直线上，于是圆心 M 是「直线 C–T」与「线段 T–E 的
 *      垂直平分线」的交点，解一元一次方程即得
 *          m = (1 − ex² − ey²) / (2(1 − ex))，半径 R = |1 − m|，Q = (2m − 1, 0)
 *   ③ 切除线（弦 C–E）切掉含 Q 的那一块：
 *          C = 切除线 ∩ 直边
 *          E = 切除线的另一端，落在圆弧上（斗背板上的连杆销就装在这里）
 *          T = 未被切掉的直边端点 = 斗齿尖
 *      「C 严格落在直边内部」等价于 m < 0.5，也就是 E 落在「以 C–T 为直径的圆」之外。
 *      自检要求的连杆销布置区间（相对 C：−0.35~0 R3、0.2~0.75 R3，见 cylinders.js）
 *      整个都在该圆之外，所以正常机型一定满足；E 被改到区间外时自检会报警，
 *      斗形仍然画得出来（不会自交、不会出 NaN），只是不再严格是一个「切半圆」。
 *
 * 留下的轮廓（逆时针，单位 R3）
 * --------------------------------------------------------------------------
 *   C(0,0) → T(1,0) → 圆弧 T…E → 切除线 E→C
 *     · C→T 段 = 未被切掉的直边，长度恒为 1（即 bucketRadius，与指标口径一致）
 *     · T…E 圆弧 = 斗壁，按 6° 一段离散成折线
 *     · E→C 段 = 切除线
 *
 * 与运动学模型的对应关系（tests/geometry.test.js 与 tests/draw.test.js 守住）
 * --------------------------------------------------------------------------
 *   轮廓第 0 点 = C（斗杆–铲斗铰点），第 1 点 = T（solvePose 的斗齿尖），
 *   末点 = E（连杆–铲斗铰点）。注意 E 现在**落在轮廓边界上**——它就是切除线的
 *   端点，这正是本作图法的定义，不再像老斗形那样把 E 包在斗体内部。
 */
const ARC_STEP_DEG = 6; // 圆弧离散步长（度）

/** 归一化坐标（单位 R3）→ 轮廓点列；同一形状只算一次，返回同一个数组 */
const bucketShapeCache = new Map();

function bucketShapeFromNorm(ex, ey) {
  const key = `${ex.toFixed(9)},${ey.toFixed(9)}`;
  const hit = bucketShapeCache.get(key);
  if (hit) return hit;

  const sign = ey < 0 ? -1 : 1; // 圆弧凸向 E 所在的那一侧
  const ay = Math.abs(ey);
  const den = 2 * (1 - ex);
  const m = den === 0 ? NaN : (1 - ex * ex - ay * ay) / den; // 圆心 x（在直边直线上）

  const pts = [[0, 0], [1, 0]]; // C → T（未被切掉的直边）
  if (!Number.isFinite(m) || Math.abs(1 - m) < 1e-9) {
    // 退化：E 正好落在 T 的正上方，圆心跑到无穷远，圆弧退化成直线段 T→E
    pts.push([ex, sign * ay]);
  } else {
    const R = Math.abs(1 - m);
    // T、E 在圆周上的极角；mirror 到上半平面后再采样，保证圆弧始终走 E 那一侧
    const thT = m < 1 ? 0 : Math.PI;
    const thE = Math.atan2(ay, ex - m); // [0, π]
    const n = Math.max(4, Math.ceil(Math.abs(thE - thT) / toRad(ARC_STEP_DEG)));
    for (let i = 1; i <= n; i++) {
      const th = thT + ((thE - thT) * i) / n;
      pts.push([m + R * Math.cos(th), sign * R * Math.sin(th)]);
    }
  }
  if (bucketShapeCache.size > 256) bucketShapeCache.clear();
  // 冻结：调用方（envelope.js）按「同一个数组对象 = 同一个形状」做缓存，
  // 形状一旦被就地改写，缓存就会静默失效，所以这里直接把点列锁死。
  const frozen = Object.freeze(pts.map((q) => Object.freeze(q)));
  bucketShapeCache.set(key, frozen);
  return frozen;
}

/**
 * 某机型的铲斗局部轮廓（单位 R3，点列：C → T → 圆弧 → E）。
 * 形状只取决于 E 相对 C 的归一化位置，所以改 bktEAlong / bktEPerp / bucketRadius
 * 会让斗形跟着变——不必再单独维护一套斗形数据。
 */
export function bucketLocalShape(p) {
  const R3 = p?.bucketRadius;
  let ex = -0.02;
  let ey = 0.39; // 参数缺失时退回预设机型的比例
  if (Number.isFinite(R3) && R3 > 0) {
    const a = (p.bktEAlong ?? 0) / R3;
    const b = (p.bktEPerp ?? 0) / R3;
    if (Number.isFinite(a) && Number.isFinite(b)) {
      ex = a;
      ey = b;
    }
  }
  return bucketShapeFromNorm(ex, ey);
}

/**
 * 局部轮廓 → 全局多边形。
 * @param {{x:number,y:number}} C 铲斗铰点
 * @param {number} bucketAbsRad C→T 的绝对方向角（弧度）
 * @param {number} bucketRadius C→T 的长度
 * @param {Array<[number,number]>} localShape 由 bucketLocalShape(p) 给出
 */
export function bucketPolygon(C, bucketAbsRad, bucketRadius, localShape) {
  const c = Math.cos(bucketAbsRad);
  const s = Math.sin(bucketAbsRad);
  return localShape.map(([lx, ly]) => {
    const x = lx * bucketRadius;
    const y = ly * bucketRadius;
    return { x: C.x + x * c - y * s, y: C.y + x * s + y * c };
  });
}

/** 圆角矩形 → 八边形，用来画履带 / 配重这类带圆角的外形 */
function roundedRect(x0, y0, x1, y1, r) {
  const rr = Math.max(0, Math.min(r, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2));
  return [
    { x: x0 + rr, y: y0 },
    { x: x1 - rr, y: y0 },
    { x: x1, y: y0 + rr },
    { x: x1, y: y1 - rr },
    { x: x1 - rr, y: y1 },
    { x: x0 + rr, y: y1 },
    { x: x0, y: y1 - rr },
    { x: x0, y: y0 + rr },
  ];
}

/**
 * 整机机体轮廓（履带底盘 + 回转平台 + 配重 + 机罩 + 驾驶室），与关节角无关。
 *
 * 侧视按真机层次来，尺寸全部由参数推出（换机型自动跟着变）：
 *   履带（外轮廓 + 链轨 + 导向轮/驱动轮/支重轮/托链轮）
 *   → 机架 → 回转支承 → 平台（含动臂根部支座）
 *   → 配重（机尾，圆角块）→ 机罩（发动机罩，比驾驶室低）→ 驾驶室（前风挡后倾）
 *
 * 这里只给「形状」，配色与细节线（玻璃分缝、散热格栅、履带板、扶手）由 draw.js 负责。
 *
 * @returns {{undercarriage,trackChain,wheels,carbody,slewRing,upper,boomFoot,counterweight,hood,cab}}
 */
export function bodyPolygons(p) {
  const h = Math.max(1, p.trackHeight);
  const L = Math.max(1, p.trackLength);
  const half = L / 2;
  const deck = h + Math.max(50, h * 0.10); // 回转平台底面高度
  const top = Math.max(deck + 500, p.cabHeight); // 驾驶室顶 = 整机高度
  const rear = -Math.max(1, p.tailSwingRadius);
  const front = Math.max(0, p.platformFront);
  const span = Math.max(1, front - rear);
  const rEnd = Math.min(h * 0.5, half * 0.45); // 履带端部圆角（真机端部是半圆）

  // ① 履带：跑道形外轮廓 + 内圈链轨
  const inset = Math.max(12, h * 0.045);
  const undercarriage = roundedRect(-half, 0, half, h, rEnd);
  const trackChain = roundedRect(
    -half + inset * 2.4,
    inset * 1.5,
    half - inset * 2.4,
    h - inset * 1.5,
    Math.max(4, rEnd - inset * 2),
  );

  // ② 轮系：导向轮（前）→ 驱动轮（后）→ 支重轮 → 托链轮
  const wheels = [
    { x: half - rEnd, y: h * 0.5, r: h * 0.38, kind: 'idler' },
    { x: -half + rEnd, y: h * 0.5, r: h * 0.40, kind: 'sprocket' },
  ];
  const nRoad = 5;
  for (let i = 0; i < nRoad; i++) {
    const x = -half + rEnd * 1.2 + ((half - rEnd * 1.2) * 2 * (i + 0.5)) / nRoad;
    wheels.push({ x, y: h * 0.28, r: h * 0.15, kind: 'road' });
  }
  for (const f of [0.34, 0.68]) {
    wheels.push({ x: -half + L * f, y: h * 0.78, r: h * 0.09, kind: 'carrier' });
  }

  // ③ 机架 + 回转支承
  const carbody = roundedRect(-half * 0.34, h - h * 0.05, half * 0.34, deck, Math.max(8, h * 0.05));
  const slewRing = { cx: 0, cy: deck + h * 0.04, r: Math.min(half * 0.32, Math.max(150, h * 0.32)) };

  // ④ 机尾配重 / 机罩 / 驾驶室 / 平台
  const cwLen = clamp(0.34 * span, 900, 1600);
  const cwTop = deck + 0.62 * (top - deck); // 真机配重顶约 2.1 m
  const counterweight = roundedRect(rear, deck, rear + cwLen, cwTop, Math.max(50, (cwTop - deck) * 0.18));

  const cabLen = clamp(0.38 * span, 1250, 1850);
  const cabFloor = deck + 0.22 * (top - deck); // 真机驾驶室地板约 1.4 m（正好在动臂根部铰点上方）
  const cabX1 = front - 0.02 * span;
  const cabX0 = cabX1 - cabLen;
  const cab = [
    { x: cabX0, y: cabFloor },
    { x: cabX1, y: cabFloor },
    { x: cabX1 - cabLen * 0.09, y: top }, // 前风挡后倾
    { x: cabX0 + cabLen * 0.05, y: top },
  ];

  const hoodTop = deck + 0.50 * (top - deck);
  const hood = roundedRect(rear + cwLen - 30, deck, cabX0 + 30, hoodTop, Math.max(30, (hoodTop - deck) * 0.22));

  // 平台：机罩/驾驶室下方的一块板，前端略低（真机前平台）
  const upper = [
    { x: rear + cwLen - 80, y: hoodTop - 40 },
    { x: cabX0 + 40, y: hoodTop - 40 },
    { x: front, y: deck + 0.09 * (top - deck) },
    { x: front, y: deck - h * 0.05 },
    { x: rear + cwLen - 220, y: deck - h * 0.05 },
  ];

  // 动臂根部支座：A 点（pivotX, pivotY）坐在平台上，需要一块支座把它和平台连起来
  const ax = p.pivotX;
  const ay = p.pivotY;
  const footW = Math.max(320, (p.boomWidth ?? 520) * 0.9);
  const boomFoot = roundedRect(
    ax - footW * 1.1,
    deck - h * 0.05,
    ax + footW * 0.7,
    Math.max(ay - 30, deck + 80),
    40,
  );

  return {
    undercarriage,
    trackChain,
    wheels,
    carbody,
    slewRing,
    upper,
    boomFoot,
    counterweight,
    hood,
    cab,
    deck,
    hoodTop,
    cabFloor,
    top,
  };
}

/**
 * 沿折线生成「变宽带状多边形」：每个顶点沿局部法向左右各偏移 w/2，
 * 法向取相邻两段方向的平均，所以折线拐弯处不会出现尖角缺口。
 */
function bandPolygon(pts, widths) {
  const left = [];
  const right = [];
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const hw = (widths[i] ?? widths[0]) / 2;
    left.push({ x: pts[i].x + nx * hw, y: pts[i].y + ny * hw });
    right.push({ x: pts[i].x - nx * hw, y: pts[i].y - ny * hw });
  }
  return [...left, ...right.reverse()];
}

/**
 * 斗杆「后跟」末端在斗杆坐标系里的沿杆坐标（自 B 沿斗杆向 C 为正，所以为负值）。
 *
 * 斗杆油缸的活塞杆端铰点落在 B 点后方（armCylRodAlong < 0），杆件必须盖住它，
 * 否则油缸末端看起来是悬空的；后跟长度按销轴位置自动取。
 * 斗杆轮廓（attachmentPolygons）与油缸支座（draw.js 的 cylinderMounts）共用这一个
 * 口径——支座的底边也不许探出后跟，否则筋板会在杆件外面支出一小截。
 */
export function armHeelAlong(p) {
  return Math.min(0, p.armCylRodAlong ?? 0) - Math.max(140, (p.armWidth ?? 340) * 0.6);
}

/**
 * 工作装置（动臂 + 斗杆 + 铲斗）在给定姿态下的轮廓多边形集合。
 * 动臂按弯臂折线做成一条连续变宽的带，根部宽、端部窄——分成几段四边形画会在
 * 弯折处留下肉眼可见的缺口。
 */
export function attachmentPolygons(p, pose) {
  const aRad = toRad(pose.alphaDeg);
  const boomAxis = boomPolyline(pose.A, pose.B, p.boomBend, aRad);
  const boomW = p.boomWidth ?? 520;
  const n = boomAxis.length;
  const boomWidths = boomAxis.map((_, i) => boomW * (1.06 - 0.16 * (i / (n - 1))));
  const boomSegs = [bandPolygon(boomAxis, boomWidths)];

  const armW = p.armWidth ?? 340;
  const gRad = toRad(pose.armAbsDeg);
  const heelLen = armHeelAlong(p);
  const heelPt = {
    x: pose.B.x + Math.cos(gRad) * heelLen,
    y: pose.B.y + Math.sin(gRad) * heelLen,
  };
  const armQuad = bandPolygon([heelPt, pose.C], [armW * 0.95, armW * 0.92]);

  const bucket = bucketPolygon(pose.C, toRad(pose.bucketAbsDeg), p.bucketRadius, bucketLocalShape(p));

  return { boomSegs, armQuad, bucket };
}

/**
 * 收集某姿态下「机体 + 工作装置」的全部轮廓顶点。
 * 最小回转半径即这些点到回转中心轴的最大水平距离。
 */
export function outlinePoints(p, pose) {
  const pts = [];
  const body = bodyPolygons(p);
  for (const poly of [
    body.undercarriage,
    body.trackChain,
    body.carbody,
    body.upper,
    body.boomFoot,
    body.hood,
    body.cab,
    body.counterweight,
  ]) {
    for (const pt of poly) pts.push(pt);
  }
  for (const w of body.wheels) {
    pts.push({ x: w.x - w.r, y: w.y }, { x: w.x + w.r, y: w.y });
  }
  if (pose) {
    const att = attachmentPolygons(p, pose);
    for (const seg of att.boomSegs) for (const pt of seg) pts.push(pt);
    for (const pt of att.armQuad) pts.push(pt);
    for (const pt of att.bucket) pts.push(pt);
  }
  return pts;
}
