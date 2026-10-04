/**
 * 缩放 / 平移变换测试
 * ==========================================================================
 * zoom.js 把纯数学（clampTransform / zoomAt）与 DOM 分开，就是为了让这一层
 * 能在 Node 里直接测。这里守两条不变量：
 *
 *   1. **图不会被拖飞**：内容盒 = 视口盒，缩放 k 倍后位移必须落在 [W−W·k, 0]，
 *      即图永远盖满视口、不会露出白边，k=1 时位移必然归零。
 *   2. **缩放锚定在手指/光标下**：锚点对应的那一点在缩放前后位置不变，
 *      否则捏合时图会朝画布角落跑。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MIN_K,
  MAX_K,
  clampTransform,
  zoomAt,
  identityTransform,
  transformCss,
} from '../assets/ui/zoom.js';

test('clampTransform：k 被钳在 [MIN_K, MAX_K]', () => {
  for (const k of [-5, 0, 0.2, 1, 2.5, 8, 9, 100]) {
    const t = clampTransform({ k, tx: 0, ty: 0 }, 400, 300);
    assert.ok(t.k >= MIN_K && t.k <= MAX_K, `k=${k} → ${t.k} 越界`);
  }
});

test('clampTransform：1× 时位移必然归零（不存在残留位移）', () => {
  for (const [tx, ty] of [[0, 0], [-50, -50], [120, 30], [-1e6, 1e6]]) {
    const t = clampTransform({ k: 1, tx, ty }, 400, 300);
    assert.equal(t.k, 1);
    assert.equal(t.tx, 0, `tx=${tx} 未被归零`);
    assert.equal(t.ty, 0, `ty=${ty} 未被归零`);
  }
});

test('clampTransform：内容始终盖满视口（随机输入扫描）', () => {
  const sizes = [[320, 320], [360, 460], [390, 700], [1500, 1000]];
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (const [W, H] of sizes) {
    for (let i = 0; i < 400; i++) {
      const t = clampTransform({ k: rnd() * 12 - 1, tx: (rnd() - 0.5) * 4000, ty: (rnd() - 0.5) * 4000 }, W, H);
      // 下界是 W−W·k（负值），容差要往下放
      assert.ok(t.tx <= 1e-9 && t.tx >= W - W * t.k - 1e-9, `W=${W} k=${t.k} tx=${t.tx} 越界`);
      assert.ok(t.ty <= 1e-9 && t.ty >= H - H * t.k - 1e-9, `H=${H} k=${t.k} ty=${t.ty} 越界`);
    }
  }
});

test('clampTransform：非有限输入被兜住，不产生 NaN', () => {
  const t = clampTransform({ k: NaN, tx: NaN, ty: Infinity }, 400, 300);
  for (const v of [t.k, t.tx, t.ty]) assert.ok(Number.isFinite(v), `产生了非有限值: ${v}`);
  assert.equal(t.k, MIN_K);
  assert.equal(t.tx, 0);
});

test('zoomAt：锚点下的那一点在缩放前后不动', () => {
  const W = 390;
  const H = 460;
  const anchors = [[0, 0], [195, 230], [389, 459], [50, 400]];
  for (const [cx, cy] of anchors) {
    for (const factor of [1.4, 2, 0.5]) {
      const before = identityTransform();
      const after = zoomAt(before, factor, cx, cy, W, H);
      // 锚点对应的内容局部坐标 = (c - t) / k，缩放前后应相等
      const lx0 = (cx - before.tx) / before.k;
      const ly0 = (cy - before.ty) / before.k;
      const lx1 = (cx - after.tx) / after.k;
      const ly1 = (cy - after.ty) / after.k;
      // 只有在没被钳制时锚点才严格不变；1× 起点放大不会被钳制
      assert.ok(Math.abs(lx0 - lx1) < 1e-9, `cx=${cx} 锚点漂移 x: ${lx0} → ${lx1}`);
      assert.ok(Math.abs(ly0 - ly1) < 1e-9, `cy=${cy} 锚点漂移 y: ${ly0} → ${ly1}`);
    }
  }
});

test('zoomAt：先放大再等比缩小回到原状（未被钳制时）', () => {
  const W = 800;
  const H = 600;
  const start = { k: 2, tx: -150, ty: -90 };
  const z = zoomAt(start, 1.5, 400, 300, W, H);
  const back = zoomAt(z, 1 / 1.5, 400, 300, W, H);
  assert.ok(Math.abs(back.k - start.k) < 1e-9, `k: ${start.k} → ${back.k}`);
  assert.ok(Math.abs(back.tx - start.tx) < 1e-6, `tx: ${start.tx} → ${back.tx}`);
  assert.ok(Math.abs(back.ty - start.ty) < 1e-6, `ty: ${start.ty} → ${back.ty}`);
});

test('zoomAt：连续放大不会超过 MAX_K，且结果始终合法', () => {
  let t = identityTransform();
  for (let i = 0; i < 30; i++) t = zoomAt(t, 1.5, 100, 100, 390, 460);
  assert.equal(t.k, MAX_K);
  assert.ok(t.tx <= 0 && t.tx >= 390 - 390 * t.k - 1e-9);
});

test('zoomAt：1× 时继续缩小不会低于 MIN_K，也不产生位移', () => {
  const t = zoomAt(identityTransform(), 0.5, 200, 200, 390, 460);
  assert.equal(t.k, MIN_K);
  assert.equal(t.tx, 0);
  assert.equal(t.ty, 0);
});

test('transformCss 输出可直接用于 style.transform 且不含 NaN', () => {
  const css = transformCss({ k: 2, tx: -10, ty: -20 });
  assert.equal(css, 'translate(-10.00px, -20.00px) scale(2.0000)');
  assert.ok(!/NaN|undefined/.test(css));
});
