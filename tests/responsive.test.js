/**
 * 窄屏适配测试
 * ==========================================================================
 * 这一组守的是「手机上看得到、看得清」以及**「桌面端一行都不许变」**。
 *
 * 背景（别删，这是这个文件存在的理由）：
 *   手机端曾经完全看不到作业范围图 —— CSS 在 ≤920px 用固定高度网格分行，
 *   320px 的面板下限 + 换行的顶栏/工具栏把图那一行挤到 0 高，app.js 的
 *   `if (W<40||H<40) return` 随即静默跳过绘制。当时所有自动化只跑桌面尺寸
 *   （selftest 1000×700、CDP 脚本固定 1500×1000、draw.test.js 最小 420×300），
 *   所以没有一条检查能发现它。
 *
 * 最要紧的一条是 **chartPadding 桌面临界值**：它保证任何桌面宽度都走宽屏分支，
 * 从而让 renderChart 的桌面输出与改动前逐字节相同。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { PRESETS, clonePreset } from '../assets/core/presets.js';
import { computeMetrics } from '../assets/core/metrics.js';
import { computeEnvelope, computeMinSwingRadius } from '../assets/core/envelope.js';
import {
  renderChart,
  makeTransform,
  computeWorldBounds,
  chartPadding,
  metricCardMetrics,
  estimateTextWidth,
  placeDimLabel,
  NARROW_CANVAS_W,
} from '../assets/ui/draw.js';

const DEFAULT_DIMS = [
  'groundMaxRadius',
  'maxDigHeight',
  'dumpHeight',
  'maxDigDepth',
  'minSwingRadius',
];

function fixture(presetId = PRESETS[0].id, view = {}) {
  const p = clonePreset(presetId);
  const { values, poses } = computeMetrics(p);
  const env = computeEnvelope(p);
  const minSwingRadius = computeMinSwingRadius(p);
  values.minSwingRadius = minSwingRadius;
  return {
    p,
    values,
    poses,
    env,
    minSwingRadius, // renderChart 单独吃这个顶层入参（不是 values 里那个）
    view: {
      showEnvelope: true,
      showDims: true,
      showBody: true,
      showInner: false,
      showTailCircle: true,
      poseMode: 'custom',
      customPose: {},
      dimKeys: DEFAULT_DIMS,
      ...view,
    },
  };
}

/* ---------------- 1. 桌面端不变量（最重要） ---------------- */

test('chartPadding：桌面最窄画布（921 视口 − 344 面板）仍走宽屏分支', () => {
  // --panel-w: 344px、断点 920px → 桌面最窄画布 = 921 − 344 = 577
  const DESKTOP_MIN_CANVAS = 921 - 344;
  assert.ok(
    NARROW_CANVAS_W <= DESKTOP_MIN_CANVAS,
    `窄屏阈值 ${NARROW_CANVAS_W} 必须 ≤ 桌面最窄画布 ${DESKTOP_MIN_CANVAS}，` +
      '否则把桌面窗口拖窄时内边距会突跳',
  );
  for (const W of [DESKTOP_MIN_CANVAS, 600, 800, 1000, 1280, 1500, 1920, 2400]) {
    assert.deepEqual(
      chartPadding(W, true),
      { l: 34, t: 30, r: 96, b: 42 },
      `W=${W} 未使用历史内边距`,
    );
    assert.deepEqual(chartPadding(W, false), { l: 34, t: 30, r: 34, b: 42 }, `W=${W} 关标注时内边距变了`);
  }
});

test('renderChart：桌面各宽度输出与历史内边距口径一致（无翻转标注）', () => {
  const f = fixture();
  for (const W of [577, 640, 744, 900, 1100, 1280, 1500, 1920]) {
    const svg = renderChart({ ...f, W, H: Math.round(W * 0.65) });
    assert.equal(svg.includes('NaN'), false, `${W}: 含 NaN`);
    // 桌面 pad.r = 96 足够宽，右侧标注从不越界，因此不应出现「内收」的兜底标记
    assert.equal(svg.includes('data-clamped'), false, `${W}: 出现了不该有的标注内收`);
  }
});

/* ---------------- 2. 窄屏内边距 ---------------- */

test('chartPadding：窄屏四边都收紧，且 320px 下仍留得下绘图区', () => {
  const narrow = chartPadding(360, true);
  const wide = chartPadding(1500, true);
  for (const k of ['l', 't', 'r', 'b']) {
    assert.ok(narrow[k] < wide[k], `${k} 未收紧：${narrow[k]} vs ${wide[k]}`);
  }
  assert.equal(chartPadding(360, false).r, 22, '关标注时右侧留白应更小');
  // 最窄支持宽度：左右留白之后必须还有正数宽度
  const minW = 320;
  const pad = chartPadding(minW, true);
  assert.ok(minW - pad.l - pad.r > 100, `320px 下绘图区只剩 ${minW - pad.l - pad.r}px`);
});

test('metricCardMetrics：窄屏指标卡收窄，但仍装得下最长的标签行', () => {
  const pad = chartPadding(360, true);
  const narrow = metricCardMetrics(360, pad);
  const wide = metricCardMetrics(1500, pad);
  assert.ok(narrow.cw < wide.cw, '窄屏指标卡没有收窄');
  assert.ok(narrow.cw <= 176, `窄屏指标卡 ${narrow.cw}px 仍然太宽`);
  assert.ok(narrow.fs < wide.fs, '窄屏字号没有降档');

  // 内容宽 = cw − 左右各 12px 内边距；最长行 = 符号 + 标签 + 数值
  const inner = narrow.cw - 24;
  for (const meta of [{ s: 'A′', l: '停机面最大挖掘半径', v: '9,950' }, { s: 'C', l: '最大挖掘高度', v: '9,570' }]) {
    const rowW = estimateTextWidth(meta.s, narrow.fs) + 3 + estimateTextWidth(meta.l, narrow.fs) + estimateTextWidth(meta.v, narrow.fs);
    assert.ok(rowW <= inner, `「${meta.l}」行宽 ${rowW.toFixed(0)}px > 内容宽 ${inner.toFixed(0)}px`);
  }
});

/* ---------------- 3. 文本宽度估算 ---------------- */

test('estimateTextWidth：空串为 0、CJK 宽于 ASCII、随字号线性', () => {
  assert.equal(estimateTextWidth('', 12), 0);
  assert.ok(estimateTextWidth('中文标签', 12) > estimateTextWidth('abcd', 12), 'CJK 应宽于等字数 ASCII');
  assert.ok(Math.abs(estimateTextWidth('abcd', 24) - estimateTextWidth('abcd', 12) * 2) < 1e-9, '未随字号线性');
});

/* ---------------- 4. 标注摆放永不越界 ---------------- */

test('placeDimLabel：右侧放得下就用右侧（与历史摆法一致）', () => {
  const r = placeDimLabel({ x: 100, text: '短', fontSize: 12, W: 1000, side: 'right' });
  assert.equal(r.tx, 107);
  assert.equal(r.anchor, 'start');
});

test('placeDimLabel：右侧放不下就翻到左侧', () => {
  const text = 'A′ 停机面最大挖掘半径 9,950';
  const tw = estimateTextWidth(text, 12);
  const W = 400;
  const x = W - 30; // 右侧必然放不下，左侧放得下
  const r = placeDimLabel({ x, text, fontSize: 12, W, side: 'right' });
  assert.equal(r.anchor, 'end', '未翻到左侧');
  assert.equal(r.tx, x - 7);
  assert.ok(r.tx - tw >= 0, '翻到左侧后仍然越界');
});

test('placeDimLabel：两侧都放不下时内收，且永不越界（全宽度扫描）', () => {
  const texts = ['A′ 停机面最大挖掘半径 9,950', 'D 最大卸载高度 6,700', 'C 最大挖掘高度 9,570', '短', ''];
  for (const W of [320, 360, 390, 430, 480, 560, 577, 768, 1000, 1500]) {
    for (const text of texts) {
      const tw = estimateTextWidth(text, 12);
      for (let x = 0; x <= W; x += Math.max(1, W / 40)) {
        for (const side of ['left', 'right']) {
          const r = placeDimLabel({ x, text, fontSize: 12, W, side });
          const [left, right] = r.anchor === 'start' ? [r.tx, r.tx + tw] : [r.tx - tw, r.tx];
          assert.ok(
            right <= W - 4 + 1e-9,
            `W=${W} x=${x} side=${side} 右边缘 ${right.toFixed(1)} 越界`,
          );
          assert.ok(left >= 4 - 1e-9, `W=${W} x=${x} side=${side} 左边缘 ${left.toFixed(1)} 越界`);
        }
      }
    }
  }
});

/* ---------------- 5. 手机尺寸下真的能渲染出来 ---------------- */

const TEXT_RE = /<text x="([\d.-]+)" y="[\d.-]+"([^>]*)>([\s\S]*?)<\/text>/g;
const ANCHOR_RE = /text-anchor="(\w+)"/;
const FONT_RE = /font-size="([\d.]+)"/;

/** 取 SVG 里所有文字的左右边缘（按估算宽度），返回最右/最左 */
function textExtents(svg) {
  let right = 0;
  let left = 0;
  for (const m of svg.matchAll(TEXT_RE)) {
    const x = parseFloat(m[1]);
    const txt = m[3].replace(/<[^>]*>/g, '').trim();
    if (!txt) continue;
    const anchor = (m[2].match(ANCHOR_RE) ?? [, 'start'])[1];
    const fs = parseFloat((m[2].match(FONT_RE) ?? [, '12'])[1]);
    const tw = estimateTextWidth(txt, fs);
    const r = anchor === 'start' ? x + tw : anchor === 'end' ? x : x + tw / 2;
    if (r > right) right = r;
    if (r - tw < left) left = r - tw;
  }
  return { right, left };
}

test('手机尺寸下都能渲染，且文字不越出画布', () => {
  const f = fixture();
  const sizes = [[320, 320], [360, 380], [360, 460], [390, 460], [430, 932], [844, 390]];
  for (const [W, H] of sizes) {
    const svg = renderChart({ ...f, W, H });
    assert.ok(svg.startsWith('<svg'), `${W}x${H}: 未产出 SVG`);
    assert.ok(!/NaN|undefined|Infinity/.test(svg), `${W}x${H}: 含 NaN/undefined/Infinity`);
    const { right, left } = textExtents(svg);
    assert.ok(right <= W + 0.5, `${W}x${H}: 文字右边缘 ${right.toFixed(1)} 越出画布 ${W}`);
    assert.ok(left >= -0.5, `${W}x${H}: 文字左边缘 ${left.toFixed(1)} 越出画布`);
  }
});

test('手机尺寸下图形不会缩到看不见（可读性下限）', () => {
  const f = fixture();
  const world = computeWorldBounds(f.p, f.env);
  const worldW = world.maxX - world.minX;
  for (const [W, H] of [[360, 460], [390, 460], [430, 500]]) {
    const s = makeTransform(world, W, H, chartPadding(W, true)).s;
    const drawn = worldW * s;
    assert.ok(drawn >= 250, `${W}x${H}: 图形只有 ${drawn.toFixed(0)}px 宽`);
  }
});

test('窄屏阈值两侧的行为切换是明确的（无中间灰区）', () => {
  assert.deepEqual(chartPadding(NARROW_CANVAS_W - 1, true), { l: 26, t: 22, r: 54, b: 34 });
  assert.deepEqual(chartPadding(NARROW_CANVAS_W, true), { l: 34, t: 30, r: 96, b: 42 });
});
