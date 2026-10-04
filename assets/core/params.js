/**
 * 参数规范、校验与派生量
 * ==========================================================
 *
 * 设计原则
 * ----------------------------------------------------------
 * 1. 客户在界面上调的是「几何量」——动臂多长、油缸行程多大、铰点装在哪，
 *    而不是「最大挖掘半径是多少」。指标是算出来的，不是填进去的。
 * 2. 关节角范围不是输入项，而是由三个油缸的「安装位置 + 安装距 + 行程」
 *    经连杆机构反解得到的派生量（见 cylinders.js）。单一数据来源，
 *    不会出现「油缸说一套、角度说另一套」的自相矛盾。
 * 3. 铲斗采用标准的「斗杆–摇杆–连杆–铲斗」四连杆，而不是油缸直连：
 *    摇杆与连杆都是「两铰点杆」，摇杆一端铰在斗杆上，另一端与铲斗油缸活塞杆、
 *    连杆共用一个销轴，连杆的另一端铰接在铲斗上。
 */

import { clamp } from './geometry.js';
import { resolveJointRanges, verifyCylinderLayout } from './cylinders.js';

/**
 * 界面控件元数据。group 决定参数面板分组，order 决定组内顺序。
 * kind: 'length' 长度滑块 | 'angle' 角度滑块 | 'number' 纯数字
 *
 * 坐标口径（与真机图纸一致，也和 cylinders.js 的求解口径完全一致）：
 *   · 动臂油缸缸筒端：相对动臂根部铰点 A 的 (ΔX, ΔY)，ΔX 一般取正值（A 的前方）
 *   · 斗杆油缸缸筒端：自动臂末端销孔 B 起算（沿动臂向根部为负、垂直动臂向上为正），
 *     这样改「动臂长度」时它跟着 B 一起移动
 *   · 斗杆油缸活塞杆端：斗杆坐标系（原点 B，+x 指向 C），真机在 B 点后方、
 *     斗杆上平面，即「沿斗杆为负、垂直斗杆为正」
 *   · 铲斗油缸缸筒端、摇杆铰点 D：自斗杆末端销孔 C 起算（向根部为负、上方为正），
 *     这样改「斗杆长度」时它俩跟着 C 一起移动
 *   · 连杆–铲斗铰点 E：铲斗坐标系（原点 C，+x 指向斗齿尖）
 */
export const PARAM_SPEC = [
  // ---- 工作装置几何 ----
  { key: 'boomLength', group: '工作装置几何', label: '动臂长度', unit: 'mm', min: 2000, max: 9000, step: 10, kind: 'length', primary: true,
    hint: '动臂两铰点 A→B 的直线距离' },
  { key: 'armLength', group: '工作装置几何', label: '斗杆长度', unit: 'mm', min: 1200, max: 5000, step: 10, kind: 'length', primary: true,
    hint: '斗杆两铰点 B→C 的直线距离' },
  { key: 'bucketRadius', group: '工作装置几何', label: '铲斗销轴至斗齿尖', unit: 'mm', min: 500, max: 2200, step: 5, kind: 'length', primary: true,
    hint: 'C→斗齿尖 T 的距离，0.6~1.2 m³ 铲斗约 1150~1500 mm' },
  { key: 'bucketCapacity', group: '工作装置几何', label: '铲斗容量', unit: 'm³', min: 0.1, max: 4, step: 0.01, kind: 'number', primary: true,
    decimals: 2, hint: '仅用于参数表显示，不参与几何计算' },
  { key: 'boomBend', group: '工作装置几何', label: '动臂弯折量', unit: 'mm', min: 0, max: 900, step: 10, kind: 'length', primary: false,
    hint: '动臂中部相对两端连线的偏移，只影响绘图观感，不参与计算' },
  { key: 'bucketBottomAngle', group: '工作装置几何', label: '斗底安装角', unit: '°', min: 20, max: 100, step: 0.5, kind: 'angle', primary: false,
    hint: '铲斗平底相对「销轴→斗齿尖」连线的夹角，用于确定最大垂直挖掘深度姿态' },

  // ---- 铰点位置 ----
  { key: 'pivotX', group: '铰点位置', label: '动臂铰点前移量', unit: 'mm', min: -800, max: 1800, step: 5, kind: 'length', primary: true,
    hint: '动臂铰点相对回转中心的水平距离，正值在回转中心前方' },
  { key: 'pivotY', group: '铰点位置', label: '动臂铰点高度', unit: 'mm', min: 600, max: 3200, step: 10, kind: 'length', primary: true,
    hint: '动臂铰点距停机面的高度' },

  // ---- 动臂油缸 ----
  { key: 'boomCylBodyDX', group: '动臂油缸', label: '缸筒端 ΔX（相对 A）', unit: 'mm', min: -600, max: 1500, step: 5, kind: 'length', primary: false,
    hint: '缸筒端铰点相对动臂根部铰点 A 的水平距离；真机装在转台前部，一般取正值（在 A 的前方）' },
  { key: 'boomCylBodyDY', group: '动臂油缸', label: '缸筒端 ΔY（相对 A）', unit: 'mm', min: -2500, max: 300, step: 5, kind: 'length', primary: false,
    hint: '相对 A 的竖直距离；缸筒端在 A 的前下方，一般取负值' },
  { key: 'boomCylRodAlong', group: '动臂油缸', label: '活塞杆端 沿动臂', unit: 'mm', min: 500, max: 6000, step: 5, kind: 'length', primary: false,
    hint: '动臂坐标系（原点 A，+x 指向 B）：沿动臂轴线的距离，一般取 0.5 倍动臂长度左右' },
  { key: 'boomCylRodPerp', group: '动臂油缸', label: '活塞杆端 垂直动臂', unit: 'mm', min: -1000, max: 1000, step: 5, kind: 'length', primary: false,
    hint: '动臂坐标系（+y 指动臂上方）里的垂直坐标：铰点在动臂两端点连线哪一侧就看这个值的正负。真机装在动臂下侧，取负值（−1000~0）；正值表示铰点在动臂上方，自检会提示与真机布置不同' },
  { key: 'boomCylClosed', group: '动臂油缸', label: '安装距（全缩）', unit: 'mm', min: 600, max: 6000, step: 5, kind: 'length', primary: true,
    hint: '油缸全缩时两铰点中心距（全缩 = 动臂最低）' },
  { key: 'boomCylStroke', group: '动臂油缸', label: '行程', unit: 'mm', min: 200, max: 3500, step: 5, kind: 'length', primary: true,
    hint: '决定动臂仰角范围，从而决定最大挖掘高度与最大挖掘深度' },

  // ---- 斗杆油缸 ----
  { key: 'armCylBodyAlong', group: '斗杆油缸', label: '缸筒端 自 B 沿动臂', unit: 'mm', min: -8000, max: 0, step: 5, kind: 'length', primary: false,
    hint: '自斗杆铰点 B（动臂末端销孔）沿动臂轴线向根部量取，向根部为负；动臂加长时此点随 B 一起前移' },
  { key: 'armCylBodyPerp', group: '斗杆油缸', label: '缸筒端 垂直动臂', unit: 'mm', min: -1200, max: 2000, step: 5, kind: 'length', primary: false,
    hint: '正值在动臂上方（装在动臂上表面），一般取正值' },
  { key: 'armCylRodAlong', group: '斗杆油缸', label: '活塞杆端 沿斗杆', unit: 'mm', min: -2000, max: 1500, step: 5, kind: 'length', primary: false,
    hint: '斗杆坐标系（原点 B，+x 指向斗杆末端 C）：真机该铰点在 B 点后方，一般取负值' },
  { key: 'armCylRodPerp', group: '斗杆油缸', label: '活塞杆端 垂直斗杆', unit: 'mm', min: -1500, max: 1500, step: 5, kind: 'length', primary: false,
    hint: '正值在斗杆上平面；真机活塞杆端铰接在斗杆上平面，一般取正值。该铰点还须全程落在动臂两端点连线上方（由行程内的姿态决定），见「油缸布置自检」' },
  { key: 'armCylClosed', group: '斗杆油缸', label: '安装距（全缩）', unit: 'mm', min: 600, max: 6000, step: 5, kind: 'length', primary: true,
    hint: '油缸全缩时两铰点中心距（全缩 = 斗杆最外伸）' },
  { key: 'armCylStroke', group: '斗杆油缸', label: '行程', unit: 'mm', min: 200, max: 3500, step: 5, kind: 'length', primary: true,
    hint: '决定斗杆相对转角范围；伸出 → 斗杆收拢（挖掘方向）' },

  // ---- 铲斗油缸与四连杆 ----
  { key: 'bktCylBodyAlong', group: '铲斗油缸与四连杆', label: '缸筒端 自 C 沿斗杆', unit: 'mm', min: -4500, max: 0, step: 5, kind: 'length', primary: false,
    hint: '自铲斗铰点 C（斗杆末端销孔）沿斗杆轴线向根部量取，向根部为负；斗杆加长时此点随 C 一起前移' },
  { key: 'bktCylBodyPerp', group: '铲斗油缸与四连杆', label: '缸筒端 垂直斗杆', unit: 'mm', min: -1000, max: 1500, step: 5, kind: 'length', primary: false,
    hint: '正值在斗杆上方；铲斗油缸安装在斗杆上方，取正值' },
  { key: 'bktBellAlong', group: '铲斗油缸与四连杆', label: '摇杆铰点 自 C 沿斗杆', unit: 'mm', min: -5000, max: 0, step: 5, kind: 'length', primary: false,
    hint: '摇杆在斗杆上的铰点 D（自斗杆末端销孔 C 向根部量取，为负），靠近斗杆前端' },
  { key: 'bktBellPerp', group: '铲斗油缸与四连杆', label: '摇杆铰点 垂直斗杆', unit: 'mm', min: -1200, max: 1500, step: 5, kind: 'length', primary: false,
    hint: '正值在斗杆上方；真机摇杆铰点位于斗杆上平面，取正值' },
  { key: 'bktRockerLen', group: '铲斗油缸与四连杆', label: '摇杆长度', unit: 'mm', min: 100, max: 1500, step: 5, kind: 'length', primary: false,
    hint: '摇杆两端铰点距离：一端铰在斗杆的 D 点，另一端与铲斗油缸活塞杆、连杆共用一个销轴' },
  { key: 'bktEAlong', group: '铲斗油缸与四连杆', label: '连杆–铲斗铰点 沿斗齿', unit: 'mm', min: -1500, max: 1500, step: 5, kind: 'length', primary: false,
    hint: '在铲斗坐标系中，自铰点 C 沿「C→斗齿尖」方向的距离；真机该铰点在斗背板上，一般取负值' },
  { key: 'bktEPerp', group: '铲斗油缸与四连杆', label: '连杆–铲斗铰点 垂直斗齿', unit: 'mm', min: -1500, max: 1500, step: 5, kind: 'length', primary: false,
    hint: '铲斗上连杆铰点位于斗齿尖连线的上方（正值），装在斗背支座上' },
  { key: 'bktLinkLen', group: '铲斗油缸与四连杆', label: '连杆长度', unit: 'mm', min: 100, max: 2500, step: 5, kind: 'length', primary: false,
    hint: '连杆两端铰点距离：一端与摇杆、活塞杆共销，另一端铰在铲斗上' },
  { key: 'bktBranch', group: '铲斗油缸与四连杆', label: '连杆装配侧', unit: '', min: -1, max: 1, step: 2, kind: 'number', decimals: 0, primary: false,
    hint: '四连杆圆交点的两支装配方案，+1 或 −1；选错会让铲斗转向反掉' },
  { key: 'bktCylClosed', group: '铲斗油缸与四连杆', label: '安装距（全缩）', unit: 'mm', min: 300, max: 5000, step: 5, kind: 'length', primary: true,
    hint: '油缸全缩时两铰点中心距（全缩 = 卸料位）' },
  { key: 'bktCylStroke', group: '铲斗油缸与四连杆', label: '行程', unit: 'mm', min: 100, max: 3000, step: 5, kind: 'length', primary: true,
    hint: '决定铲斗相对转角范围；伸出 → 收斗（挖掘方向）' },

  // ---- 整机外形 ----
  { key: 'tailSwingRadius', group: '整机外形', label: '尾部回转半径', unit: 'mm', min: 800, max: 5000, step: 10, kind: 'length', primary: false,
    hint: '回转中心至机尾最外缘的水平距离' },
  { key: 'trackLength', group: '整机外形', label: '履带长度', unit: 'mm', min: 1500, max: 6500, step: 10, kind: 'length', primary: false },
  { key: 'trackWidth', group: '整机外形', label: '履带总宽', unit: 'mm', min: 1000, max: 4500, step: 10, kind: 'length', primary: false },
  { key: 'trackHeight', group: '整机外形', label: '履带高度', unit: 'mm', min: 400, max: 1600, step: 10, kind: 'length', primary: false },
  { key: 'groundClearance', group: '整机外形', label: '最小离地间隙', unit: 'mm', min: 100, max: 900, step: 5, kind: 'length', primary: false },
  { key: 'cabHeight', group: '整机外形', label: '整机高度', unit: 'mm', min: 1500, max: 5000, step: 10, kind: 'length', primary: false,
    hint: '驾驶室顶距停机面的高度' },
  { key: 'platformFront', group: '整机外形', label: '平台前端外伸', unit: 'mm', min: 0, max: 2500, step: 10, kind: 'length', primary: false },
  { key: 'boomWidth', group: '整机外形', label: '动臂截面宽', unit: 'mm', min: 200, max: 900, step: 10, kind: 'length', primary: false },
  { key: 'armWidth', group: '整机外形', label: '斗杆截面宽', unit: 'mm', min: 150, max: 600, step: 10, kind: 'length', primary: false },
];

export const PARAM_GROUPS = ['工作装置几何', '铰点位置', '动臂油缸', '斗杆油缸', '铲斗油缸与四连杆', '整机外形'];

export const PARAM_SPEC_BY_KEY = Object.fromEntries(PARAM_SPEC.map((s) => [s.key, s]));

/**
 * 稳妥的数值转换。
 * 注意 Number('') === 0、Number(null) === 0、Number('  ') === 0，
 * 直接用 Number() 会把「缺字段」误判成 0，进而被当成越界值收敛到区间下界。
 * 这里把空值、空串、纯空白一律视为「未提供」。
 */
export function toFiniteNumber(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 数值范围收敛，保证任何来源（URL、预设、手输）的参数都落在合法区间内 */
export function sanitizeParams(raw, base) {
  const out = { ...base };
  for (const spec of PARAM_SPEC) {
    const v = toFiniteNumber(raw?.[spec.key]);
    if (v !== null) out[spec.key] = clamp(v, spec.min, spec.max);
  }
  if (typeof raw?.id === 'string') out.id = raw.id;
  if (typeof raw?.name === 'string' && raw.name.trim() !== '') out.name = raw.name;
  if (raw?.nominal && typeof raw.nominal === 'object') out.nominal = raw.nominal;
  return out;
}

/**
 * 合法性校验。返回 { ok, errors[], warnings[] }。
 * errors 会阻断计算（界面显示红字并保留上一次有效结果）。
 */
export function validateParams(p) {
  const errors = [];
  const warnings = [];

  if (!(p.boomLength > 0)) errors.push('动臂长度必须大于 0');
  if (!(p.armLength > 0)) errors.push('斗杆长度必须大于 0');
  if (!(p.bucketRadius > 0)) errors.push('铲斗销轴至斗齿尖距离必须大于 0');

  if (!(p.boomCylStroke > 0)) errors.push('动臂油缸行程必须大于 0');
  if (!(p.armCylStroke > 0)) errors.push('斗杆油缸行程必须大于 0');
  if (!(p.bktCylStroke > 0)) errors.push('铲斗油缸行程必须大于 0');
  if (!(p.bktLinkLen > 0)) errors.push('连杆长度必须大于 0');

  if (p.pivotY >= p.boomLength + p.armLength + p.bucketRadius) {
    errors.push('动臂铰点高度已超过整条工作装置链长，无法触地');
  }

  if (errors.length) return { ok: false, errors, warnings };

  // 机构可解性：任何一段行程都必须装配得上
  const r = resolveJointRanges(p);
  for (const [label, v] of [
    ['动臂仰角', [r.alphaMin, r.alphaMax]],
    ['斗杆相对转角', [r.deltaMin, r.deltaMax]],
    ['铲斗相对转角', [r.psiMin, r.psiMax]],
  ]) {
    if (!Number.isFinite(v[0]) || !Number.isFinite(v[1])) {
      errors.push(`${label}无法由油缸行程解出——油缸安装几何不能装配，请检查安装位置与安装距`);
    }
  }
  if (errors.length) return { ok: false, errors, warnings };

  if (r.alphaMax - r.alphaMin < 15) {
    errors.push(
      `动臂仰角范围仅 ${(r.alphaMax - r.alphaMin).toFixed(1)}°（需 ≥ 15°），无法形成有效作业范围；请加大动臂油缸行程或调整安装位置`,
    );
  }
  if (r.psiMax - r.psiMin < 60) {
    errors.push(
      `铲斗相对转角范围仅 ${(r.psiMax - r.psiMin).toFixed(1)}°（需 ≥ 60°）；请加大铲斗油缸行程`,
    );
  }

  // 上限合理性提示：动臂仰角过大意味着工作装置会向后仰、压到驾驶室，
  // 真实机型靠驾驶室与油缸行程双重限位，不会到这么高
  if (r.alphaMax > 80) {
    warnings.push(
      `动臂仰角上限解出 ${r.alphaMax.toFixed(1)}°，已超过真机可行范围（通常 ≤ 70°）；` +
        '实际机型受驾驶室与油缸限位约束到不了这个角度，建议减小动臂油缸行程或调整安装位置',
    );
  }
  if (r.psiMax - r.psiMin > 220) {
    warnings.push(
      `铲斗相对转角范围达 ${(r.psiMax - r.psiMin).toFixed(0)}°，超出常规铲斗行程（约 180°），建议核对铲斗油缸行程`,
    );
  }

  // 最大挖掘深度姿态要求：斗杆能转到「B、C、T 三点共线且竖直向下」
  const deltaForDepth = -90 - r.alphaMin;
  if (deltaForDepth < r.deltaMin - 1e-9 || deltaForDepth > r.deltaMax + 1e-9) {
    warnings.push(
      `斗杆相对转角范围 [${r.deltaMin.toFixed(1)}°, ${r.deltaMax.toFixed(1)}°] 覆盖不到最大挖掘深度姿态所需的 ` +
        `${deltaForDepth.toFixed(1)}°，该指标将按可达极限计算`,
    );
  }

  // 最大挖掘高度 / 卸载高度姿态：铲斗油缸全伸时斗齿尖应朝上（收斗），全缩时应能转到朝下（卸料）
  const psiForDump = -90 - (r.alphaMax + r.deltaMax);
  if (psiForDump < r.psiMin - 5e-3 || psiForDump > r.psiMax + 5e-3) {
    warnings.push(
      `铲斗转角范围 [${r.psiMin.toFixed(1)}°, ${r.psiMax.toFixed(1)}°] 覆盖不到最大卸载高度姿态所需的 ` +
        `${psiForDump.toFixed(1)}°，该指标按可达极限计算`,
    );
  }

  // 油缸布置自检：安装点坐标口径、伸出方向（伸出 = 作业方向）、与动臂/斗杆本体的干涉
  const layout = verifyCylinderLayout(p);
  for (const c of layout.checks) {
    if (!c.ok) warnings.push(`油缸布置自检：${c.label}（当前 ${c.detail}）`);
  }

  return { ok: errors.length === 0, errors, warnings };
}

/* ------------------------------------------------------------------ *
 * 派生量
 * ------------------------------------------------------------------ */

/**
 * 铲斗相对转角的合法区间 —— 现已完全由铲斗油缸 + 四连杆解出。
 * curl = 铲斗油缸全缩（收斗，最大挖掘高度姿态用）
 * dump = 铲斗油缸全伸（卸料）
 */
export function bucketRotationRange(p) {
  const r = resolveJointRanges(p);
  return { curl: r.psiCurl, dump: r.psiDump, min: r.psiMin, max: r.psiMax };
}

/** 每个关节的可达区间，供包络采样与指标计算使用 */
export function jointRanges(p) {
  const r = resolveJointRanges(p);
  return {
    alpha: [r.alphaMin, r.alphaMax],
    delta: [r.deltaMin, r.deltaMax],
    psi: [r.psiMin, r.psiMax],
  };
}
