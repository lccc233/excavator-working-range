/**
 * 图表绘制测试
 * ==========================================================================
 * 这里最关键的一条是 SVG 的「良构性」检查。
 * 曾经踩过的坑：某个 <text> 标签被写成 fill="#94a3b8'>（把收尾的双引号敲成了单引号），
 * 浏览器容错渲染看不出来，但导出 SVG / 转 PNG 时会因为 XML 解析失败而整张图丢掉。
 * 因此用下面这个逐字符扫描器替代格式良好的 XML 解析器（Node 无内置 XML 解析），
 * 专门盯住「引号没配平就遇到 >」这种情况。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { PRESETS } from '../assets/core/presets.js';
import { computeMetrics } from '../assets/core/metrics.js';
import { computeEnvelope, computeMinSwingRadius } from '../assets/core/envelope.js';
import { renderChart, resolvePose, cylinderMounts } from '../assets/ui/draw.js';
import { renderSpecTables, renderPrintHeader } from '../assets/ui/chart-table.js';
import { bucketLocalShape, bucketPolygon, toRad, armHeelAlong } from '../assets/core/geometry.js';
import { cylinderPose, resolveJointRanges, clearRangeCache } from '../assets/core/cylinders.js';
import { solvePose } from '../assets/core/geometry.js';

/** 点是否在凸/凹多边形内（射线法），坐标需与多边形同一坐标系 */
function pointInPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** 点到多边形各边的最近距离 */
function distToPolygon(pt, poly) {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j];
    const b = poly[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / l2)) : 0;
    const d = Math.hypot(pt.x - (a.x + dx * t), pt.y - (a.y + dy * t));
    if (d < best) best = d;
  }
  return best;
}

/**
 * 点在轮廓内、或恰好压在轮廓边界上。
 * 射线法对边界点的判定是不确定的，而新斗形（切掉一部分的半圆）里
 * 「连杆–铲斗铰点 E」正是切除线的端点、必落在边界上，所以补一条距离判据。
 */
function pointInOrOnPolygon(pt, poly, eps = 1e-6) {
  return pointInPolygon(pt, poly) || distToPolygon(pt, poly) <= eps;
}

test('图上的「连杆–铲斗铰点」必须落在斗体轮廓内或压在轮廓边界上（否则连杆看起来没接上）', () => {
  // 这条是用户报的显示问题：连杆销画在斗体外，连杆末端悬空。
  // 斗形改成「切掉一部分的半圆」后，E 按定义就是切除线的端点（落在圆弧上），
  // 因此判据从「严格在内部」放宽为「在内部或落在边界上」；仍不允许落在轮廓之外。
  // 判据放在铲斗局部坐标系（单位 R3）里，所以对所有机型、所有姿态都成立。
  for (const m of PRESETS) {
    const shape = bucketLocalShape(m).map(([x, y]) => ({ x, y }));
    clearRangeCache();
    const R = resolveJointRanges(m);
    const cases = [];
    for (const alpha of [R.alphaMin, (R.alphaMin + R.alphaMax) / 2, R.alphaMax]) {
      for (const delta of [R.deltaMin, -60, R.deltaMax]) {
        for (const psi of [R.psiMin, -50, 0, R.psiMax]) {
          cases.push(solvePose(m, alpha, delta, psi));
        }
      }
    }
    for (const pose of cases) {
      const c = cylinderPose(m, pose);
      assert.ok(c?.link?.to, `${m.id}: 姿态解不出连杆端点`);
      const abs = toRad(pose.bucketAbsDeg);
      const dx = c.link.to.x - pose.C.x;
      const dy = c.link.to.y - pose.C.y;
      const local = {
        x: (dx * Math.cos(abs) + dy * Math.sin(abs)) / m.bucketRadius,
        y: (-dx * Math.sin(abs) + dy * Math.cos(abs)) / m.bucketRadius,
      };
      assert.ok(
        pointInOrOnPolygon(local, shape),
        `${m.id} α=${pose.alphaDeg.toFixed(1)} Δ=${pose.deltaDeg.toFixed(1)} ψ=${pose.psiDeg.toFixed(1)}：` +
          `连杆销局部(${local.x.toFixed(2)}, ${local.y.toFixed(2)}) 落在斗体轮廓外`,
      );
    }
    // 顺带确认斗齿尖方向仍与轮廓一致（+x 端）
    const poly = bucketPolygon({ x: 0, y: 0 }, 0, m.bucketRadius, bucketLocalShape(m)).map((q) => ({
      x: q.x / m.bucketRadius,
      y: q.y / m.bucketRadius,
    }));
    assert.ok(pointInOrOnPolygon({ x: 0.9, y: 0 }, poly), `${m.id}: 斗体轮廓未覆盖到斗齿尖一侧`);
  }
});

/**
 * 油缸的缸筒端 / 活塞杆端必须通过支座连到「它真正安装的那根杆件」上：
 *   斗杆油缸缸筒端 → 动臂上表面；铲斗油缸缸筒端 → 斗杆上表面。
 * 判据分两层：几何上支座顶点必须落在销轴上、底边必须贴在所属杆件表面高度上；
 * 渲染上这四块支座必须真的出现在实体外形图里。
 */
test('油缸端支座把销轴连到所属杆件上（缸筒端贴动臂/斗杆上表面）', () => {
  for (const m of PRESETS) {
    const { poses } = computeMetrics(m);
    for (const mode of ['custom', 'maxDigHeight', 'dumpHeight', 'maxDigDepth', 'groundMaxRadius']) {
      const pose = resolvePose(m, { poseMode: mode, customPose: {} }, poses);
      const c = cylinderPose(m, pose);
      const mt = cylinderMounts(m, pose);
      const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
      const tag = `${m.id}/${mode}`;

      // ① 支座顶点 = 解出来的销轴（支座和油缸端点在图上必须重合）
      assert.ok(dist(mt.boomRod.pin, c.boom.rod) < 1e-9, `${tag}: 动臂油缸活塞杆端支座顶点应落在杆端销轴上`);
      assert.ok(dist(mt.armBody.pin, c.arm.body) < 1e-9, `${tag}: 斗杆油缸缸筒端支座顶点应落在缸筒端销轴上`);
      assert.ok(dist(mt.armRod.pin, c.arm.rod) < 1e-9, `${tag}: 斗杆油缸活塞杆端支座顶点应落在杆端销轴上`);
      assert.ok(dist(mt.bktBody.pin, c.bucket.body) < 1e-9, `${tag}: 铲斗油缸缸筒端支座顶点应落在缸筒端销轴上`);

      // ② 两条缸筒端的销轴都挑在杆件表面之外 → 必须有支座，否则图上悬空
      assert.ok(mt.armBody.needed, `${tag}: 斗杆油缸缸筒端挑出动臂表面，需要支座连到动臂上`);
      assert.ok(mt.bktBody.needed, `${tag}: 铲斗油缸缸筒端挑出斗杆表面，需要支座连到斗杆上`);

      // ③ 斗杆上的支座底边贴在斗杆表面上：到「B→C 轴线」的距离正好是 0.9×半宽，
      //    且比销轴更靠近轴线（底边在表面、顶点在销轴，构成一块筋板）
      const u = { x: Math.cos(toRad(pose.armAbsDeg)), y: Math.sin(toRad(pose.armAbsDeg)) };
      const axisDist = (q) => Math.abs((q.x - pose.B.x) * u.y - (q.y - pose.B.y) * u.x);
      for (const key of ['armRod', 'bktBody']) {
        const mo = mt[key];
        for (const b of [mo.base1, mo.base2]) {
          assert.ok(
            Math.abs(axisDist(b) - mo.halfW * 0.9) < 1e-9,
            `${tag}/${key}: 支座底边应贴在斗杆表面（离轴线 ${mo.halfW * 0.9} mm）`,
          );
          assert.ok(axisDist(b) < axisDist(mo.pin), `${tag}/${key}: 底边应比销轴更靠近杆件轴线`);
        }
      }

      // ④ 底边沿杆方向不得探出杆件轮廓：斗杆根部有「后跟」（armHeelAlong），
      //    动臂两端是 A 与 B，筋板底边必须落在这两段范围内
      const along = (q, O, rad) => (q.x - O.x) * Math.cos(toRad(rad)) + (q.y - O.y) * Math.sin(toRad(rad));
      for (const key of ['armRod', 'bktBody']) {
        for (const b of [mt[key].base1, mt[key].base2]) {
          const a = along(b, pose.B, pose.armAbsDeg);
          assert.ok(
            a >= armHeelAlong(m) - 1e-6 && a <= m.armLength + 1e-6,
            `${tag}/${key}: 支座底边沿杆坐标 ${a.toFixed(1)} mm 探出了斗杆轮廓 [${armHeelAlong(m).toFixed(1)}, ${m.armLength}]`,
          );
        }
      }
      for (const key of ['boomRod', 'armBody']) {
        for (const b of [mt[key].base1, mt[key].base2]) {
          const a = along(b, pose.A, pose.alphaDeg);
          assert.ok(
            a >= -1e-6 && a <= m.boomLength + 1e-6,
            `${tag}/${key}: 支座底边沿杆坐标 ${a.toFixed(1)} mm 探出了动臂轮廓 [0, ${m.boomLength}]`,
          );
        }
      }
    }

    // ⑤ 渲染结果里四块支座都要画出来（实体外形图）
    const svg = renderFor(m);
    for (const key of ['boomRod', 'armBody', 'armRod', 'bktBody']) {
      assert.ok(svg.includes(`data-mount="${key}"`), `${m.id}: 实体外形图里缺少 ${key} 支座`);
    }
  }
});

/**
 * 极简 XML 良构性扫描：逐个字符走，跟踪标签内/外的引号状态。
 * @returns {string[]} 问题描述列表（空表示通过）
 */
export function scanXmlWellFormed(src) {
  const problems = [];
  let i = 0;
  let depth = 0;
  const stack = [];
  while (i < src.length) {
    const ch = src[i];
    if (ch !== '<') {
      i++;
      continue;
    }
    // 注释 / 声明 / CDATA / DOCTYPE
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i);
      if (end < 0) { problems.push(`位置 ${i}: 注释未闭合`); break; }
      i = end + 3;
      continue;
    }
    if (src.startsWith('<?', i)) {
      const end = src.indexOf('?>', i);
      if (end < 0) { problems.push(`位置 ${i}: 处理指令未闭合`); break; }
      i = end + 2;
      continue;
    }
    // 标签：逐字符扫描，遇到引号就跳到配对引号
    let j = i + 1;
    let quote = null;
    let closed = -1;
    while (j < src.length) {
      const c = src[j];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '>') {
        closed = j;
        break;
      }
      j++;
    }
    if (closed < 0) {
      problems.push(`位置 ${i}: 标签在引号未配平的情况下没有结束（${JSON.stringify(src.slice(i, i + 110))}）`);
      break;
    }
    const inner = src.slice(i + 1, closed).trim();
    if (inner.startsWith('/')) {
      const name = inner.slice(1).trim().split(/[\s/]/)[0];
      const top = stack.pop();
      if (top !== name) problems.push(`位置 ${i}: 闭合标签 </${name}> 与 <${top}> 不匹配`);
      depth--;
    } else if (!inner.endsWith('/')) {
      const name = inner.split(/[\s/]/)[0];
      stack.push(name);
      depth++;
    }
    i = closed + 1;
  }
  if (stack.length) problems.push(`仍有 ${stack.length} 个标签未闭合：${stack.slice(0, 5).join(', ')}`);
  return problems;
}

function renderFor(preset, overrides = {}) {
  const { values, poses } = computeMetrics(preset);
  const env = computeEnvelope(preset, { samples: 121 });
  const minSwingRadius = computeMinSwingRadius(preset);
  return renderChart({
    W: 1000,
    H: 700,
    p: preset,
    values,
    poses,
    env,
    view: {
      showEnvelope: true,
      showDims: true,
      showBody: true,
      showInner: true,
      showTailCircle: true,
      poseMode: 'custom',
      customPose: {},
      dimKeys: [
        'groundMaxRadius',
        'maxDigHeight',
        'dumpHeight',
        'maxDigDepth',
        'minSwingRadius',
        'maxDigRadius',
      ],
      ...overrides,
    },
    minSwingRadius,
  });
}

test('scanXmlWellFormed 能抓住引号不配平的标签', () => {
  assert.deepEqual(scanXmlWellFormed('<a b="1"></a>'), []);
  const bad = scanXmlWellFormed('<a b="#123\'>text</a>');
  assert.ok(bad.length > 0, '应当报出引号问题');
  assert.ok(bad[0].includes('引号未配平'), bad[0]);
});

test('scanXmlWellFormed 能抓住标签不闭合', () => {
  const bad = scanXmlWellFormed('<a><b></a>');
  assert.ok(bad.some((p) => p.includes('不匹配')), bad.join('; '));
  const bad2 = scanXmlWellFormed('<a><b/></a>');
  assert.deepEqual(bad2, []);
});

test('每个机型渲染出的 SVG 都是良构 XML', () => {
  for (const m of PRESETS) {
    const problems = scanXmlWellFormed(renderFor(m));
    assert.equal(problems.length, 0, `${m.id}: ${problems.join(' | ')}`);
  }
});

test('各种姿态模式下渲染出的 SVG 都是良构 XML', () => {
  for (const mode of ['custom', 'maxDigHeight', 'dumpHeight', 'maxDigDepth', 'groundMaxRadius', 'none']) {
    for (const m of PRESETS) {
      const problems = scanXmlWellFormed(renderFor(m, { poseMode: mode }));
      assert.equal(problems.length, 0, `${m.id}/${mode}: ${problems.join(' | ')}`);
    }
  }
});

test('关闭各图层的组合也保持良构', () => {
  const m = PRESETS[0];
  const combos = [
    { showEnvelope: false },
    { showDims: false },
    { showBody: false },
    { showInner: false, showTailCircle: false },
    { showEnvelope: false, showDims: false, showBody: false, poseMode: 'none' },
  ];
  for (const c of combos) {
    const problems = scanXmlWellFormed(renderFor(m, c));
    assert.equal(problems.length, 0, `${JSON.stringify(c)}: ${problems.join(' | ')}`);
  }
});

test('SVG 中不含 NaN / undefined / Infinity', () => {
  for (const m of PRESETS) {
    const svg = renderFor(m);
    const hit = svg.match(/.{0,50}(NaN|undefined|Infinity).{0,30}/);
    assert.ok(!hit, `${m.id}: ${hit?.[0]}`);
  }
});

test('图上尺寸标注的数值与计算结果一致', () => {
  for (const m of PRESETS) {
    const { values } = computeMetrics(m);
    const svg = renderFor(m);
    const mm = (v) => Math.round(v).toLocaleString('en-US');
    for (const [key, label] of [
      ['maxDigHeight', '最大挖掘高度'],
      ['dumpHeight', '最大卸载高度'],
      ['maxDigDepth', '最大挖掘深度'],
      ['groundMaxRadius', '停机面最大挖掘半径'],
    ]) {
      assert.ok(svg.includes(label), `${m.id}: 缺少标注「${label}」`);
      assert.ok(
        svg.includes(mm(values[key])),
        `${m.id}: 标注「${label}」应显示 ${mm(values[key])}`,
      );
    }
  }
});

test('不同画布尺寸下都能渲染且良构', () => {
  const m = PRESETS[0];
  const { values, poses } = computeMetrics(m);
  const env = computeEnvelope(m, { samples: 121 });
  for (const [W, H] of [[420, 300], [1000, 700], [2400, 1400]]) {
    const svg = renderChart({
      W,
      H,
      p: m,
      values,
      poses,
      env,
      view: {
        showEnvelope: true,
        showDims: true,
        showBody: true,
        showInner: false,
        showTailCircle: true,
        poseMode: 'custom',
        customPose: {},
        dimKeys: ['groundMaxRadius', 'maxDigHeight', 'dumpHeight', 'maxDigDepth', 'minSwingRadius'],
      },
      minSwingRadius: computeMinSwingRadius(m),
    });
    assert.equal(scanXmlWellFormed(svg).length, 0, `${W}x${H} 不良构`);
  }
});

test('resolvePose 在无自定义姿态时返回有限坐标', () => {
  for (const m of PRESETS) {
    const { poses } = computeMetrics(m);
    for (const mode of ['custom', 'none', 'maxDigDepth']) {
      const pose = resolvePose(m, { poseMode: mode, customPose: {} }, poses);
      if (mode === 'none') {
        assert.equal(pose, null);
        continue;
      }
      for (const k of ['A', 'B', 'C', 'T']) {
        assert.ok(Number.isFinite(pose[k].x) && Number.isFinite(pose[k].y), `${m.id}/${mode} ${k}`);
      }
    }
  }
});

test('参数表与打印页眉良构且不含 NaN', () => {
  for (const m of PRESETS) {
    const { values, poses } = computeMetrics(m);
    const all = { ...values, minSwingRadius: computeMinSwingRadius(m) };
    const t = renderSpecTables(m, all, poses, { showNominal: true });
    for (const key of ['sizeTable', 'geomTable', 'derivedTable', 'poseTable', 'html']) {
      assert.ok(typeof t[key] === 'string' && t[key].length > 0, `${m.id}: ${key} 为空`);
      assert.ok(!/NaN|undefined/.test(t[key]), `${m.id}: ${key} 含 NaN/undefined`);
    }
    assert.ok(t.html.includes('派生量'), `${m.id}: 缺少派生关节角表`);
    const header = renderPrintHeader(m);
    assert.ok(!/NaN|undefined/.test(header), `${m.id}: 页眉含 NaN/undefined`);
  }
});
