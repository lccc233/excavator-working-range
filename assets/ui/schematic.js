/**
 * 机构运动简图（按 GB/T 4460《机械制图 机构运动简图符号》的画法）
 * ==========================================================================
 *
 * 「实体外形」画法回答的是「这台机器长什么样」；机构运动简图回答的是
 * 「这个机构有几个构件、几个铰点、油缸怎么推」——也就是把工作装置抽象成
 * 一个平面连杆机构：
 *
 *   · 构件：动臂、斗杆按各自铰点连成多边形；摇杆、连杆画成两个铰点之间的
 *           双线杆件；铲斗只画轮廓（它的形状本身参与作业尺寸的定义）。
 *   · 转动副：小圆圈。三个构件共用一个销轴时（铲斗四连杆的 P 点）按复合铰链
 *           画成两个相切的圆圈。
 *   · 移动副：油缸画成「缸筒矩形 + 活塞 + 活塞杆」，也就是液压缸的简图符号。
 *   · 机架：固定在机架上的铰点（动臂铰点 A、动臂油缸缸筒端）加画机架符号
 *           （三角 + 斜线），表明这两个铰点相对机架不动。
 *
 * 坐标系：入参一律为整机 mm；出图前经 T() 映射到像素。线宽与字号固定为像素，
 *         所以不同机型、不同缩放下简图的线条粗细都一致，看着像一张工程图。
 */

import { cylinderPose } from '../core/cylinders.js';

const INK = '#0f172a';
const BAR = '#334155';
const CYL = '#475569';

const n = (v) => (Math.round(v * 100) / 100).toFixed(2);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const FONT = `system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif`;

const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const norm = (v) => {
  const L = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / L, y: v.y / L };
};
const at = (P, u, d) => ({ x: P.x + u.x * d, y: P.y + u.y * d });

/**
 * 机架支座的三个顶点：动臂根部 A、动臂油缸缸筒端 body 是同一构件上的两个铰点，
 * 第三个顶点取「与 A 同一竖线、与缸筒端同一水平线」的交点——这样两条直角边
 * 分别平行于 y 轴、x 轴，图上就是这个支座直角边的方向与坐标轴一致。
 * @returns {Array<{x:number,y:number}>} [A, 直角顶点, 缸筒端]
 */
export function frameTrianglePts(A, body) {
  return [A, { x: A.x, y: body.y }, body];
}

/** 铰点编号 → 名称（图上只标字母，全称放在图例与提示里） */export const JOINT_NAMES = {
  A: '动臂铰点（机架）',
  B: '动臂–斗杆铰点',
  C: '斗杆–铲斗铰点',
  D: '摇杆–斗杆铰点',
  P: '复合铰链（摇杆 / 活塞杆 / 连杆 共用一个销轴）',
  E: '连杆–铲斗铰点',
  boomBody: '动臂油缸缸筒端（机架）',
  boomRod: '动臂油缸活塞杆端（动臂）',
  armBody: '斗杆油缸缸筒端（动臂）',
  armRod: '斗杆油缸活塞杆端（斗杆）',
  bktBody: '铲斗油缸缸筒端（斗杆）',
};

/**
 * 解出机构简图所需的全部铰点与构件（整机坐标 mm）。
 * @returns {null|{links,cylinders,joints,J}}
 */
export function schematicModel(p, pose) {
  if (!pose || !Number.isFinite(pose.alphaDeg)) return null;
  const cyl = cylinderPose(p, pose);
  if (!cyl) return null;

  const J = {
    A: pose.A,
    B: pose.B,
    C: pose.C,
    T: pose.T,
    boomBody: cyl.boom.body,
    boomRod: cyl.boom.rod,
    armBody: cyl.arm.body,
    armRod: cyl.arm.rod,
    bktBody: cyl.bucket.body,
    D: cyl.rocker.pivot,
    P: cyl.rocker.joint,
    E: cyl.link.to,
  };
  // 参数被改坏时（解不出连杆）返回 null，调用方退回实体外形画法
  for (const [k, v] of Object.entries(J)) {
    if (k === 'T') continue;
    if (!v || !Number.isFinite(v.x) || !Number.isFinite(v.y)) return null;
  }

  const armAxis = mid(J.B, J.C);
  const boomAxis = sub(J.B, J.A);
  const boomPinSide = (point) => {
    const v = sub(point, J.A);
    return boomAxis.x * v.y - boomAxis.y * v.x;
  };
  const bodySide = boomPinSide(J.armBody);
  const rodSide = boomPinSide(J.boomRod);
  let boomPts;
  if (bodySide * rodSide > 0) {
    // 两个安装销都在动臂同一侧时，按沿动臂方向排序，避免轮廓边交叉。
    const along = (point) => {
      const v = sub(point, J.A);
      return (v.x * boomAxis.x + v.y * boomAxis.y) / (boomAxis.x ** 2 + boomAxis.y ** 2);
    };
    const pins = [J.armBody, J.boomRod].sort((a, b) => along(a) - along(b));
    boomPts = [J.A, ...pins, J.B];
  } else {
    // 两个安装销在动臂异侧时，按各自所在的一侧闭合轮廓。
    boomPts = [J.A, J.armBody, J.B, J.boomRod];
  }

  const links = [
    // 机架：动臂根部 A 与动臂油缸缸筒端在同一块机架上（一体），
    // 用直角边平行坐标轴的直角三角形表示，直角顶点取在「与 A 同一竖线、与缸筒端同一水平线」处
    { id: 'frame', label: '机架（动臂根部 + 动臂油缸缸筒端）', kind: 'frame', pts: frameTrianglePts(J.A, J.boomBody) },
    // 动臂：铰点 A、斗杆油缸缸筒端、斗杆铰点 B、动臂油缸活塞杆端 连成的多边形
    { id: 'boom', label: '动臂', kind: 'rigid', pts: boomPts },
    // 斗杆：铰点 B、斗杆油缸活塞杆端、铲斗油缸缸筒端、摇杆铰点 D、铲斗铰点 C
    { id: 'arm', label: '斗杆', kind: 'rigid', pts: [J.B, J.armRod, J.bktBody, J.D, J.C] },
    // 铲斗是「三铰点构件」：斗杆铰点 C、连杆铰点 E、斗齿尖 T，简图上就是一个三角形
    { id: 'bucket', label: '铲斗（铰点 C / 连杆铰点 E / 斗齿尖 T）', kind: 'rigid', pts: [J.C, J.E, J.T] },
    { id: 'rocker', label: '摇杆', kind: 'bar', pts: [J.D, J.P] },
    { id: 'link', label: '连杆', kind: 'bar', pts: [J.P, J.E] },
  ];

  const cylinders = [
    { id: 'boom', no: 1, label: '动臂油缸', body: J.boomBody, rod: J.boomRod, away: mid(J.A, J.B) },
    { id: 'arm', no: 2, label: '斗杆油缸', body: J.armBody, rod: J.armRod, away: armAxis },
    { id: 'bucket', no: 3, label: '铲斗油缸', body: J.bktBody, rod: J.P, away: armAxis },
  ];

  const joints = [
    // frameTo 指向该铰点「固定在机架上的另一个铰点」，绘图时据此定机架符号的朝向
    { id: 'A', pt: J.A, members: 2, frameTo: J.boomBody },
    { id: 'B', pt: J.B, members: 2 },
    { id: 'C', pt: J.C, members: 2 },
    { id: 'D', pt: J.D, members: 2 },
    // P 点：摇杆、活塞杆、连杆 三个构件共用一个销轴 → 复合铰链
    { id: 'P', pt: J.P, members: 3, compound: true, axis: norm(sub(J.P, J.D)) },
    { id: 'E', pt: J.E, members: 2 },
    { id: 'boomBody', pt: J.boomBody, members: 2, frameTo: J.A },
    { id: 'boomRod', pt: J.boomRod, members: 2 },
    { id: 'armBody', pt: J.armBody, members: 2 },
    { id: 'armRod', pt: J.armRod, members: 2 },
    { id: 'bktBody', pt: J.bktBody, members: 2 },
  ];

  return { links, cylinders, joints, J };
}

/** 简图覆盖到的全部整机坐标点（用于给独立小图算范围） */
export function schematicPoints(model) {
  const pts = [];
  for (const l of model.links) for (const q of l.pts) pts.push(q);
  for (const c of model.cylinders) pts.push(c.body, c.rod);
  return pts;
}

/** 取一个「装得下 + 留出标注余量」的像素变换 */
export function schematicTransform(pts, W, H, pad = { l: 60, t: 46, r: 60, b: 48 }) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const q of pts) {
    if (!Number.isFinite(q.x) || !Number.isFinite(q.y)) continue;
    if (q.x < minX) minX = q.x;
    if (q.x > maxX) maxX = q.x;
    if (q.y < minY) minY = q.y;
    if (q.y > maxY) maxY = q.y;
  }
  if (!Number.isFinite(minX)) return null;
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  const availW = Math.max(10, W - pad.l - pad.r);
  const availH = Math.max(10, H - pad.t - pad.b);
  const s = Math.min(availW / w, availH / h);
  const ox = pad.l + (availW - w * s) / 2 - minX * s;
  const oy = pad.t + (availH - h * s) / 2 + maxY * s;
  const T = (x, y) => ({ x: ox + x * s, y: oy - y * s });
  T.s = s;
  T.X = (x) => ox + x * s;
  T.Y = (y) => oy - y * s;
  return T;
}

/* ------------------------------------------------------------------ *
 * 图形片段（一律在像素坐标下画，线宽/字号固定）
 * ------------------------------------------------------------------ */

/** 转动副：空心小圆 */
function pinCircle(P, r = 4.2) {
  return `<circle data-sym="pin" cx="${n(P.x)}" cy="${n(P.y)}" r="${n(r)}" fill="#ffffff" stroke="${INK}" stroke-width="1.5"/>`;
}

/** 复合铰链：m 个构件共用一个销轴时画 m−1 个相切的圆 */
function compoundPin(P, axis, m, r = 4.2) {
  const u = norm(axis);
  const out = [];
  const k = (m - 1) / 2;
  for (let i = 0; i < m - 1; i++) {
    const off = (i - k + 0.5) * r * 2 * 0.55;
    out.push(pinCircle({ x: P.x + u.x * off, y: P.y + u.y * off }, r));
  }
  return out.join('');
}

/** 三角形重心（用来判断哪一侧是多边形的外侧） */
function centroid(pts) {
  const c = pts.reduce((s, p) => ({ x: s.x + p.x, y: s.y + p.y }), { x: 0, y: 0 });
  return { x: c.x / pts.length, y: c.y / pts.length };
}

/** 沿 a→b 在「多边形外侧」画 count 条 45° 斜线（机架固定边记号） */
function hatchEdge(a, b, poly, count = 3, len = 6) {
  const u = norm(sub(b, a));
  const nv = { x: -u.y, y: u.x };
  const c = centroid(poly);
  const m = mid(a, b);
  const toC = sub(c, m);
  const out = nv.x * toC.x + nv.y * toC.y > 0 ? { x: -nv.x, y: -nv.y } : nv;
  const dir = norm({ x: out.x + u.x * 0.6, y: out.y + u.y * 0.6 });
  const lines = [];
  for (let i = 1; i <= count; i++) {
    const t = i / (count + 1);
    const q = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    const e = at(q, dir, len);
    lines.push(`<line x1="${n(q.x)}" y1="${n(q.y)}" x2="${n(e.x)}" y2="${n(e.y)}" stroke="${INK}" stroke-width="1.1"/>`);
  }
  return lines.join('');
}

/**
 * 机架支座：直角三角形（直角边平行坐标轴）+ 直角符号 + 两条直角边外侧的斜线。
 * 三个端点顺序固定为 [动臂根部 A, 直角顶点, 动臂油缸缸筒端]。
 */
function frameSymbol(pts, label = '') {
  const [A, K, B] = pts;
  const u1 = norm(sub(A, K));
  const u2 = norm(sub(B, K));
  const k = 7;
  const r1 = at(K, u1, k);
  const r2 = at(K, u2, k);
  const rMid = { x: r1.x + r2.x - K.x, y: r1.y + r2.y - K.y };
  return `<g data-sym="frame">
    <polygon points="${pts.map((q) => `${n(q.x)},${n(q.y)}`).join(' ')}" fill="#f1f5f9" fill-opacity="0.8" stroke="${INK}" stroke-width="1.8" stroke-linejoin="miter"/>
    <polyline points="${n(r1.x)},${n(r1.y)} ${n(rMid.x)},${n(rMid.y)} ${n(r2.x)},${n(r2.y)}" fill="none" stroke="${BAR}" stroke-width="1.1"/>
    ${hatchEdge(K, A, pts, 3)}
    ${hatchEdge(K, B, pts, 3)}
    <title>${esc(label)}</title>
  </g>`;
}

/** 图例里的小机架图标：直角边平行坐标轴的直角三角形 + 固定边斜线 */
function frameIcon(x, y) {
  return frameSymbol(
    [
      { x: x + 2, y },
      { x: x + 2, y: y + 15 },
      { x: x + 21, y: y + 15 },
    ],
    '机架（固定支座）',
  );
}

/** 双线杆件（摇杆 / 连杆）：沿轴线的窄矩形 */function barSymbol(a, b, half = 3.2, label = '') {
  const u = norm(sub(b, a));
  const nv = { x: -u.y, y: u.x };
  const q = [
    { x: a.x + nv.x * half, y: a.y + nv.y * half },
    { x: b.x + nv.x * half, y: b.y + nv.y * half },
    { x: b.x - nv.x * half, y: b.y - nv.y * half },
    { x: a.x - nv.x * half, y: a.y - nv.y * half },
  ];
  return `<polygon data-sym="bar" points="${q.map((P) => `${n(P.x)},${n(P.y)}`).join(' ')}" fill="#ffffff" stroke="${BAR}" stroke-width="1.5" stroke-linejoin="round"><title>${esc(label)}</title></polygon>`;
}

/**
 * 移动副（液压缸）：缸筒矩形 + 活塞 + 活塞杆细线。
 * 缸筒端画在 a，活塞杆端（也就是铰点）画在 b。
 */
function cylinderSymbol(a, b, label = '') {
  const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const u = norm(sub(b, a));
  const nv = { x: -u.y, y: u.x };
  const half = 5.2;
  const tBarrel = 0.6; // 缸筒长度占全长的比例
  const tPiston = 0.42;
  const P = (t, k) => ({ x: a.x + u.x * L * t + nv.x * k, y: a.y + u.y * L * t + nv.y * k });
  const rect = [P(0, half), P(tBarrel, half), P(tBarrel, -half), P(0, -half)];
  const rod = `<line x1="${n(P(0.4, 0).x)}" y1="${n(P(0.4, 0).y)}" x2="${n(b.x)}" y2="${n(b.y)}" stroke="${CYL}" stroke-width="3.2" stroke-linecap="round"/>`;
  const piston = `<line x1="${n(P(tPiston, half * 0.9).x)}" y1="${n(P(tPiston, half * 0.9).y)}" x2="${n(P(tPiston, -half * 0.9).x)}" y2="${n(P(tPiston, -half * 0.9).y)}" stroke="${INK}" stroke-width="3"/>`;
  // 缸筒尾端封头的斜线，区分「缸筒」与「活塞杆」两端
  const cap = [];
  for (let i = 0; i < 3; i++) {
    const q0 = P(0.02 + i * 0.05, half);
    const q1 = P(0.06 + i * 0.05, -half);
    cap.push(`<line x1="${n(q0.x)}" y1="${n(q0.y)}" x2="${n(q1.x)}" y2="${n(q1.y)}" stroke="${BAR}" stroke-width="1"/>`);
  }
  return `<g data-sym="cylinder" data-cyl="${esc(label)}">
    <polygon points="${rect.map((q) => `${n(q.x)},${n(q.y)}`).join(' ')}" fill="#ffffff" stroke="${INK}" stroke-width="1.6" stroke-linejoin="round"/>
    ${cap.join('')}
    ${rod}
    ${piston}
    <title>${esc(label)}</title>
  </g>`;
}

/* ------------------------------------------------------------------ *
 * 主绘制
 * ------------------------------------------------------------------ */

/** 铰点编号的文字偏移（屏幕像素），按图上实际占位手工调过 */
const LABEL_OFFSET = {
  A: { x: -13, y: -10, anchor: 'end' },
  B: { x: -13, y: -9, anchor: 'end' },
  C: { x: 12, y: 13, anchor: 'start' },
  D: { x: 10, y: -10, anchor: 'start' },
  P: { x: 13, y: -9, anchor: 'start' },
  E: { x: 12, y: -11, anchor: 'start' },
};

/**
 * 画机构运动简图。
 * @param {object} model schematicModel() 的结果
 * @param {Function} T 世界 mm → 屏幕像素
 * @param {object} [opts] { labels: boolean, pins: boolean }
 * @returns {string} SVG 片段
 */
export function drawSchematic(model, T, opts = {}) {
  const showLabels = opts.labels !== false;
  const P = (q) => ({ x: T.X(q.x), y: T.Y(q.y) });
  const out = [];

  // 1) 机架支座（直角三角）与铲斗（三角形）——都画在下层，避免盖住连杆销
  const fr = model.links.find((l) => l.id === 'frame');
  if (fr) out.push(frameSymbol(fr.pts.map(P), fr.label));

  const bk = model.links.find((l) => l.id === 'bucket');
  if (bk) {
    out.push(
      `<polygon data-sym="bucket" points="${bk.pts.map((q) => { const w = P(q); return `${n(w.x)},${n(w.y)}`; }).join(' ')}" ` +
        `fill="#e2e8f0" fill-opacity="0.7" stroke="${INK}" stroke-width="1.8" stroke-linejoin="round"><title>${esc(bk.label)}</title></polygon>`,
    );
  }

  // 2) 动臂 / 斗杆：按铰点连成的多边形
  for (const l of model.links) {
    if (l.kind !== 'rigid' || l.id === 'bucket') continue;
    const pts = l.pts.map((q) => { const w = P(q); return `${n(w.x)},${n(w.y)}`; }).join(' ');
    out.push(
      `<polygon data-sym="link" data-link="${esc(l.id)}" points="${pts}" fill="#ffffff" fill-opacity="0.55" stroke="${INK}" stroke-width="1.8" stroke-linejoin="round"><title>${esc(l.label)}</title></polygon>`,
    );
  }

  // 4) 油缸（移动副）
  for (const c of model.cylinders) {
    out.push(cylinderSymbol(P(c.body), P(c.rod), `${c.label}（移动副）`));
  }

  // 5) 摇杆 / 连杆（两铰点杆件）
  for (const l of model.links) {
    if (l.kind !== 'bar') continue;
    out.push(barSymbol(P(l.pts[0]), P(l.pts[1]), 3.2, l.label));
  }

  // 6) 铰点（机架支座已在最下层画过，这里只画转动副圆圈）
  for (const j of model.joints) {
    const w = P(j.pt);
    if (j.compound) out.push(compoundPin(w, { x: j.axis.x, y: -j.axis.y }, j.members));
    else out.push(pinCircle(w));
  }

  // 7) 油缸编号 ①②③：放在缸筒中段、背离对应杆件轴线的外侧
  for (const c of model.cylinders) {
    const a = P(c.body);
    const b = P(c.rod);
    const m = { x: a.x + (b.x - a.x) * 0.3, y: a.y + (b.y - a.y) * 0.3 };
    const away = P(c.away);
    const u = norm(sub(m, away));
    const q = at(m, u, 13);
    out.push(
      `<g><circle cx="${n(q.x)}" cy="${n(q.y)}" r="7.5" fill="#1e293b" fill-opacity="0.88"/>` +
        `<text x="${n(q.x)}" y="${n(q.y + 4)}" text-anchor="middle" font-size="10" font-weight="700" font-family='${FONT}' fill="#ffffff">${c.no}</text>` +
        `<title>${esc(c.label)}</title></g>`,
    );
  }

  // 8) 铰点编号
  if (showLabels) {
    for (const j of model.joints) {
      const off = LABEL_OFFSET[j.id];
      if (!off) continue;
      const w = P(j.pt);
      out.push(
        `<text data-joint="${esc(j.id)}" x="${n(w.x + off.x)}" y="${n(w.y + off.y + 4)}" text-anchor="${off.anchor}" font-size="13" font-weight="700" ` +
          `font-family='${FONT}' fill="#0f172a" stroke="#ffffff" stroke-width="3.5" paint-order="stroke">${esc(j.id)}` +
          `<title>${esc(JOINT_NAMES[j.id] ?? j.id)}</title></text>`,
      );
    }
  }

  return out.join('');
}

/** 图例：把简图用到的四种符号讲清楚 */
export function schematicLegend(x, y, width = 224) {
  const rows = [
    { kind: 'bar', text: '构件（动臂 / 斗杆 / 摇杆 / 连杆）' },
    { kind: 'pin', text: '转动副（铰点）' },
    { kind: 'cyl', text: '移动副（液压缸）' },
    { kind: 'frame', text: '机架（直角三角支座，斜线为固定边）' },
  ];
  const rh = 19;
  const headH = 22;
  const h = headH + rows.length * rh + 26;
  const items = rows
    .map((r, i) => {
      const cy = y + headH + rh * i + rh / 2;
      const ox = x + 14;
      let icon = '';
      if (r.kind === 'bar') icon = barSymbol({ x: ox, y: cy }, { x: ox + 20, y: cy }, 3.2, '');
      else if (r.kind === 'pin') icon = pinCircle({ x: ox + 10, y: cy }, 4.2);
      else if (r.kind === 'cyl') icon = cylinderSymbol({ x: ox - 2, y: cy }, { x: ox + 24, y: cy }, '');
      else icon = frameIcon(ox, cy - 8);
      return `${icon}<text x="${n(x + 46)}" y="${n(cy + 4)}" font-size="11" font-family='${FONT}' fill="#334155">${esc(r.text)}</text>`;
    })
    .join('');
  return `<g data-sym="legend" data-layer="legend">
    <rect x="${n(x)}" y="${n(y)}" width="${n(width)}" height="${n(h)}" rx="7" fill="#ffffff" fill-opacity="0.94" stroke="#e2e8f0"/>
    <text x="${n(x + 12)}" y="${n(y + 15)}" font-size="10.5" font-family='${FONT}' fill="#94a3b8">机构运动简图符号</text>
    <line x1="${n(x + 12)}" y1="${n(y + headH)}" x2="${n(x + width - 12)}" y2="${n(y + headH)}" stroke="#f1f5f9"/>
    ${items}
    <text x="${n(x + 12)}" y="${n(y + h - 8)}" font-size="10.5" font-family='${FONT}' fill="#64748b">①动臂缸　②斗杆缸　③铲斗缸　P 为复合铰链</text>
  </g>`;
}

/**
 * 横向图例条（独立小图用）。
 * 独立小图里机器占的位置随姿态变化，图例框压在右下角会把铲斗盖住
 * （这个坑真实踩过：首次出图时图例正好盖在铲斗上），所以改成放在视图下方的一条。
 */
export function schematicLegendRow(x, y, width = 800) {
  const items = [
    { kind: 'bar', text: '构件（动臂 / 斗杆 / 摇杆 / 连杆）' },
    { kind: 'pin', text: '转动副（铰点）' },
    { kind: 'cyl', text: '移动副（液压缸）' },
    { kind: 'frame', text: '机架（直角三角支座）' },
  ];
  const colW = width / items.length;
  const cy = y + 16;
  const cells = items.map((r, i) => {
    const ox = x + colW * i;
    let icon = '';
    if (r.kind === 'bar') icon = barSymbol({ x: ox + 2, y: cy }, { x: ox + 26, y: cy }, 3.2, '');
    else if (r.kind === 'pin') icon = pinCircle({ x: ox + 14, y: cy }, 4.2);
    else if (r.kind === 'cyl') icon = cylinderSymbol({ x: ox, y: cy }, { x: ox + 30, y: cy }, '');
    else icon = frameIcon(ox, cy - 8);
    return `${icon}<text x="${n(ox + 38)}" y="${n(cy + 4)}" font-size="11.5" font-family='${FONT}' fill="#334155">${esc(r.text)}</text>`;
  });
  return `<g data-sym="legend" data-layer="legend">
    <line x1="${n(x)}" y1="${n(y - 6)}" x2="${n(x + width)}" y2="${n(y - 6)}" stroke="#e2e8f0"/>
    ${cells.join('')}
    <text x="${n(x)}" y="${n(y + 44)}" font-size="11" font-family='${FONT}' fill="#64748b">①动臂油缸　②斗杆油缸　③铲斗油缸　P 为复合铰链（摇杆 / 活塞杆 / 连杆 共用一个销轴，画成两个相切的圆）</text>
  </g>`;
}

/** 机架基准（虚线底盘），让简图知道机器坐在哪儿 */
export function drawSchematicBase(p, T) {
  const track = [
    { x: -p.trackLength / 2, y: 0 },
    { x: p.trackLength / 2, y: 0 },
    { x: p.trackLength / 2, y: p.trackHeight },
    { x: -p.trackLength / 2, y: p.trackHeight },
  ];
  const pts = track.map((q) => `${n(T.X(q.x))},${n(T.Y(q.y))}`).join(' ');
  return `<polygon points="${pts}" fill="#ffffff" fill-opacity="0.5" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="7 4"><title>底盘（机架基准）</title></polygon>`;
}

/**
 * 独立的机构运动简图小图（参数表页签 / 打印页用）。
 * @returns {string} 完整 <svg>；无法解算时返回 ''
 */
export function renderSchematicFigure({ p, pose, W = 940, H = 470, title = '工作装置机构运动简图' }) {
  const model = schematicModel(p, pose);
  if (!model) return '';
  const pts = schematicPoints(model);
  pts.push(pose.T);
  // 下方留出图例条的位置，图例不参与缩放，所以直接把它从绘图区里扣掉
  const T = schematicTransform(pts, W, H, { l: 60, t: 54, r: 60, b: 96 });
  if (!T) return '';
  const body = [
    `<text x="18" y="26" font-size="14" font-weight="700" font-family='${FONT}' fill="#0f172a">${esc(title)}</text>`,
    `<text x="18" y="42" font-size="11" font-family='${FONT}' fill="#94a3b8">${esc(p.name ?? '')}　α=${n(pose.alphaDeg)}°　Δ=${n(pose.deltaDeg)}°　ψ=${n(pose.psiDeg)}°</text>`,
    drawSchematicBase(p, T),
    `<g data-layer="device">${drawSchematic(model, T)}` +
      `<circle cx="${n(T.X(pose.T.x))}" cy="${n(T.Y(pose.T.y))}" r="3" fill="#dc2626"><title>斗齿尖</title></circle></g>`,
    schematicLegendRow(60, H - 78, W - 120),
  ];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="工作装置机构运动简图">${body.join('')}</svg>`;
}
