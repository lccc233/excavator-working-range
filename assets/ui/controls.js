/**
 * 参数面板：滑块 ↔ 数字输入双向联动
 * ==========================================================================
 * 由 PARAM_SPEC 自动生成控件，新增参数只要改 params.js 一处。
 *
 * 交互约定：
 *   · 拖动滑块 / 输入数字 → 立即回调 onChange（由 app.js 合并到同一帧）
 *   · 输入框在「输入过程中」不回写，避免把 "1" 之类的中间值当成正式值；
 *     失焦或回车才提交并做范围收敛
 */

import { PARAM_SPEC, PARAM_GROUPS, validateParams } from '../core/params.js?v=20261005c';

const GROUP_HINT = {
  工作装置几何: '决定作业范围的基本尺寸',
  铰点位置: '动臂铰点 A 在整机上的安装位置（其余铰点都以它为基准）',
  动臂油缸: '缸筒端以「相对动臂铰点 A 的 ΔX/ΔY」给出（一般 ΔX>0、ΔY<0）；行程决定动臂仰角范围',
  斗杆油缸: '缸筒端在动臂上表面；活塞杆端在斗杆上平面、B 点后方（沿斗杆为负、垂直斗杆为正）',
  铲斗油缸与四连杆: '铲斗油缸装在斗杆上方，活塞杆端接摇臂长臂；摇臂短臂经连杆拉动铲斗（标准四连杆）',
  挖掘力液压参数: '设定压力、效率和相关油缸参数，实时估算当前姿态下的单动作切向挖掘力',
  整机外形: '影响图形外观与最小回转半径，不改变作业尺寸',
};

const DEFAULT_OPEN = {
  工作装置几何: true,
  铰点位置: true,
  // 油缸与连杆参数多且属于工程数据，默认收起；改行程是常见操作，所以动臂/斗杆油缸默认展开
  动臂油缸: true,
  斗杆油缸: false,
  铲斗油缸与四连杆: false,
  挖掘力液压参数: true,
  整机外形: false,
};

function misc(key) {
  return PARAM_SPEC.find((s) => s.key === key);
}

export function createControls(container, opts = {}) {
  const { onChange, getParams } = opts;
  const inputs = new Map(); // key -> { range, number }

  container.innerHTML = '';

  const noticeEl = document.createElement('div');
  noticeEl.className = 'notice';

  for (const group of PARAM_GROUPS) {
    const specs = PARAM_SPEC.filter((s) => s.group === group);
    if (!specs.length) continue;

    const details = document.createElement('details');
    details.className = 'panel-group';
    details.open = DEFAULT_OPEN[group] ?? false;

    const summary = document.createElement('summary');
    summary.innerHTML = `<span>${group}</span><span class="count">${specs.length} 项</span>`;
    summary.title = GROUP_HINT[group] ?? '';
    details.appendChild(summary);

    for (const spec of specs) {
      details.appendChild(buildField(spec, inputs, onChange));
    }
    container.appendChild(details);
  }

  container.appendChild(noticeEl);

  /* ---------- 对外接口 ---------- */

  function sync(p) {
    for (const [key, pair] of inputs) {
      const v = p[key];
      if (!Number.isFinite(v)) continue;
      const spec = misc(key);
      const str = spec.kind === 'number' ? v.toFixed(spec.decimals ?? 2) : String(round(v, spec));
      if (pair.range.value !== str) pair.range.value = str;
      if (document.activeElement !== pair.number) pair.number.value = str;
    }
    renderNotices(p);
  }

  function renderNotices(p) {
    const v = validateParams(p);
    const msgs = [];
    for (const e of v.errors) msgs.push(`<div class="notice error">✕ ${e}</div>`);
    for (const w of v.warnings) msgs.push(`<div class="notice warn">! ${w}</div>`);
    noticeEl.innerHTML = msgs.join('');
  }

  function setExternalNotices(html) {
    noticeEl.innerHTML = html;
  }

  return { sync, setExternalNotices, element: noticeEl };
}

function round(v, spec) {
  const step = spec.step ?? 1;
  const decimals = step < 1 ? String(step).split('.')[1].length : 0;
  return Number(v.toFixed(decimals));
}

function buildField(spec, inputs, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'field';

  const head = document.createElement('div');
  head.className = 'field-head';

  const label = document.createElement('label');
  label.className = 'field-label';
  label.htmlFor = `f-${spec.key}`;
  label.textContent = spec.label;
  if (spec.hint) {
    const dot = document.createElement('span');
    dot.className = 'hint-dot';
    dot.textContent = '?';
    dot.title = spec.hint;
    label.appendChild(dot);
  }

  const valWrap = document.createElement('div');
  valWrap.className = 'field-value';
  const number = document.createElement('input');
  number.type = 'number';
  number.id = `f-${spec.key}`;
  number.min = String(spec.min);
  number.max = String(spec.max);
  number.step = String(spec.kind === 'number' ? (spec.step ?? 1) : 1);
  const unit = document.createElement('span');
  unit.className = 'unit';
  unit.textContent = spec.unit ?? '';
  valWrap.append(number, unit);

  head.append(label, valWrap);

  const range = document.createElement('input');
  range.type = 'range';
  range.min = String(spec.min);
  range.max = String(spec.max);
  range.step = String(spec.step ?? 1);
  range.tabIndex = -1;

  wrap.append(head, range);

  if (spec.hint) {
    const note = document.createElement('div');
    note.className = 'field-note';
    note.textContent = spec.hint;
    wrap.appendChild(note);
  }

  const emit = (raw) => {
    const v = Number(raw);
    if (!Number.isFinite(v)) return;
    const clamped = Math.min(Math.max(v, spec.min), spec.max);
    range.value = String(clamped);
    if (document.activeElement !== number) number.value = String(clamped);
    onChange(spec.key, clamped, { group: spec.group });
  };

  range.addEventListener('input', () => emit(range.value));
  number.addEventListener('change', () => emit(number.value));
  number.addEventListener('blur', () => emit(number.value));
  number.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      emit(number.value);
      number.blur();
    }
  });

  inputs.set(spec.key, { range, number, spec });
  return wrap;
}
