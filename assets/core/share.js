/**
 * 分享链接编解码
 * ==========================================================================
 * 把当前机型参数压进 URL 查询串，客户复制链接后能在新标签页复现同一张图。
 *
 * 编码策略：`?m=<预设id>` + 只记录「与预设不同」的字段。
 * 这样 20 吨级机型 默认状态的链接最短，改得越多字段越多，可读性也还能接受。
 * 解码时先取预设（或默认机型）作为基底，再逐项覆盖并做范围收敛，
 * 因此脏链接、缺字段、超范围数值都不会让页面崩掉。
 */

import { PARAM_SPEC, sanitizeParams, toFiniteNumber } from './params.js?v=20261005b';
import { PRESETS, getPreset, BASE_DEFAULTS, defaultParams } from './presets.js?v=20261005b';

/** 参数名 → 短键，尽量短且不歧义 */
export const SHORT_KEYS = {
  boomLength: 'bl',
  armLength: 'al',
  bucketRadius: 'br',
  bucketCapacity: 'bc',
  boomBend: 'bb',
  bucketBottomAngle: 'ba',
  pivotX: 'px',
  pivotY: 'py',
  tailSwingRadius: 'ts',
  trackLength: 'tl',
  trackWidth: 'tw',
  trackHeight: 'th',
  groundClearance: 'gc',
  cabHeight: 'ch',
  platformFront: 'pf',
  boomWidth: 'bw',
  armWidth: 'aw',
  // 动臂油缸（缸筒端以「相对 A 的 ΔX/ΔY」给出）
  boomCylBodyDX: 'bx1',
  boomCylBodyDY: 'by1',
  boomCylRodAlong: 'ca1',
  boomCylRodPerp: 'cp1',
  boomCylClosed: 'cc1',
  boomCylStroke: 'cs1',
  // 斗杆油缸
  armCylBodyAlong: 'ca2',
  armCylBodyPerp: 'cp2',
  armCylRodAlong: 'cr2',
  armCylRodPerp: 'cq2',
  armCylClosed: 'cc2',
  armCylStroke: 'cs2',
  // 铲斗油缸
  bktCylBodyAlong: 'ca3',
  bktCylBodyPerp: 'cp3',
  bktCylClosed: 'cc3',
  bktCylStroke: 'cs3',
  // 铲斗四连杆（摇杆与连杆都是两铰点杆，共用销轴 P）
  bktBellAlong: 'ba1',
  bktBellPerp: 'bp1',
  bktRockerLen: 'brl',
  bktEAlong: 'ba3',
  bktEPerp: 'bp3',
  bktLinkLen: 'bll',
  bktBranch: 'bbr',
  // 挖掘力液压参数
  forcePressure: 'fp',
  forceBackPressure: 'fbp',
  forceEfficiency: 'fe',
  armCylBore: 'ab',
  armCylRodDiameter: 'ar',
  armCylCount: 'ac',
  bktCylBore: 'bbk',
  bktCylRodDiameter: 'brk',
  bktCylCount: 'bck',
};

export const LONG_KEYS = Object.fromEntries(Object.entries(SHORT_KEYS).map(([k, v]) => [v, k]));

/** 数值写入 URL 时的精度：角度 2 位小数，长度整数 */
function roundForUrl(key, value) {
  const spec = PARAM_SPEC.find((s) => s.key === key);
  const decimals = spec?.kind === 'angle' ? 2 : spec?.kind === 'number' ? 2 : 0;
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

/**
 * 编码为查询串（不含 '?'）。
 * @param {object} p 当前参数
 * @param {object} [opts]
 * @param {boolean} [opts.all] true 时写出全部字段（用于「导出全部参数」）
 */
export function encodeParams(p, opts = {}) {
  const preset = p.id && getPreset(p.id) ? getPreset(p.id) : null;
  const base = preset ?? BASE_DEFAULTS;
  const parts = [];

  if (preset) parts.push(`m=${encodeURIComponent(preset.id)}`);
  else if (p.name) parts.push(`n=${encodeURIComponent(p.name)}`);

  for (const spec of PARAM_SPEC) {
    const key = spec.key;
    const val = p[key];
    if (!Number.isFinite(val)) continue;
    const v = roundForUrl(key, val);
    if (!opts.all && Number.isFinite(base[key]) && roundForUrl(key, base[key]) === v) continue;
    parts.push(`${SHORT_KEYS[key]}=${v}`);
  }
  return parts.join('&');
}

/**
 * 解码查询串。
 * 任何非法输入都回落到「基底参数」，绝不抛异常。
 * @param {string} query 形如 '?m=x20t&bl=6000' 或 'm=x20t&bl=6000'
 * @param {object} [fallback] 基底参数，默认取默认机型
 */
export function decodeParams(query, fallback) {
  const raw = String(query ?? '').replace(/^[?#]/, '');
  const usp = new URLSearchParams(raw);

  const presetId = usp.get('m');
  const preset = presetId ? getPreset(presetId) : null;
  const base = preset ? { ...preset, nominal: { ...(preset.nominal ?? {}) } } : fallback ? { ...fallback } : defaultParams();

  const overrides = { id: preset ? preset.id : 'custom', name: preset ? preset.name : base.name };
  if (!preset && usp.get('n')) overrides.name = usp.get('n');

  for (const [short, long] of Object.entries(LONG_KEYS)) {
    if (!usp.has(short)) continue;
    const v = toFiniteNumber(usp.get(short));
    if (v !== null) overrides[long] = v;
  }

  const merged = sanitizeParams(overrides, base);
  // sanitizeParams 只搬运 PARAM_SPEC 里的字段，这里补回元信息
  merged.id = overrides.id;
  merged.name = overrides.name;
  merged.nominal = base.nominal ?? {};
  return merged;
}

/** 生成完整可复制的分享链接 */
export function buildShareUrl(p, baseUrl) {
  const base = baseUrl ?? (typeof location !== 'undefined' ? `${location.origin}${location.pathname}` : '');
  const q = encodeParams(p);
  return q ? `${base}?${q}` : base;
}

/** 是否所有字段都等于某个已知预设（用于下拉框回显） */
export function matchPreset(p) {
  for (const preset of PRESETS) {
    const keys = PARAM_SPEC.map((s) => s.key);
    if (keys.every((k) => Math.abs((p[k] ?? NaN) - preset[k]) < 1e-6)) return preset.id;
  }
  return null;
}
