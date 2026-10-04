/**
 * 机构运动简图测试
 * ==========================================================================
 * 「机构运动简图」不是换了个画法那么简单，它是对机构的抽象：
 * 画错了就说明机构模型本身有问题。所以这里的断言一半盯画法、
 * 一半盯机构拓扑：
 *   · 构件数与铰点数（6 个构件 / 11 个铰点 / 3 个移动副）
 *   · 摇杆、连杆都必须是「两铰点杆」，铲斗油缸活塞杆端必须与摇杆端共用一个销轴 P
 *   · 附属铰点（缸筒端、活塞杆端、摇杆铰点）必须落在他所属构件的轮廓内——
 *     否则简图上就会出现"油缸悬空"这种一眼假的画法
 *   · 动臂、斗杆的多边形不能自交
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { PRESETS } from '../assets/core/presets.js';
import { computeMetrics } from '../assets/core/metrics.js';
import { computeEnvelope, computeMinSwingRadius } from '../assets/core/envelope.js';
import { renderChart, resolvePose } from '../assets/ui/draw.js';
import {
  schematicModel,
  drawSchematic,
  renderSchematicFigure,
  schematicTransform,
  schematicPoints,
} from '../assets/ui/schematic.js';
import { scanXmlWellFormed } from './draw.test.js';

/** 射线法：点是否在多边形内 */
function pointInPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** 点到多边形各边的最短距离（mm） */
function distToEdges(pt, poly) {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j];
    const b = poly[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L2 = dx * dx + dy * dy || 1;
    let t = ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / L2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(pt.x - (a.x + t * dx), pt.y - (a.y + t * dy));
    if (d < best) best = d;
  }
  return best;
}

/** 点是否在多边形内（铰点常常正好是多边形顶点，所以允许落在边界上） */
function insideOrOn(pt, poly, tol = 1e-6) {
  return pointInPolygon(pt, poly) || distToEdges(pt, poly) <= tol;
}


function segCross(p1, p2, p3, p4) {
  const d = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d1 = d(p3, p4, p1);
  const d2 = d(p3, p4, p2);
  const d3 = d(p1, p2, p3);
  const d4 = d(p1, p2, p4);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

/** 多边形是否简单（不自交），相邻边不算相交 */
function polygonIsSimple(pts) {
  const m = pts.length;
  for (let i = 0; i < m; i++) {
    for (let j = i + 1; j < m; j++) {
      if (j === i || (j + 1) % m === i || (i + 1) % m === j) continue;
      if (segCross(pts[i], pts[(i + 1) % m], pts[j], pts[(j + 1) % m])) return false;
    }
  }
  return true;
}

/** 收集某机型的一组代表性姿态 */
function posesOf(m) {
  const { poses } = computeMetrics(m);
  const out = Object.entries(poses).map(([k, v]) => [`指标:${k}`, v]);
  for (const mode of ['custom', 'maxDigHeight', 'maxDigDepth', 'dumpHeight', 'verticalWallDepth']) {
    const p = resolvePose(m, { poseMode: mode, customPose: {} }, poses);
    if (p) out.push([`视图:${mode}`, p]);
  }
  return out;
}

test('每个机型的每种姿态都能解出机构简图', () => {
  for (const m of PRESETS) {
    for (const [tag, pose] of posesOf(m)) {
      const model = schematicModel(m, pose);
      assert.ok(model, `${m.id}/${tag}: 解不出简图`);
      for (const l of model.links) {
        for (const q of l.pts) {
          assert.ok(Number.isFinite(q.x) && Number.isFinite(q.y), `${m.id}/${tag}: ${l.id} 出现非有限坐标`);
        }
      }
      for (const j of model.joints) {
        assert.ok(Number.isFinite(j.pt.x) && Number.isFinite(j.pt.y), `${m.id}/${tag}: 铰点 ${j.id} 坐标非有限`);
      }
    }
  }
});

test('构件数、铰点数、移动副数与机构拓扑一致', () => {
  for (const m of PRESETS) {
    const model = schematicModel(m, computeMetrics(m).poses.maxDigDepth);
    const kinds = model.links.map((l) => l.id).sort();
    assert.deepEqual(kinds, ['arm', 'boom', 'bucket', 'frame', 'link', 'rocker'], `${m.id}: 构件集合不对`);
    assert.equal(model.cylinders.length, 3, `${m.id}: 应当是 3 个液压缸（移动副）`);
    assert.equal(model.joints.length, 11, `${m.id}: 铰点数应为 11`);

    const framed = model.joints.filter((j) => j.frameTo).map((j) => j.id).sort();
    assert.deepEqual(framed, ['A', 'boomBody'], `${m.id}: 固定在机架上的铰点只能是动臂铰点与动臂油缸缸筒端`);

    const compound = model.joints.filter((j) => j.compound);
    assert.equal(compound.length, 1, `${m.id}: 复合铰链只有 P 一处`);
    assert.equal(compound[0].id, 'P');
    assert.equal(compound[0].members, 3, `${m.id}: P 点应为摇杆 / 活塞杆 / 连杆 三构件共用`);

    // 铲斗按三铰点构件画：三角形 = 斗杆铰点 C / 连杆铰点 E / 斗齿尖 T
    const bk = model.links.find((l) => l.id === 'bucket');
    assert.equal(bk.pts.length, 3, `${m.id}: 铲斗应当是三角形`);
    for (const [i, key] of [[0, 'C'], [1, 'E'], [2, 'T']]) {
      assert.ok(
        Math.hypot(bk.pts[i].x - model.J[key].x, bk.pts[i].y - model.J[key].y) < 1e-9,
        `${m.id}: 铲斗三角形第 ${i + 1} 个顶点应当是 ${key}`,
      );
    }
  }
});

test('机架是直角边平行坐标轴的直角三角形（动臂根部与动臂油缸缸筒端为一体）', () => {
  for (const m of PRESETS) {
    for (const [tag, pose] of posesOf(m)) {
      const model = schematicModel(m, pose);
      const fr = model.links.find((l) => l.id === 'frame');
      assert.equal(fr.pts.length, 3, `${m.id}/${tag}: 机架应当是三角形`);
      const [A, K, B] = fr.pts;
      const near = (v, w) => Math.abs(v - w) < 1e-9;
      // 直角顶点：与 A 同一竖线、与缸筒端同一水平线 → 两条直角边分别平行 y 轴、x 轴
      assert.ok(near(K.x, A.x) && near(K.y, B.y), `${m.id}/${tag}: 直角顶点不在 A 的竖线与缸筒端水平线的交点上`);
      assert.ok(Math.hypot(A.x - model.J.A.x, A.y - model.J.A.y) < 1e-9, `${m.id}/${tag}: 三角形第一个顶点应当是动臂根部 A`);
      assert.ok(Math.hypot(B.x - model.J.boomBody.x, B.y - model.J.boomBody.y) < 1e-9, `${m.id}/${tag}: 三角形第三个顶点应当是动臂油缸缸筒端`);
      // 直角边不为零长（参数合法时缸筒端不会正好落在 A 的正下方/正前方）
      assert.ok(Math.abs(A.y - B.y) > 1 && Math.abs(A.x - B.x) > 1, `${m.id}/${tag}: 机架三角形退化`);
    }
  }
});

test('摇杆、连杆各是两铰点杆，且铲斗油缸活塞杆端与摇杆端共用 P 点', () => {
  for (const m of PRESETS) {
    const pose = computeMetrics(m).poses.maxDigHeight;
    const model = schematicModel(m, pose);
    const J = model.J;
    const rocker = model.links.find((l) => l.id === 'rocker');
    const link = model.links.find((l) => l.id === 'link');
    assert.equal(rocker.pts.length, 2, `${m.id}: 摇杆必须是两铰点杆`);
    assert.equal(link.pts.length, 2, `${m.id}: 连杆必须是两铰点杆`);

    const near = (a, b, what) => assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 1e-9, `${m.id}: ${what} 不重合`);
    near(rocker.pts[0], J.D, '摇杆一端与摇杆铰点 D');
    near(rocker.pts[1], J.P, '摇杆另一端与共用销轴 P');
    near(link.pts[0], J.P, '连杆一端与共用销轴 P');
    near(link.pts[1], J.E, '连杆另一端与连杆–铲斗铰点 E');
    const bktCyl = model.cylinders.find((c) => c.id === 'bucket');
    near(bktCyl.rod, J.P, '铲斗油缸活塞杆端与 P');
    // 摇杆长度、连杆长度与参数一致
    assert.ok(Math.abs(Math.hypot(J.P.x - J.D.x, J.P.y - J.D.y) - m.bktRockerLen) < 0.5, `${m.id}: 摇杆长度与参数不符`);
    assert.ok(Math.abs(Math.hypot(J.E.x - J.P.x, J.E.y - J.P.y) - m.bktLinkLen) < 0.5, `${m.id}: 连杆长度与参数不符`);
  }
});

test('附属铰点必须落在它所属构件的轮廓里（不能出现油缸悬空）', () => {
  for (const m of PRESETS) {
    for (const [tag, pose] of posesOf(m)) {
      const model = schematicModel(m, pose);
      const shape = Object.fromEntries(model.links.map((l) => [l.id, l.pts]));
      const J = model.J;
      const inside = (pt, id, what) =>
        assert.ok(insideOrOn(pt, shape[id]), `${m.id}/${tag}: ${what} 落在${id}轮廓外`);

      inside(J.boomRod, 'boom', '动臂油缸活塞杆端');
      inside(J.armBody, 'boom', '斗杆油缸缸筒端');
      inside(J.armRod, 'arm', '斗杆油缸活塞杆端');
      inside(J.bktBody, 'arm', '铲斗油缸缸筒端');
      inside(J.D, 'arm', '摇杆铰点 D');
      inside(J.E, 'bucket', '连杆–铲斗铰点 E');
    }
  }
});

test('动臂、斗杆的多边形在全部姿态下都不自交', () => {
  for (const m of PRESETS) {
    for (const [tag, pose] of posesOf(m)) {
      const model = schematicModel(m, pose);
      for (const id of ['boom', 'arm']) {
        const poly = model.links.find((l) => l.id === id).pts;
        assert.ok(polygonIsSimple(poly), `${m.id}/${tag}: ${id} 简图多边形自交`);
      }
    }
  }
});

test('简图符号：转动副 / 机架 / 移动副 / 杆件的数量与约定一致', () => {
  const m = PRESETS[0];
  const model = schematicModel(m, computeMetrics(m).poses.maxDigHeight);
  const pts = schematicPoints(model);
  const T = schematicTransform(pts, 900, 560);
  const svg = drawSchematic(model, T);
  const count = (re) => (svg.match(re) ?? []).length;

  // 11 个铰点：其中 P 是复合铰链，画 2 个圈 → 12 个转动副圆圈
  assert.equal(count(/data-sym="pin"/g), 12, '转动副圆圈数量不对');
  // 机架支座：动臂根部 + 动臂油缸缸筒端 合成一个直角三角形
  assert.equal(count(/data-sym="frame"/g), 1, '机架应当只画一个三角支座');
  assert.equal(count(/data-sym="cylinder"/g), 3, '移动副（液压缸）应当是 3 处');
  assert.equal(count(/data-sym="bar"/g), 2, '两铰点杆件应当只有摇杆与连杆');
  assert.equal(count(/data-sym="link"/g), 2, '多边形构件应当是动臂与斗杆');
  assert.equal(count(/data-sym="bucket"/g), 1, '铲斗三角形应当只有 1 个');
  const bucketPoly = svg.match(/data-sym="bucket" points="([^"]+)"/)?.[1] ?? '';
  assert.equal(bucketPoly.trim().split(/\s+/).length, 3, '铲斗应当由 3 个点连成三角形');
  const framePoly = svg.match(/data-sym="frame">\s*<polygon points="([^"]+)"/)?.[1] ?? '';
  const fp = framePoly
    .trim()
    .split(/\s+/)
    .map((s) => s.split(',').map(Number));
  assert.equal(fp.length, 3, '机架支座应当是三角形');
  // 屏幕上也要保持「直角边平行坐标轴」：一条边 x 相同、一条边 y 相同
  const sameX = fp.some((a, i) => fp.some((b, j) => j !== i && Math.abs(a[0] - b[0]) < 0.01));
  const sameY = fp.some((a, i) => fp.some((b, j) => j !== i && Math.abs(a[1] - b[1]) < 0.01));
  assert.ok(sameX && sameY, `机架三角形的直角边应平行坐标轴，实际 ${framePoly}`);
  for (const id of ['A', 'B', 'C', 'D', 'P', 'E']) {
    assert.ok(svg.includes(`data-joint="${id}"`), `缺少铰点编号 ${id}`);
  }
  assert.ok(!/NaN|undefined/.test(svg), '简图里出现了 NaN/undefined');
});

test('机构运动简图小图良构，并带图例', () => {
  for (const m of PRESETS) {
    const svg = renderSchematicFigure({ p: m, pose: computeMetrics(m).poses.maxDigHeight });
    assert.ok(svg.startsWith('<svg'), `${m.id}: 没有生成简图`);
    assert.equal(scanXmlWellFormed(svg).length, 0, `${m.id}: 简图不是良构 XML`);
    assert.ok(svg.includes('data-layer="legend"'), `${m.id}: 缺少符号图例`);
    assert.ok(svg.includes('转动副') && svg.includes('移动副'), `${m.id}: 图例里应说明转动副与移动副`);
    // 图例条必须画在视图下方，不能压到机器上（曾经压在铲斗上）
    const legendY = Number(svg.match(/data-layer="legend"[\s\S]*?y1="([\d.]+)"/)?.[1]);
    assert.ok(Number.isFinite(legendY) && legendY > Number(svg.match(/height="(\d+)"/)[1]) * 0.7, `${m.id}: 图例条位置太高，可能盖住机构`);
  }
});

test('主图切到机构运动简图后仍然良构，且包络与尺寸标注照旧', () => {
  for (const m of PRESETS) {
    const { values, poses } = computeMetrics(m);
    const svg = renderChart({
      W: 1000,
      H: 700,
      p: m,
      values,
      poses,
      env: computeEnvelope(m, { samples: 121 }),
      view: {
        style: 'schematic',
        showEnvelope: true,
        showDims: true,
        showBody: true,
        showInner: false,
        showTailCircle: true,
        poseMode: 'custom',
        customPose: {},
        dimKeys: ['groundMaxRadius', 'maxDigHeight', 'dumpHeight', 'maxDigDepth', 'verticalWallDepth', 'minSwingRadius'],
      },
      minSwingRadius: computeMinSwingRadius(m),
    });
    assert.equal(scanXmlWellFormed(svg).length, 0, `${m.id}: 简图模式主图不良构`);
    assert.ok(svg.includes('停机面最大挖掘半径'), `${m.id}: 简图模式下尺寸标注丢了`);
    assert.ok(svg.includes('机构运动简图符号'), `${m.id}: 简图模式下缺少图例`);
    assert.ok(svg.includes('data-sym="cylinder"'), `${m.id}: 简图模式下没有画液压缸`);
    assert.ok(!/NaN|undefined/.test(svg), `${m.id}: 简图模式下出现 NaN/undefined`);
  }
});

test('参数被改坏（解不出连杆）时简图返回 null，绘图退回实体外形', () => {
  const m = PRESETS[0];
  // 构件数量减到 0 附近：删掉连杆长度
  const broken = { ...m, bktLinkLen: 1 };
  const pose = computeMetrics(m).poses.maxDigHeight;
  const model = schematicModel(broken, pose);
  assert.equal(model, null, '连杆长度被改成 1 mm 时应当解不出来');
  const svg = renderChart({
    W: 800,
    H: 520,
    p: m,
    values: computeMetrics(m).values,
    poses: computeMetrics(m).poses,
    env: computeEnvelope(m, { samples: 61 }),
    view: {
      style: 'schematic',
      showEnvelope: true,
      showDims: false,
      showBody: false,
      showInner: false,
      showTailCircle: false,
      poseMode: 'none',
      customPose: {},
      dimKeys: [],
    },
    minSwingRadius: 0,
  });
  assert.equal(scanXmlWellFormed(svg).length, 0);
});
