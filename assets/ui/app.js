/**
 * 应用主控
 * ==========================================================================
 * 职责：
 *   · 维护唯一状态（params + view），任何输入都只改状态、再统一重算重绘
 *   · 用 requestAnimationFrame 把同一帧内的多次输入合并成一次计算
 *   · URL ↔ 状态双向同步（分享链接）
 *   · 参数表按需刷新（比绘图重，做去抖）
 *
 * 渲染管线：输入 → (rAF) → 校验 → 指标 → 包络 → 最小回转半径 → SVG 字符串
 */

import { PRESETS, clonePreset, defaultParams, getPreset } from '../core/presets.js';
import { validateParams } from '../core/params.js';
import { computeMetrics } from '../core/metrics.js';
import { computeEnvelope, computeMinSwingRadius } from '../core/envelope.js';
import { decodeParams, encodeParams } from '../core/share.js';
// ?v= 发版戳：这两个模块改过，而老访客的浏览器可能还攥着 7 天缓存的旧副本
// （资源文件名不带内容指纹，浏览器在自己的 max-age 到期前不会回源）。
// 换一个没见过的 URL 才能把它们拉过来；线上缓存已改为 5 分钟，
// 带 ?v= 的 URL 同样每 5 分钟回源校验，所以这个戳不必每次发版都改。
// 其余 import 的文件本次未改动，不需要加。
import { renderChart, resolvePose, cylinderLengthRange, poseCylinderLengths } from './draw.js?v=20261005a';
import { createChartZoom } from './zoom.js?v=20261005a';
import { renderSchematicFigure } from './schematic.js';
import { createControls } from './controls.js';
import { renderSpecTables, renderPrintHeader } from './chart-table.js';
import { exportPng, exportSvg, copyText, safeFilename } from './exporter.js';

const $ = (id) => document.getElementById(id);

const el = {
  chart: $('chart'),
  chartZoom: $('chartZoom'),
  tableWrap: $('tableWrap'),
  panel: $('panel'),
  perf: $('perf'),
  toast: $('toast'),
  printOnly: $('printOnly'),
  presetSelect: $('presetSelect'),
  poseSelect: $('poseSelect'),
  poseCtl: $('poseCtl'),
  poseHint: $('poseHint'),
  zoomLevel: $('zoomLevel'),
};

/** 「工作姿态（可调）」里的三个油缸长度滑块 */
const POSE_SLIDERS = [
  { key: 'boomL', kind: 'boom', sl: 'slBoom', val: 'valBoom', name: '动臂油缸' },
  { key: 'armL', kind: 'arm', sl: 'slArm', val: 'valArm', name: '斗杆油缸' },
  { key: 'bktL', kind: 'bkt', sl: 'slBkt', val: 'valBkt', name: '铲斗油缸' },
];

const DEFAULT_DIM_KEYS = [
  'groundMaxRadius',
  'maxDigHeight',
  'dumpHeight',
  'maxDigDepth',
  'verticalWallDepth',
  'minSwingRadius',
];

const state = {
  params: null,
  view: {
    // 'outline' = 实体外形（默认）｜'schematic' = 机构运动简图
    style: 'outline',
    showEnvelope: true,
    showDims: true,
    showBody: true,
    showInner: false,
    showTailCircle: true,
    poseMode: 'custom',
    customPose: {},
    dimKeys: DEFAULT_DIM_KEYS,
  },
  values: null,
  poses: null,
  pose: null,
  env: null,
  valid: true,
  lastError: '',
  renderMs: 0,
  calcMs: 0,
  breakdown: { metrics: 0, swing: 0, envelope: 0 },
};

let controls = null;
let zoom = null;
let rafId = 0;
let tableTimer = 0;
let urlTimer = 0;

/* ------------------------------------------------------------------ *
 * 计算
 * ------------------------------------------------------------------ */

function recompute() {
  const p = state.params;
  const check = validateParams(p);

  if (!check.ok) {
    state.valid = false;
    state.lastError = check.errors.join('；');
    showNotices(check);
    return false;
  }
  state.valid = true;
  state.lastError = '';

  const t0 = performance.now();
  const { values, poses, warnings } = computeMetrics(p);
  const t1 = performance.now();
  values.minSwingRadius = computeMinSwingRadius(p);
  const t2 = performance.now();
  state.env = computeEnvelope(p);
  const t3 = performance.now();

  state.values = values;
  state.poses = poses;
  state.calcMs = t3 - t0;
  state.breakdown = { metrics: t1 - t0, swing: t2 - t1, envelope: t3 - t2 };

  showNotices(check, warnings);
  return true;
}

function showNotices(check, extraWarnings = []) {
  if (!controls) return;
  const html = [];
  for (const e of check.errors ?? []) html.push(`<div class="notice error">✕ ${e}</div>`);
  for (const w of [...(check.warnings ?? []), ...extraWarnings]) html.push(`<div class="notice warn">! ${w}</div>`);
  controls.setExternalNotices(html.join(''));
}

/* ------------------------------------------------------------------ *
 * 绘制
 * ------------------------------------------------------------------ */

/**
 * 生成指定画布尺寸的整幅 SVG 字符串（纯字符串，不碰 DOM）。
 * 屏幕渲染与「离屏高分辨率导出」共用同一份入参装配，避免两处走偏。
 */
function chartSvg(W, H) {
  return renderChart({
    W,
    H,
    p: state.params,
    values: state.values,
    poses: state.poses,
    env: state.env,
    view: state.view,
    minSwingRadius: state.values?.minSwingRadius,
  });
}

function renderChartNow() {
  const W = el.chart.clientWidth;
  const H = el.chart.clientHeight;
  if (W < 40 || H < 40) return;

  // 当前姿态只解一次：绘图、参数表小图、油缸长度滑块都用它
  state.pose = state.valid ? resolvePose(state.params, state.view, state.poses) : null;

  const t0 = performance.now();
  el.chartZoom.innerHTML = chartSvg(W, H);
  // 画布尺寸变了，旧位移可能落到合法区间外，重新钳制
  zoom?.clampContent();
  state.renderMs = performance.now() - t0;
  syncPoseControls();

  el.perf.textContent = state.valid
    ? `指标 ${state.breakdown.metrics.toFixed(0)} · 回转 ${state.breakdown.swing.toFixed(0)} · ` +
      `包络 ${state.breakdown.envelope.toFixed(0)} · 绘制 ${state.renderMs.toFixed(0)} ms`
    : '参数无效，保留上一次结果';
}

/* ------------------------------------------------------------------ *
 * 工作姿态（可调）：三个油缸长度滑块
 * 范围 = 安装距（全缩）~ 安装距 + 行程（全伸）。
 * 它只决定「图上把机器摆成什么姿态」，不参与指标与包络计算。
 * ------------------------------------------------------------------ */

function setPosePanelVisible() {
  el.poseCtl.hidden = !(state.view.poseMode === 'custom' && !el.chart.hidden);
}

function syncPoseControls() {
  setPosePanelVisible();
  if (!state.valid) return;
  const lens = poseCylinderLengths(state.params, state.pose);
  if (!lens) return;
  for (const d of POSE_SLIDERS) {
    const r = cylinderLengthRange(state.params, d.kind);
    const input = $(d.sl);
    const out = $(d.val);
    input.min = String(Math.round(r.min));
    input.max = String(Math.round(r.max));
    input.step = '5';
    const wanted = Number.isFinite(state.view.customPose[d.key]) ? state.view.customPose[d.key] : lens[d.key];
    const v = Math.min(Math.max(wanted, r.min), r.max);
    // 参数改动后原值可能落到区间外，回写状态，避免滑块显示与实际姿态对不上
    if (Number.isFinite(state.view.customPose[d.key])) state.view.customPose[d.key] = v;
    input.value = String(Math.round(v));
    const pct = r.max > r.min ? ((v - r.min) / (r.max - r.min)) * 100 : 0;
    out.textContent = `${Math.round(v)} mm`;
    out.title = `${d.name}：安装距 ${Math.round(r.min)} mm，全伸 ${Math.round(r.max)} mm，当前行程使用 ${pct.toFixed(0)}%`;
  }
  el.poseHint.textContent = '范围 = 安装距 ~ 安装距 + 行程；拖到两端就是全缩 / 全伸';
}

function useCustomPose() {
  if (state.view.poseMode === 'custom') return;
  state.view.poseMode = 'custom';
  if (el.poseSelect) el.poseSelect.value = 'custom';
}

function onPoseLengthInput(d, input) {
  const r = cylinderLengthRange(state.params, d.kind);
  const v = Math.min(Math.max(Number(input.value), r.min), r.max);
  useCustomPose();
  state.view.customPose[d.key] = v;
  $(d.val).textContent = `${Math.round(v)} mm`;
  // 姿态不参与指标与包络计算，直接重绘，不必重算
  renderChartNow();
  scheduleTableRender();
}

function resetPoseLengths() {
  state.view.customPose = {};
  useCustomPose();
  renderChartNow();
  scheduleTableRender();
}

/** 参数表页签与打印页里的「工作装置机构运动简图」小图 */
function schematicFigureHtml() {
  if (!state.valid) return '';
  const pose = state.pose ?? resolvePose(state.params, state.view, state.poses);
  const svg = renderSchematicFigure({ p: state.params, pose });
  return svg ? `<div class="schematic-figure">${svg}</div>` : '';
}

function renderTableNow() {
  if (!state.valid) return;
  const { html } = renderSpecTables(state.params, state.values, state.poses, { showNominal: true });
  el.tableWrap.innerHTML = schematicFigureHtml() + html;
}

/** 参数表重绘去抖（滑块拖动时用） */
function scheduleTableRender(ms = 160) {
  clearTimeout(tableTimer);
  tableTimer = setTimeout(renderTableNow, ms);
}

function scheduleRender({ table = false, url = true } = {}) {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    if (recompute()) renderChartNow();
    else setPosePanelVisible();
  });

  if (table) scheduleTableRender();
  if (url) {
    clearTimeout(urlTimer);
    urlTimer = setTimeout(syncUrl, 350);
  }
}

function syncUrl() {
  if (typeof history?.replaceState !== 'function') return;
  try {
    const q = encodeParams(state.params);
    const url = `${location.pathname}${q ? `?${q}` : ''}`;
    history.replaceState(null, '', url);
  } catch {
    /* file:// 或沙箱环境下忽略 */
  }
}

/* ------------------------------------------------------------------ *
 * 提示
 * ------------------------------------------------------------------ */

let toastTimer = 0;
function toast(msg, ms = 2000) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), ms);
}

/* ------------------------------------------------------------------ *
 * 机型切换
 * ------------------------------------------------------------------ */

function applyParams(p, { resetPose = true } = {}) {
  state.params = p;
  if (resetPose) {
    state.view.customPose = {};
    state.view.poseMode = 'custom';
    if (el.poseSelect) el.poseSelect.value = 'custom';
  }
  controls?.sync(state.params);
  if (el.presetSelect) {
    const known = PRESETS.some((m) => m.id === state.params.id);
    el.presetSelect.value = known ? state.params.id : 'custom';
  }
  scheduleRender({ table: true });
}

function onPresetChange(id) {
  if (id === 'custom') {
    const p = defaultParams();
    p.name = '自定义机型';
    applyParams(p);
    toast('已切换到自定义机型（基于 20 吨级机型 默认几何）');
    return;
  }
  const preset = getPreset(id);
  if (!preset) return;
  applyParams(clonePreset(id));
  toast(`已载入 ${preset.name}`);
}

function onReset() {
  const id = state.params.id;
  if (id && getPreset(id)) {
    applyParams(clonePreset(id));
    toast('已恢复到该机型的标定参数');
  } else {
    const p = defaultParams();
    p.name = state.params.name ?? '自定义机型';
    applyParams(p);
    toast('已恢复默认参数');
  }
}

/* ------------------------------------------------------------------ *
 * 导出
 * ------------------------------------------------------------------ */

function currentSvg() {
  return el.chart.querySelector('svg');
}

/**
 * 离屏渲染一张「够大」的图用于位图导出。
 *
 * 为什么要离屏：exporter 用 SVG 的 viewBox 决定位图尺寸，所以手机上直接导出
 * 只能得到 ~780×920 的 PNG。这里按长边 ≥ minLongEdge 重渲染一次，
 * 导出画质就与屏幕多大无关了；取景比例与屏幕上一致。
 *
 * 桌面（画布长边已 ≥1400）时 k = 1，输出与改动前完全相同。
 * 缩放/平移**有意不参与**：导出的始终是完整未缩放的图。
 */
function exportSvgElement(minLongEdge = 1400) {
  // 切到「参数表」页签时图被隐藏、clientWidth/Height 为 0，
  // 此时回落到上一次渲染出的 viewBox，避免缩放系数算成 Infinity
  const vb = currentSvg()?.viewBox?.baseVal;
  const W = el.chart.clientWidth || vb?.width || 1200;
  const H = el.chart.clientHeight || vb?.height || 800;
  const k = Math.max(1, minLongEdge / Math.max(W, H));
  const host = document.createElement('div');
  host.innerHTML = chartSvg(Math.round(W * k), Math.round(H * k));
  return host.querySelector('svg');
}

async function onExportPng() {
  if (!currentSvg()) return toast('图形尚未就绪');
  try {
    toast('正在生成 PNG…', 4000);
    await exportPng(exportSvgElement(1400), safeFilename(state.params.name, 'png'), 2);
    toast('PNG 已导出');
  } catch (err) {
    toast(`导出失败：${err.message}`);
  }
}

function onExportSvg() {
  const svg = currentSvg();
  if (!svg) return toast('图形尚未就绪');
  exportSvg(svg, safeFilename(state.params.name, 'svg'));
  toast('SVG 已导出');
}

function onPrint() {
  // 打印前把参数表填进 print-only 区域（屏幕上不可见）
  if (state.valid) {
    const { sizeTable, geomTable, derivedTable, mountTable, layoutTable, poseTable } = renderSpecTables(
      state.params,
      state.values,
      state.poses,
      { showNominal: true },
    );
    el.printOnly.innerHTML =
      schematicFigureHtml() +
      renderPrintHeader(state.params) +
      sizeTable +
      geomTable +
      derivedTable +
      mountTable +
      layoutTable +
      poseTable;
  }
  setTimeout(() => window.print(), 60);
}

async function onShare() {
  let url;
  try {
    const q = encodeParams(state.params);
    url = `${location.origin}${location.pathname}${q ? `?${q}` : ''}`;
    if (!location.origin || location.origin === 'null') throw new Error('no-origin');
  } catch {
    url = `${location.href.split('?')[0]}?${encodeParams(state.params)}`;
  }
  const ok = await copyText(url);
  toast(ok ? '分享链接已复制到剪贴板' : `复制失败，请手动复制：${url}`, ok ? 2000 : 6000);
}

/* ------------------------------------------------------------------ *
 * 页签
 * ------------------------------------------------------------------ */

function setTab(name) {
  const isChart = name === 'chart';
  el.chart.hidden = !isChart;
  el.tableWrap.hidden = isChart;
  $('tabChart').classList.toggle('primary', isChart);
  $('tabTable').classList.toggle('primary', !isChart);
  setPosePanelVisible();
  if (!isChart) renderTableNow();
  else scheduleRender({ table: false, url: false });
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

function initViewControls() {
  const bind = (id, key) => {
    const box = $(id);
    box.checked = state.view[key];
    box.addEventListener('change', () => {
      state.view[key] = box.checked;
      renderChartNow();
    });
  };
  bind('optEnvelope', 'showEnvelope');
  bind('optDims', 'showDims');
  bind('optBody', 'showBody');
  bind('optTail', 'showTailCircle');

  el.poseSelect.value = state.view.poseMode;
  el.poseSelect.addEventListener('change', () => {
    state.view.poseMode = el.poseSelect.value;
    renderChartNow();
  });

  // 工作姿态（可调）：三个油缸长度滑块
  for (const d of POSE_SLIDERS) {
    const input = $(d.sl);
    input.addEventListener('input', () => onPoseLengthInput(d, input));
    input.addEventListener('change', () => onPoseLengthInput(d, input));
  }
  $('btnPoseReset').addEventListener('click', () => {
    resetPoseLengths();
    toast('已恢复默认工作姿态');
  });

  // 画法：实体外形 / 机构运动简图
  const setStyle = (style) => {
    state.view.style = style;
    $('btnOutline').classList.toggle('primary', style === 'outline');
    $('btnSchematic').classList.toggle('primary', style === 'schematic');
    renderChartNow();
    if (!el.tableWrap.hidden) renderTableNow();
  };
  $('btnOutline').addEventListener('click', () => setStyle('outline'));
  $('btnSchematic').addEventListener('click', () => setStyle('schematic'));

  $('tabChart').addEventListener('click', () => setTab('chart'));
  $('tabTable').addEventListener('click', () => setTab('table'));
}

function initTopbar() {
  const sel = el.presetSelect;
  sel.innerHTML =
    PRESETS.map((m) => `<option value="${m.id}">${m.name}</option>`).join('') +
    `<option value="custom">自定义机型</option>`;
  sel.addEventListener('change', () => onPresetChange(sel.value));

  $('btnReset').addEventListener('click', onReset);
  $('btnShare').addEventListener('click', onShare);
  $('btnPng').addEventListener('click', onExportPng);
  $('btnSvg').addEventListener('click', onExportSvg);
  $('btnPdf').addEventListener('click', onPrint);
  window.addEventListener('beforeprint', onPrint);
}

function initResize() {
  let last = { w: 0, h: 0 };
  const ro = new ResizeObserver(() => {
    const w = el.chart.clientWidth;
    const h = el.chart.clientHeight;
    if (Math.abs(w - last.w) < 2 && Math.abs(h - last.h) < 2) return;
    last = { w, h };
    if (!el.chart.hidden) renderChartNow();
  });
  ro.observe(el.chart);
}

/* ------------------------------------------------------------------ *
 * 图面缩放 / 平移（手机双指捏合、滚轮、双击、右下角按钮）
 * ------------------------------------------------------------------ */

function initZoom() {
  const setDisabled = (id, off) => {
    const b = $(id);
    if (b) b.disabled = !!off;
  };
  const syncZoomUi = ({ k }) => {
    if (el.zoomLevel) el.zoomLevel.textContent = `${k.toFixed(k < 10 ? 1 : 0).replace(/\.0$/, '')}×`;
    setDisabled('zoomOut', k <= 1.0001);
    setDisabled('zoomReset', k <= 1.0001);
  };

  zoom = createChartZoom({ host: el.chart, content: el.chartZoom, onChange: syncZoomUi });
  $('zoomIn').addEventListener('click', () => zoom.zoomBy(1.4));
  $('zoomOut').addEventListener('click', () => zoom.zoomBy(1 / 1.4));
  $('zoomReset').addEventListener('click', () => zoom.reset());
  syncZoomUi(zoom.getTransform());
}

function boot() {
  // 1) 决定初始参数：URL 里带参数才用 URL，否则载入默认预设（20 吨级机型）
  const query = typeof location !== 'undefined' ? location.search || location.hash : '';
  const fromUrl = query ? decodeParams(query) : null;
  state.params = fromUrl ?? clonePreset(PRESETS[0].id);

  // 2) 面板
  controls = createControls(el.panel, {
    onChange: (key, value) => {
      state.params[key] = value;
      scheduleRender({ table: true });
    },
    getParams: () => state.params,
  });
  controls.sync(state.params);

  // 3) 顶栏与视图开关
  initTopbar();
  initViewControls();
  initResize();
  initZoom();
  setTab('chart');

  // 4) 首次计算与绘制
  if (el.presetSelect) {
    const known = PRESETS.some((m) => m.id === state.params.id);
    el.presetSelect.value = known ? state.params.id : 'custom';
  }
  scheduleRender({ table: true, url: !fromUrl });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
