/**
 * SVG 作业范围图绘制引擎
 * ==========================================================================
 *
 * 设计取舍：每帧「整幅重建 SVG 字符串」而不是逐元素改属性。
 * 本图元素量在 150 个上下，字符串拼接 + 一次 innerHTML 解析比几百次
 * setAttribute 更快，也让这套工程图逻辑读起来是「一段画图的代码」
 * 而不是「一堆 DOM 操作」，后续要加标注、加图层都很直观。
 *
 * 坐标系：世界坐标 mm（x 向前、y 向上、原点在回转中心与停机面交点），
 * 绘制时统一经 makeTransform 映射到像素；文字不参与缩放，始终保持可读字号。
 */

import { METRIC_META } from '../core/metrics.js';
import { solvePose, toRad, bodyPolygons, attachmentPolygons, armHeelAlong } from '../core/geometry.js';
import { bucketRotationRange, jointRanges } from '../core/params.js';
import { cylinderPose, boomCylLength, armCylLength, bucketCylLength, boomAngleFromLength, armDeltaFromLength, bucketPsiFromLength } from '../core/cylinders.js';
import { schematicModel, drawSchematic, drawSchematicBase, schematicLegend } from './schematic.js';

const FONT = `system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif`;

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

const n = (v) => (Math.round(v * 100) / 100).toFixed(2);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const poly = (pts, close = true) => pts.map((p) => `${n(p.x)},${n(p.y)}`).join(' ') + (close ? '' : '');

/** 世界坐标 → 屏幕像素 */
export function makeTransform(world, W, H, pad) {
  const w = Math.max(1, world.maxX - world.minX);
  const h = Math.max(1, world.maxY - world.minY);
  const availW = Math.max(10, W - pad.l - pad.r);
  const availH = Math.max(10, H - pad.t - pad.b);
  const s = Math.min(availW / w, availH / h);
  const ox = pad.l + (availW - w * s) / 2 - world.minX * s;
  const oy = pad.t + (availH - h * s) / 2 + world.maxY * s;
  const T = (x, y) => ({ x: ox + x * s, y: oy - y * s });
  T.s = s;
  T.X = (x) => ox + x * s;
  T.Y = (y) => oy - y * s;
  return T;
}

/** 计算画布需要考虑的世界范围 */
export function computeWorldBounds(p, env, extra = []) {
  let minX = 0;
  let maxX = 0;
  let minY = 0;
  let maxY = 0;
  const swallow = (x, y, m = 0) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x - m < minX) minX = x - m;
    if (x + m > maxX) maxX = x + m;
    if (y - m < minY) minY = y - m;
    if (y + m > maxY) maxY = y + m;
  };

  for (const pt of env.outer) swallow(pt.x, pt.y);
  swallow(-p.tailSwingRadius - 200, p.cabHeight + 400);
  swallow(p.platformFront, 0, 300);
  for (const e of extra) swallow(e.x, e.y);

  // 纵向留出尺寸标注的空间
  minY = Math.min(minY, -200);
  maxY = Math.max(maxY, 200);
  return { minX, maxX, minY, maxY };
}

/* ------------------------------------------------------------------ *
 * 图形片段
 * ------------------------------------------------------------------ */

/** 箭头标记定义 */
function defs() {
  return `<defs>
    <marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="#334155"/>
    </marker>
    <marker id="arS" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="#64748b"/>
    </marker>
    <pattern id="soil" width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="14" stroke="#cbd5e1" stroke-width="2"/>
    </pattern>
  </defs>`;
}

/** 横向尺寸线：从 x0 到 x1 位于高度 y，带箭头与居中标签 */
function dimH(T, x0, x1, y, color, label, sub) {
  const a = T(x0, y);
  const b = T(x1, y);
  if (Math.abs(b.x - a.x) < 26) return '';
  const ly = a.y;
  const mid = (a.x + b.x) / 2;
  const text = sub ? `${label} ${sub}` : label;
  return `
    <g stroke="${color}" fill="none">
      <line x1="${n(a.x)}" y1="${n(ly)}" x2="${n(b.x)}" y2="${n(ly)}" stroke-width="1" marker-start="url(#arS)" marker-end="url(#arS)"/>
      <line x1="${n(a.x)}" y1="${n(ly - 5)}" x2="${n(a.x)}" y2="${n(ly + 5)}" stroke-width="1"/>
      <line x1="${n(b.x)}" y1="${n(ly - 5)}" x2="${n(b.x)}" y2="${n(ly + 5)}" stroke-width="1"/>
    </g>
    <text x="${n(mid)}" y="${n(ly - 6)}" text-anchor="middle" font-size="12" font-weight="600"
          font-family='${FONT}' fill="${color}" stroke="#ffffff" stroke-width="3" paint-order="stroke">${esc(text)}</text>`;
}

/** 纵向尺寸线：从 y0 到 y1 位于 x，带箭头与标签 */
function dimV(T, x, y0, y1, color, label, sub, side = 'right') {
  const a = T(x, y0);
  const b = T(x, y1);
  if (Math.abs(b.y - a.y) < 26) return '';
  const lx = a.x;
  const mid = (a.y + b.y) / 2;
  const tx = side === 'right' ? lx + 7 : lx - 7;
  const anchor = side === 'right' ? 'start' : 'end';
  const text = sub ? `${label} ${sub}` : label;
  return `
    <g stroke="${color}" fill="none">
      <line x1="${n(lx)}" y1="${n(a.y)}" x2="${n(lx)}" y2="${n(b.y)}" stroke-width="1" marker-start="url(#arS)" marker-end="url(#arS)"/>
      <line x1="${n(lx - 5)}" y1="${n(a.y)}" x2="${n(lx + 5)}" y2="${n(a.y)}" stroke-width="1"/>
      <line x1="${n(lx - 5)}" y1="${n(b.y)}" x2="${n(lx + 5)}" y2="${n(b.y)}" stroke-width="1"/>
    </g>
    <text x="${n(tx)}" y="${n(mid + 4)}" text-anchor="${anchor}" font-size="12" font-weight="600"
          font-family='${FONT}' fill="${color}" stroke="#ffffff" stroke-width="3" paint-order="stroke">${esc(text)}</text>`;
}

/** 长度取整显示 */
const mm = (v) => Math.round(v).toLocaleString('en-US');

/* ------------------------------------------------------------------ *
 * 油缸支座的几何（纯函数，绘制与测试共用）
 * ------------------------------------------------------------------ */

/**
 * 三条油缸的**缸筒端 / 活塞杆端支座**（三角筋板）在世界坐标里的几何。
 *
 * 为什么需要它：油缸那一端铰在哪个构件上，是由参数决定的，销轴离构件轴线常常有
 * 几百毫米（真机是靠一块耳板/筋板把它挑出去的）。图上如果只画一根光溜溜的油缸，
 * 末端就是悬空的；所以要按「销轴属于哪个构件」画一块筋板，把底边落在那个构件的
 * 表面上、顶点落在销轴上。构件归属与 cylinders.js 的口径完全一致：
 *
 *   boomRod  动臂油缸活塞杆端 → 动臂（动臂坐标系，A 为原点、+x 指向 B，下表面一侧）
 *   armBody  斗杆油缸缸筒端   → **动臂**（动臂坐标系，自 B 起算、向根部为负，上表面）
 *   armRod   斗杆油缸活塞杆端 → 斗杆（斗杆坐标系，B 为原点、+x 指向 C，上表面）
 *   bktBody  铲斗油缸缸筒端   → **斗杆**（斗杆坐标系，自 C 起算、向根部为负，上表面）
 *
 * 动臂是弯的（boomBend）：动臂上的支座要用**两套**坐标口径——
 *   · 顶点：与 cylinders.js 一致（那里不计弯折，params.js 明确 boomBend 只影响观感、
 *     不参与计算），这样支座顶点、油缸端点在图上严格重合；
 *   · 底边：叠加 boomPolyline 的同一条偏移曲线，贴在真正画出来的那根弯臂表面上，
 *     否则筋板会浮在半空、和弯臂之间留一道几百毫米的缝。
 *
 * @returns {{[key:string]: {key,label,pin,base1,base2,needed,halfW,baseHalf}}}
 *          pin 就是该油缸端的销轴位置（应与 cylinderPose 解出的端点重合），
 *          base1/base2 是底边两端（落在构件表面略靠内 10% 处，沿杆方向不探出杆件轮廓），
 *          needed 表示销轴确实挑出了构件表面之外、必须画筋板。
 */
export function cylinderMounts(p, pose) {
  const aRad = toRad(pose.alphaDeg);
  const gRad = toRad(pose.armAbsDeg);
  const cosA = Math.cos(aRad);
  const sinA = Math.sin(aRad);
  const nx = -sinA; // 动臂法向：与 boomPolyline 的弯折偏移同向
  const ny = cosA;
  const bend = p.boomBend ?? 0;
  const boomLen = Math.max(1, p.boomLength);

  /** 动臂坐标系（原点 A，+x 指向 B）——销轴口径：与 cylinders.js 相同，不含弯折 */
  const boomPinFrame = (a, b) => ({
    x: pose.A.x + a * cosA - b * sinA,
    y: pose.A.y + a * sinA + b * cosA,
  });
  /** 动臂坐标系——表面口径：叠加弯臂偏移，落回画出来的那根弯臂 */
  const boomSurfaceFrame = (a, b) => {
    const t = Math.max(0, Math.min(1, a / boomLen));
    const off = bend * 4 * t * (1 - t);
    return {
      x: pose.A.x + a * cosA - b * sinA + nx * off,
      y: pose.A.y + a * sinA + b * cosA + ny * off,
    };
  };
  /** 斗杆坐标系（原点 B，+x 指向 C）：斗杆是直杆，销轴与表面共用一套框架 */
  const armFrame = (a, b) => {
    const c = Math.cos(gRad);
    const s = Math.sin(gRad);
    return { x: pose.B.x + a * c - b * s, y: pose.B.y + a * s + b * c };
  };

  const boomW = p.boomWidth ?? 520;
  const armW = p.armWidth ?? 340;
  /** 动臂截面半宽（与 attachmentPolygons 的线性收窄一致） */
  const boomHalfAt = (along) => {
    const t = Math.max(0, Math.min(1, along / boomLen));
    return (boomW * (1.06 - 0.16 * t)) / 2;
  };
  const armHalfW = armW * 0.47;

  const mount = (frame, pinFrame, along, perp, halfW, key, label, span) => {
    const sgn = perp < 0 ? -1 : 1;
    // 底边半长：既要挑得开，又不许探出杆件轮廓（span = 该杆件沿杆方向的可用范围），
    // 否则筋板底边会在杆件外面支出一小截，看起来像根多余的刺。
    let baseHalf = Math.max(160, halfW * 1.4);
    if (span) baseHalf = Math.max(60, Math.min(baseHalf, along - span[0], span[1] - along));
    return {
      key,
      label,
      halfW,
      baseHalf,
      pin: pinFrame(along, perp),
      base1: frame(along - baseHalf, sgn * halfW * 0.9),
      base2: frame(along + baseHalf, sgn * halfW * 0.9),
      needed: Math.abs(perp) > halfW * 0.9,
    };
  };

  // 沿杆坐标口径见 params.js：斗杆油缸缸筒端「自 B 向根部为负」、铲斗油缸缸筒端「自 C 向根部为负」
  const armBodyAlong = p.boomLength + p.armCylBodyAlong;
  const bktBodyAlong = p.armLength + p.bktCylBodyAlong;
  // 杆件沿杆方向的可用范围：动臂从 A 到 B；斗杆从后跟末端到末端销孔 C
  const boomSpan = [0, p.boomLength];
  const armSpan = [armHeelAlong(p), p.armLength];

  return {
    boomRod: mount(boomSurfaceFrame, boomPinFrame, p.boomCylRodAlong, p.boomCylRodPerp, boomHalfAt(p.boomCylRodAlong), 'boomRod', '动臂油缸活塞杆端支座（动臂下表面）', boomSpan),
    armBody: mount(boomSurfaceFrame, boomPinFrame, armBodyAlong, p.armCylBodyPerp, boomHalfAt(armBodyAlong), 'armBody', '斗杆油缸缸筒端支座（动臂上表面）', boomSpan),
    armRod: mount(armFrame, armFrame, p.armCylRodAlong, p.armCylRodPerp, armHalfW, 'armRod', '斗杆油缸活塞杆端支座（斗杆上表面）', armSpan),
    bktBody: mount(armFrame, armFrame, bktBodyAlong, p.bktCylBodyPerp, armHalfW, 'bktBody', '铲斗油缸缸筒端支座（斗杆上表面）', armSpan),
  };
}

/* ------------------------------------------------------------------ *
 * 主绘制函数
 * ------------------------------------------------------------------ */

/**
 * @param {object} o
 * @param {number} o.W 画布宽 (px)
 * @param {number} o.H 画布高 (px)
 * @param {object} o.p 机型参数
 * @param {object} o.values 指标值
 * @param {object} o.poses  指标姿态
 * @param {object} o.env    包络
 * @param {object} o.view   显示选项
 * @param {number} o.minSwingRadius
 */
export function renderChart(o) {
  const { W, H, p, values, poses, env, view, minSwingRadius } = o;

  const world = computeWorldBounds(p, env);
  const pad = { l: 34, t: 30, r: view.showDims ? 96 : 34, b: 42 };
  const T = makeTransform(world, W, H, pad);

  const body = bodyPolygons(p);
  const showPose = view.poseMode && view.poseMode !== 'none';
  const pose = resolvePose(p, view, poses);

  const parts = [];
  parts.push(defs());

  /* ---- 网格与刻度 ---- */
  const sx = niceStep(world.maxX - world.minX);
  const grid = [];
  for (let x = Math.ceil(world.minX / sx) * sx; x <= world.maxX; x += sx) {
    const X = T.X(x);
    grid.push(`<line x1="${n(X)}" y1="${n(pad.t)}" x2="${n(X)}" y2="${n(H - pad.b)}" stroke="#eef2f7" stroke-width="1"/>`);
    grid.push(
      `<text x="${n(X)}" y="${n(H - pad.b + 15)}" text-anchor="middle" font-size="10" font-family='${FONT}' fill="#94a3b8">${(x / 1000).toFixed(0)}</text>`,
    );
  }
  const sy = niceStep(world.maxY - world.minY);
  for (let y = Math.ceil(world.minY / sy) * sy; y <= world.maxY; y += sy) {
    const Y = T.Y(y);
    grid.push(
      `<line x1="${n(pad.l)}" y1="${n(Y)}" x2="${n(W - pad.r)}" y2="${n(Y)}" stroke="${y === 0 ? '#cbd5e1' : '#eef2f7'}" stroke-width="1"/>`,
    );
    if (y !== 0) {
      grid.push(
        `<text x="${n(pad.l - 6)}" y="${n(Y + 3)}" text-anchor="end" font-size="10" font-family='${FONT}' fill="#94a3b8">${(y / 1000).toFixed(0)}</text>`,
      );
    }
  }
  parts.push(`<g>${grid.join('')}</g>`);

  /* ---- 停机面与地下填充 ---- */
  const gy = T.Y(0);
  parts.push(
    `<rect x="${n(pad.l)}" y="${n(gy)}" width="${n(W - pad.l - pad.r)}" height="${n(
      Math.max(0, H - pad.b - gy),
    )}" fill="url(#soil)" opacity="0.5"/>`,
  );
  parts.push(
    `<line x1="${n(pad.l)}" y1="${n(gy)}" x2="${n(W - pad.r)}" y2="${n(gy)}" stroke="#475569" stroke-width="1.6"/>`,
  );
  parts.push(
    `<text x="${n(W - pad.r - 4)}" y="${n(gy - 5)}" text-anchor="end" font-size="10" font-family='${FONT}' fill="#64748b">停机面 ±0</text>`,
  );

  /* ---- 回转中心竖轴 ---- */
  const cx0 = T.X(0);
  parts.push(
    `<line x1="${n(cx0)}" y1="${n(pad.t)}" x2="${n(cx0)}" y2="${n(H - pad.b)}" stroke="#94a3b8" stroke-width="1" stroke-dasharray="7 5"/>`,
  );
  parts.push(
    `<text x="${n(cx0 + 4)}" y="${n(pad.t + 11)}" font-size="10" font-family='${FONT}' fill="#64748b">回转中心</text>`,
  );

  /* ---- 作业范围包络 ---- */
  if (view.showEnvelope) {
    // 八段圆弧作图法得到的闭合轮廓：一段一段地画（每段颜色略作区分不需要，
    // 但闭合路径必须一次成环，不能只用外缘 + Z，也不能拆成开口折线）。
    const ring = (env.region?.length > 3 ? env.region : env.outer).map((pt) => T(pt.x, pt.y));
    const d = `M ${ring.map((q) => `${n(q.x)} ${n(q.y)}`).join(' L ')} Z`;
    parts.push(`<path d="${d}" fill="#3b82f6" fill-opacity="0.09" stroke="none"/>`);
    parts.push(
      `<path d="${d}" fill="none" stroke="#1d4ed8" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`,
    );
  }

  /* ---- 机体（侧视层次：履带 → 回转支承 → 平台 → 驾驶室） ---- */
  const schematic = view.style === 'schematic';
  if (view.showBody && schematic) {
    // 机构运动简图里不画整机外形，只留一条虚线底盘标出机器坐在哪儿
    parts.push(drawSchematicBase(p, T));
  } else if (view.showBody) {
    const poly = (pts, fill, stroke = '#334155', w = 1.4) =>
      `<polygon points="${pts.map((q) => `${n(T.X(q.x))},${n(T.Y(q.y))}`).join(' ')}" fill="${fill}" stroke="${stroke}" stroke-width="${w}" stroke-linejoin="round"/>`;
    const line = (a, b, stroke = '#94a3b8', w = 1) =>
      `<line x1="${n(T.X(a.x))}" y1="${n(T.Y(a.y))}" x2="${n(T.X(b.x))}" y2="${n(T.Y(b.y))}" stroke="${stroke}" stroke-width="${w}"/>`;
    const dot = (q, r, fill = '#475569', stroke = 'none') =>
      `<circle cx="${n(T.X(q.x))}" cy="${n(T.Y(q.y))}" r="${n(r)}" fill="${fill}" stroke="${stroke}" stroke-width="0.8"/>`;
    const bodyParts = [];

    /* ---- 履带：外轮廓 → 链轨 → 轮系 ---- */
    bodyParts.push(poly(body.undercarriage, '#cfd8e4'));
    bodyParts.push(poly(body.trackChain, '#c2cddc'));
    // 履带板（链轨节）：沿履带等分画短竖线
    const shoeN = Math.max(10, Math.round(p.trackLength / 380));
    for (let i = 0; i < shoeN; i++) {
      const x = -p.trackLength / 2 + (p.trackLength * (i + 0.5)) / shoeN;
      const inset = Math.max(12, p.trackHeight * 0.045) * 1.5;
      if (Math.abs(x) > p.trackLength / 2 - inset * 2.6) continue;
      bodyParts.push(line({ x, y: inset }, { x, y: p.trackHeight - inset }, '#9fb0c4', 0.9));
    }
    for (const w of body.wheels) {
      const rr = Math.max(1.6, w.r * T.s);
      const big = w.kind === 'idler' || w.kind === 'sprocket';
      bodyParts.push(
        `<circle cx="${n(T.X(w.x))}" cy="${n(T.Y(w.y))}" r="${n(rr)}" fill="${big ? '#b9c5d5' : '#8fa1b6'}" stroke="#475569" stroke-width="${big ? 1.1 : 0.7}"/>`,
      );
      if (big) bodyParts.push(dot(w, Math.max(0.8, rr * 0.28), '#eef4fb', '#475569'));
    }
    bodyParts.push(poly(body.carbody, '#b9c5d5'));

    /* ---- 回转支承：双圈，读起来是个支承 ---- */
    const sr = body.slewRing;
    bodyParts.push(
      `<circle cx="${n(T.X(sr.cx))}" cy="${n(T.Y(sr.cy))}" r="${n(Math.max(3, sr.r * T.s))}" fill="#f1f5f9" stroke="#64748b" stroke-width="1.1"/>`,
      `<circle cx="${n(T.X(sr.cx))}" cy="${n(T.Y(sr.cy))}" r="${n(Math.max(2, sr.r * 0.62 * T.s))}" fill="none" stroke="#94a3b8" stroke-width="0.9"/>`,
    );

    /* ---- 平台 / 配重 / 机罩 / 驾驶室 ---- */
    bodyParts.push(poly(body.upper, '#e2e8f0'));
    bodyParts.push(poly(body.boomFoot, '#cbd5e1'));
    bodyParts.push(poly(body.counterweight, '#cbd5e1'));
    bodyParts.push(poly(body.hood, '#dbe3ec'));
    bodyParts.push(poly(body.cab, '#eef4fb', '#334155', 1.5));

    /* ---- 机罩：散热格栅（内嵌矩形 + 竖线）+ 排气管 ---- */
    const hood = body.hood;
    const hx0 = hood[0].x;
    const hx1 = hood[1].x;
    const grilleW = (hx1 - hx0) * 0.30;
    const grilleX = hx0 + (hx1 - hx0) * 0.52;
    const gyTop = body.hoodTop - 26;
    const gyBot = body.deck + 90;
    bodyParts.push(
      `<rect x="${n(T.X(grilleX))}" y="${n(T.Y(gyTop))}" width="${n(Math.max(6, grilleW * T.s))}" height="${n(Math.max(6, (gyTop - gyBot) * T.s))}" fill="#c3cfdd" stroke="#94a3b8" stroke-width="0.9"/>`,
    );
    for (const f of [0.3, 0.55, 0.8]) {
      const gx = grilleX + grilleW * f;
      bodyParts.push(line({ x: gx, y: gyTop - 6 }, { x: gx, y: gyBot + 6 }, '#94a3b8', 0.9));
    }
    const ex = hx0 + (hx1 - hx0) * 0.12;
    bodyParts.push(
      `<rect x="${n(T.X(ex))}" y="${n(T.Y(body.hoodTop + 96))}" width="${n(Math.max(3, 86 * T.s))}" height="${n(Math.max(4, 96 * T.s))}" fill="#94a3b8" stroke="#475569" stroke-width="0.9"/>`,
    );

    /* ---- 驾驶室：玻璃面 + 门 + 顶棚外伸（画成「有窗的驾驶室」，而不是一个方盒） ---- */
    const cabPts = body.cab.map((q) => T(q.x, q.y));
    const cabTopY = Math.min(cabPts[2].y, cabPts[3].y);
    const cabBotY = Math.max(cabPts[0].y, cabPts[1].y);
    const cabL = Math.min(cabPts[0].x, cabPts[3].x);
    const cabR = Math.max(cabPts[1].x, cabPts[2].x);
    const cabH = Math.max(1, cabBotY - cabTopY);
    const slant = cabPts[1].x - cabPts[2].x; // 前风挡后倾量（屏幕像素）
    const xFront = (y) => cabR - (slant * (cabBotY - y)) / cabH;
    // 玻璃面：上沿在顶棚下方，下沿约 60% 高度，前缘顺着风挡斜度
    const gy0 = cabTopY + cabH * 0.13;
    const gy1 = cabTopY + cabH * 0.62;
    const glass = [
      { x: cabL + 7, y: gy0 },
      { x: xFront(gy0) - 7, y: gy0 },
      { x: xFront(gy1) - 7, y: gy1 },
      { x: cabL + 7 + (cabR - cabL) * 0.06, y: gy1 },
    ];
    bodyParts.push(
      `<polygon points="${glass.map((q) => `${n(q.x)},${n(q.y)}`).join(' ')}" fill="#dbeafe" stroke="#94a3b8" stroke-width="0.9"/>`,
    );
    // 顶棚外伸
    bodyParts.push(
      `<line x1="${n(cabL - 6)}" y1="${n(cabTopY)}" x2="${n(cabR + 8)}" y2="${n(cabTopY)}" stroke="#475569" stroke-width="1.6"/>`,
    );
    // 门缝 + 把手
    const doorX = cabL + (cabR - cabL) * 0.34;
    bodyParts.push(
      `<line x1="${n(doorX)}" y1="${n(cabTopY + 4)}" x2="${n(doorX)}" y2="${n(cabBotY)}" stroke="#94a3b8" stroke-width="1"/>`,
      `<line x1="${n(doorX + 6)}" y1="${n(cabBotY - cabH * 0.42)}" x2="${n(doorX + 24)}" y2="${n(cabBotY - cabH * 0.42)}" stroke="#64748b" stroke-width="1.6"/>`,
    );
    // 底板与平台的接缝
    bodyParts.push(
      `<line x1="${n(cabL)}" y1="${n(cabBotY)}" x2="${n(cabR)}" y2="${n(cabBotY)}" stroke="#64748b" stroke-width="1.2"/>`,
    );

    /* ---- 配重分色缝 ---- */
    {
      const cw = body.counterweight.map((q) => T(q.x, q.y));
      const cwTop = Math.min(...cw.map((q) => q.y));
      const cwBot = Math.max(...cw.map((q) => q.y));
      const seamY = cwTop + (cwBot - cwTop) * 0.24;
      bodyParts.push(
        `<line x1="${n(Math.min(...cw.map((q) => q.x)) + 8)}" y1="${n(seamY)}" x2="${n(Math.max(...cw.map((q) => q.x)) - 8)}" y2="${n(seamY)}" stroke="#aab8c9" stroke-width="1.1"/>`,
      );
    }

    /* ---- 机罩上方扶手栏杆 ---- */
    const railY = body.hoodTop + 150;
    const railX0 = hood[0].x + 40;
    const railX1 = hood[1].x - 40;
    bodyParts.push(
      `<line x1="${n(T.X(railX0))}" y1="${n(T.Y(railY))}" x2="${n(T.X(railX1))}" y2="${n(T.Y(railY))}" stroke="#94a3b8" stroke-width="1.2"/>`,
    );
    for (const rx of [railX0, (railX0 + railX1) / 2, railX1]) {
      bodyParts.push(line({ x: rx, y: body.hoodTop - 10 }, { x: rx, y: railY }, '#94a3b8', 1));
    }

    parts.push(`<g>${bodyParts.join('')}</g>`);
  }

  /* ---- 尾部回转圆 ---- */
  if (view.showTailCircle && p.tailSwingRadius > 0) {
    const r = p.tailSwingRadius * T.s;
    parts.push(
      `<circle cx="${n(cx0)}" cy="${n(gy)}" r="${n(r)}" fill="none" stroke="#f59e0b" stroke-width="1" stroke-dasharray="6 4" opacity="0.75"/>`,
    );
  }

  /* ---- 工作装置姿态：实体外形 或 机构运动简图 ---- */
  const sm = showPose && pose && schematic ? schematicModel(p, pose) : null;
  if (sm) {
    const tq = T(pose.T.x, pose.T.y);
    parts.push(
      `<g data-layer="device">${drawSchematic(sm, T)}` +
        `<circle cx="${n(tq.x)}" cy="${n(tq.y)}" r="2.6" fill="#dc2626"><title>斗齿尖</title></circle></g>`,
    );
  } else if (showPose && pose) {
    const att = attachmentPolygons(p, pose);
    const g = [];
    const cyl = cylinderPose(p, pose);
    const px = (q) => ({ x: T.X(q.x), y: T.Y(q.y) });

    // 油缸端支座：以杆件表面为底边、销轴为顶点的三角筋板。
    // 销轴到杆件轴线的距离由参数决定（可达几百毫米），真机靠耳板把它挑出去；
    // 图上没有这块筋板，油缸末端就是悬空的。支座先画、杆件本体后画，让本体压住底边。
    const mounts = cyl ? cylinderMounts(p, pose) : null;
    const drawMount = (m) => {
      if (!m || !m.needed) return;
      const q = [m.base1, m.base2, m.pin].map(px);
      g.push(
        `<polygon data-mount="${m.key}" points="${q.map((c) => `${n(c.x)},${n(c.y)}`).join(' ')}" fill="#cbd5e1" stroke="#334155" stroke-width="1.2" stroke-linejoin="round"><title>${esc(m.label)}</title></polygon>`,
        `<circle cx="${n(q[2].x)}" cy="${n(q[2].y)}" r="${n(Math.max(2.4, 130 * T.s))}" fill="#f8fafc" stroke="#1e293b" stroke-width="1.1"/>`,
      );
    };
    drawMount(mounts?.boomRod); // 动臂油缸活塞杆端（动臂下表面）
    drawMount(mounts?.armBody); // 斗杆油缸缸筒端（动臂上表面）

    for (const seg of att.boomSegs) {
      g.push(
        `<polygon points="${seg.map((q) => `${n(T.X(q.x))},${n(T.Y(q.y))}`).join(' ')}" fill="#cbd5e1" stroke="#1e293b" stroke-width="1.3" stroke-linejoin="round"/>`,
      );
    }
    drawMount(mounts?.armRod); // 斗杆油缸活塞杆端（斗杆上表面）
    drawMount(mounts?.bktBody); // 铲斗油缸缸筒端（斗杆上表面）

    g.push(
      `<polygon points="${att.armQuad.map((q) => `${n(T.X(q.x))},${n(T.Y(q.y))}`).join(' ')}" fill="#cbd5e1" stroke="#1e293b" stroke-width="1.3" stroke-linejoin="round"/>`,
    );
    g.push(
      `<polygon points="${att.bucket.map((q) => `${n(T.X(q.x))},${n(T.Y(q.y))}`).join(' ')}" fill="#94a3b8" stroke="#1e293b" stroke-width="1.3" stroke-linejoin="round"/>`,
    );
    // 斗形是「切掉一部分的半圆」，轮廓点序为
    //   C(铰点) → T(齿尖，未被切掉的直边端点) → 圆弧(斗壁) → E(连杆铰点) → C(切除线)。
    // 斗齿只画在齿尖 T 那个尖角的外角平分线方向上：轮廓的首尾连线现在是切除线
    // （C–E，装连杆销的背板边），不能再像老斗形那样沿它铺一排齿。
    {
      const bs = att.bucket;
      const cG = bs[0]; // 铲斗铰点 C
      const tG = bs[1]; // 斗齿尖 T
      const nG = bs[2]; // 圆弧上紧挨着 T 的点
      const eG = bs[bs.length - 1]; // 连杆–铲斗铰点 E
      const dir = (ax, ay, bx, by) => {
        const dx = ax - bx;
        const dy = ay - by;
        const l = Math.hypot(dx, dy) || 1;
        return { x: dx / l, y: dy / l };
      };
      const d1 = dir(cG.x, cG.y, tG.x, tG.y); // T → C
      const d2 = dir(nG.x, nG.y, tG.x, tG.y); // T → 圆弧
      const bl = Math.hypot(d1.x + d2.x, d1.y + d2.y) || 1;
      const ox = -(d1.x + d2.x) / bl; // 尖角外法向 = 内角平分线取反
      const oy = -(d1.y + d2.y) / bl;
      const tip = T(tG.x, tG.y);
      const tooth = Math.max(4.5, 0.075 * p.bucketRadius * T.s);
      const hw = tooth * 0.5;
      g.push(
        `<polygon points="${n(tip.x - oy * hw)},${n(tip.y + ox * hw)} ${n(tip.x + oy * hw)},${n(tip.y - ox * hw)} ${n(tip.x + ox * tooth)},${n(tip.y + oy * tooth)}" fill="#64748b" stroke="#1e293b" stroke-width="0.7"><title>斗齿（齿尖 = 未被切掉的直边端点）</title></polygon>`,
      );
      // 直边 C–T 与切除线 C–E 本来就由轮廓描边画出，这里各压一条略粗的线并挂上说明，
      // 让图上能一眼认出「哪条是未切除的直边、哪条是切除线」。
      const cS = T(cG.x, cG.y);
      const eS = T(eG.x, eG.y);
      g.push(
        `<line x1="${n(cS.x)}" y1="${n(cS.y)}" x2="${n(tip.x)}" y2="${n(tip.y)}" stroke="#334155" stroke-width="1.8" stroke-linecap="round"><title>未被切掉的直边 C–T，端口为斗齿尖</title></line>`,
        `<line x1="${n(eS.x)}" y1="${n(eS.y)}" x2="${n(cS.x)}" y2="${n(cS.y)}" stroke="#334155" stroke-width="1.8" stroke-linecap="round"><title>切除线 C–E：与直边的交点为铲斗铰点 C，另一端为连杆–铲斗铰点 E</title></line>`,
      );
    }

    // 油缸与铲斗连杆：缸筒画成粗段、活塞杆画成细段，读起来就是一根油缸
    if (cyl) {
      const barrel = (a, b, label) => {
        const A2 = px(a);
        const B2 = px(b);
        const dx = B2.x - A2.x;
        const dy = B2.y - A2.y;
        const len = Math.hypot(dx, dy) || 1;
        // 缸筒占 55%，其余是活塞杆
        const mx = A2.x + dx * 0.55;
        const my = A2.y + dy * 0.55;
        return `
          <line x1="${n(A2.x)}" y1="${n(A2.y)}" x2="${n(mx)}" y2="${n(my)}" stroke="#475569" stroke-width="5.5" stroke-linecap="round"/>
          <line x1="${n(mx)}" y1="${n(my)}" x2="${n(B2.x)}" y2="${n(B2.y)}" stroke="#94a3b8" stroke-width="2.6" stroke-linecap="round"/>
          <line x1="${n(A2.x)}" y1="${n(A2.y)}" x2="${n(B2.x)}" y2="${n(B2.y)}" stroke="#334155" stroke-width="0.7" opacity="0.5"/>
          <title>${esc(label)}</title>`;
      };
      g.push(barrel(cyl.boom.body, cyl.boom.rod, '动臂油缸'));
      g.push(barrel(cyl.arm.body, cyl.arm.rod, '斗杆油缸'));
      g.push(barrel(cyl.bucket.body, cyl.bucket.rod, '铲斗油缸'));

      // 动臂油缸缸筒端的支座（画在转台前部，不然油缸看起来是悬空的）
      {
        const b = px(cyl.boom.body);
        const bw = Math.max(8, 260 * T.s);
        const bh = Math.max(8, 200 * T.s);
        g.push(
          `<rect x="${n(b.x - bw / 2)}" y="${n(b.y - bh * 0.35)}" width="${n(bw)}" height="${n(bh)}" rx="${n(Math.min(bw, bh) * 0.2)}" fill="#cbd5e1" stroke="#334155" stroke-width="1.1"/>`,
        );
      }

      // 摇杆与连杆：都是「两铰点杆」，共用 P 点一个销轴
      const rk = cyl.rocker;
      const bar = (a, b, w, label) => {
        const A2 = px(a);
        const B2 = px(b);
        return `<line x1="${n(A2.x)}" y1="${n(A2.y)}" x2="${n(B2.x)}" y2="${n(B2.y)}" stroke="#475569" stroke-width="${w}" stroke-linecap="round"><title>${esc(label)}</title></line>`;
      };
      if (rk.joint && rk.pivot) {
        g.push(bar(rk.pivot, rk.joint, 5.5, '摇杆'));
      }
      if (cyl.link.from && cyl.link.to) {
        g.push(bar(cyl.link.from, cyl.link.to, 4, '连杆'));
      }
      // 铰点销轴：摇杆铰点 D、共用销轴 P、连杆–铲斗铰点 E
      for (const [q, label] of [
        [rk.pivot, '摇杆铰点 D'],
        [rk.joint, '共用销轴 P（摇杆端 / 活塞杆端 / 连杆端）'],
        [cyl.link.to, '连杆–铲斗铰点 E'],
      ]) {
        if (!q) continue;
        const w = px(q);
        g.push(
          `<circle cx="${n(w.x)}" cy="${n(w.y)}" r="2.6" fill="#f8fafc" stroke="#1e293b" stroke-width="1.1"><title>${esc(label)}</title></circle>`,
        );
      }
      // 油缸两端铰点
      for (const q of [cyl.boom.body, cyl.boom.rod, cyl.arm.body, cyl.arm.rod, cyl.bucket.body, cyl.bucket.rod]) {
        const w = px(q);
        g.push(`<circle cx="${n(w.x)}" cy="${n(w.y)}" r="1.8" fill="#1e293b"/>`);
      }
    }

    // 主铰点
    for (const key of ['A', 'B', 'C']) {
      const q = T(pose[key].x, pose[key].y);
      g.push(`<circle cx="${n(q.x)}" cy="${n(q.y)}" r="3" fill="#ffffff" stroke="#1e293b" stroke-width="1.2"/>`);
    }
    // 斗齿尖
    const tq = T(pose.T.x, pose.T.y);
    g.push(`<circle cx="${n(tq.x)}" cy="${n(tq.y)}" r="2.6" fill="#dc2626"/>`);
    parts.push(`<g>${g.join('')}</g>`);
  }

  /* ---- 机构运动简图图例 ---- */
  if (sm) parts.push(schematicLegend(W - pad.r - 232, H - pad.b - 132, 224));

  /* ---- 尺寸标注 ---- */
  if (view.showDims) {
    const dims = [];
    const tip = (k) => poses[k]?.T;
    const show = (k) => view.dimKeys.includes(k);

    if (show('maxDigHeight')) {
      const t = tip('maxDigHeight');
      dims.push(dimV(T, t.x, 0, values.maxDigHeight, '#16a34a', 'C 最大挖掘高度', mm(values.maxDigHeight), 'left'));
    }
    if (show('dumpHeight')) {
      const t = tip('dumpHeight');
      dims.push(dimV(T, t.x, 0, values.dumpHeight, '#d97706', 'D 最大卸载高度', mm(values.dumpHeight), 'right'));
    }
    if (show('maxDigDepth')) {
      const t = tip('maxDigDepth');
      dims.push(dimV(T, t.x, 0, -values.maxDigDepth, '#dc2626', 'B 最大挖掘深度', mm(values.maxDigDepth), 'left'));
    }
    if (show('verticalWallDepth')) {
      const t = tip('verticalWallDepth');
      dims.push(
        dimV(T, t.x, 0, -values.verticalWallDepth, '#7c3aed', 'E 最大垂直挖掘深度', mm(values.verticalWallDepth), 'right'),
      );
    }
    if (show('groundMaxRadius')) {
      const y = -110;
      dims.push(dimH(T, 0, values.groundMaxRadius, y, '#0ea5e9', "A′ 停机面最大挖掘半径", mm(values.groundMaxRadius)));
    }
    if (show('maxDigRadius')) {
      dims.push(dimH(T, 0, values.maxDigRadius, p.pivotY, '#2563eb', 'A 最大挖掘半径', mm(values.maxDigRadius)));
    }
    if (show('minSwingRadius')) {
      dims.push(dimH(T, 0, minSwingRadius, p.cabHeight + 260, '#f59e0b', '最小回转半径', mm(minSwingRadius)));
    }
    parts.push(`<g>${dims.join('')}</g>`);
  }

  /* ---- 指标卡片 ---- */
  parts.push(metricCards(values, o, W, pad));

  /* ---- 比例尺 ---- */
  parts.push(scaleBar(T, W, H, pad));

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join('')}</svg>`;
}

/**
 * 解析当前要显示的姿态。
 *
 * 「工作姿态（可调）」支持两种输入，油缸长度优先：
 *   · customPose = { boomL, armL, bktL }  —— 三个油缸的长度（mm），直接反解关节角；
 *     这是界面上三个滑块的量，范围是「安装距（全缩）~ 安装距 + 行程（全伸）」。
 *   · customPose = { alpha, delta, psi }  —— 直接给关节角（内部/分享链接用）。
 */
export function resolvePose(p, view, poses) {
  if (view.poseMode === 'none') return null;
  if (view.poseMode && view.poseMode !== 'custom' && poses?.[view.poseMode]) {
    return poses[view.poseMode];
  }
  // 关节角范围由油缸行程解出，这里必须走 jointRanges 而不是读参数
  const R = jointRanges(p);
  const b = bucketRotationRange(p);
  const cp = view.customPose ?? {};

  // 默认给一个「真机作业姿态」：动臂抬到行程的 ~76%，斗杆垂下来，铲斗收着。
  // 之前默认动臂只抬 62%、斗杆只收 42%，画出来接近平伸，和真机差得远。
  let alpha = cp.alpha ?? R.alpha[0] + (R.alpha[1] - R.alpha[0]) * 0.76;
  let delta = cp.delta ?? -80;
  let psi = cp.psi ?? b.max - (b.max - b.min) * 0.22;

  // 油缸长度优先：给了长度就按长度反解
  if (Number.isFinite(cp.boomL)) alpha = boomAngleFromLength(p, cp.boomL);
  if (Number.isFinite(cp.armL)) delta = armDeltaFromLength(p, cp.armL);
  if (Number.isFinite(cp.bktL)) psi = bucketPsiFromLength(p, cp.bktL);
  // 反解在极值处会给出边界角；万一解不出来（参数被改坏）就退回默认姿态
  if (!Number.isFinite(alpha)) alpha = R.alpha[0] + (R.alpha[1] - R.alpha[0]) * 0.76;
  if (!Number.isFinite(delta)) delta = -80;
  if (!Number.isFinite(psi)) psi = b.max - (b.max - b.min) * 0.22;

  return solvePose(
    p,
    clampNum(alpha, R.alpha[0], R.alpha[1]),
    clampNum(delta, R.delta[0], R.delta[1]),
    clampNum(psi, b.min, b.max),
  );
}

/**
 * 「工作姿态（可调）」下三个油缸长度的取值范围：[安装距, 安装距 + 行程]。
 * 安装距与行程填反了（区间为负）也能给出正的区间。
 */
export function cylinderLengthRange(p, kind) {
  const closed = p[`${kind}CylClosed`];
  const stroke = p[`${kind}CylStroke`];
  const a = closed;
  const c = closed + stroke;
  return { min: Math.min(a, c), max: Math.max(a, c) };
}

/** 当前姿态对应的三个油缸长度（mm） */
export function poseCylinderLengths(p, pose) {
  if (!pose) return null;
  return {
    boomL: boomCylLength(p, pose.alphaDeg),
    armL: armCylLength(p, pose.deltaDeg),
    bktL: bucketCylLength(p, pose.psiDeg),
  };
}

/** 把数值收敛到 [lo, hi]；非有限值直接取 lo */
function clampNum(v, lo, hi) {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

/** 左上角指标列表（工程图里图例的常规位置，不遮挡包络） */
function metricCards(values, o, W, pad) {
  const rows = METRIC_META.map((m) => ({ m, v: values[m.key] })).filter((r) => Number.isFinite(r.v));
  const minSwing = values.minSwingRadius;
  if (Number.isFinite(minSwing)) {
    rows.push({ m: { symbol: 'R', label: '最小回转半径', color: '#f59e0b' }, v: minSwing });
  }
  const cw = 210;
  const rh = 17;
  const headH = 20;
  const h = headH + rows.length * rh + 10;
  const x = pad.l + 12;
  const y = pad.t + 10;

  const items = rows
    .map((r, i) => {
      const ty = y + headH + 6 + i * rh;
      return `<text x="${n(x + 12)}" y="${n(ty)}" font-size="11.5" font-family='${FONT}' fill="#334155">
          <tspan font-weight="700" fill="${r.m.color}">${esc(r.m.symbol)}</tspan>
          <tspan dx="3">${esc(r.m.label)}</tspan>
        </text>
      <text x="${n(x + cw - 12)}" y="${n(ty)}" text-anchor="end" font-size="11.5" font-family='${FONT}' fill="#0f172a" font-weight="700">${mm(r.v)}</text>`;
    })
    .join('');

  return `<g>
    <rect x="${n(x)}" y="${n(y)}" width="${n(cw)}" height="${n(h)}" rx="7" fill="#ffffff" fill-opacity="0.94" stroke="#e2e8f0"/>
    <text x="${n(x + 12)}" y="${n(y + 15)}" font-size="10.5" font-family='${FONT}' fill="#94a3b8">作业尺寸（mm）</text>
    <line x1="${n(x + 12)}" y1="${n(y + headH)}" x2="${n(x + cw - 12)}" y2="${n(y + headH)}" stroke="#f1f5f9" stroke-width="1"/>
    ${items}
  </g>`;
}

/** 左下角比例尺 */
function scaleBar(T, W, H, pad) {
  const targetPx = 110;
  const raw = targetPx / T.s;
  const step = niceStep(raw);
  const px = step * T.s;
  const x0 = pad.l + 6;
  const y0 = H - 12;
  const label = step >= 1000 ? `${(step / 1000).toFixed(step % 1000 === 0 ? 0 : 1)} m` : `${step} mm`;
  return `<g>
    <line x1="${n(x0)}" y1="${n(y0)}" x2="${n(x0 + px)}" y2="${n(y0)}" stroke="#334155" stroke-width="2"/>
    <line x1="${n(x0)}" y1="${n(y0 - 4)}" x2="${n(x0)}" y2="${n(y0 + 4)}" stroke="#334155" stroke-width="2"/>
    <line x1="${n(x0 + px)}" y1="${n(y0 - 4)}" x2="${n(x0 + px)}" y2="${n(y0 + 4)}" stroke="#334155" stroke-width="2"/>
    <text x="${n(x0 + px + 6)}" y="${n(y0 + 4)}" font-size="10" font-family='${FONT}' fill="#475569">${esc(label)}</text>
  </g>`;
}

/** 取一个"好看"的刻度间隔（1/2/5 × 10^k） */
function niceStep(span) {
  if (!(span > 0)) return 1000;
  const rough = span / 8;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / mag;
  const pick = norm <= 1.5 ? 1 : norm <= 3 ? 2 : norm <= 7 ? 5 : 10;
  return pick * mag;
}
