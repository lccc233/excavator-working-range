/**
 * 分享链接编解码测试
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { encodeParams, decodeParams, buildShareUrl, matchPreset, SHORT_KEYS, LONG_KEYS } from '../assets/core/share.js';
import { PRESETS, clonePreset, defaultParams } from '../assets/core/presets.js';
import { PARAM_SPEC } from '../assets/core/params.js';

test('短键映射是双射且覆盖全部参数', () => {
  for (const spec of PARAM_SPEC) {
    assert.ok(SHORT_KEYS[spec.key], `参数 ${spec.key} 缺少短键`);
    assert.equal(LONG_KEYS[SHORT_KEYS[spec.key]], spec.key);
  }
  const shorts = Object.values(SHORT_KEYS);
  assert.equal(new Set(shorts).size, shorts.length, '短键存在重复');
});

test('未改动的预设编码后只含机型标识', () => {
  const q = encodeParams(clonePreset('x20t'));
  assert.equal(q, 'm=x20t');
});

test('改动单项后只写出该项', () => {
  const p = clonePreset('x20t');
  p.boomLength = 6200;
  const q = encodeParams(p);
  assert.equal(q, 'm=x20t&bl=6200');
});

test('全部预设编码→解码往返一致', () => {
  for (const m of PRESETS) {
    const p = clonePreset(m.id);
    const back = decodeParams(encodeParams(p));
    for (const spec of PARAM_SPEC) {
      assert.ok(
        Math.abs(back[spec.key] - p[spec.key]) < 0.011,
        `${m.id}.${spec.key}: ${back[spec.key]} vs ${p[spec.key]}`,
      );
    }
    assert.equal(back.id, m.id);
  }
});

test('随机改动后的往返一致', () => {
  const rnd = mulberry32(20240607);
  for (let iter = 0; iter < 60; iter++) {
    const p = clonePreset(PRESETS[Math.floor(rnd() * PRESETS.length)].id);
    for (const spec of PARAM_SPEC) {
      p[spec.key] = spec.min + rnd() * (spec.max - spec.min);
    }
    const back = decodeParams(encodeParams(p));
    for (const spec of PARAM_SPEC) {
      const tol = spec.kind === 'angle' ? 0.011 : spec.kind === 'number' ? 0.011 : 0.51;
      assert.ok(
        Math.abs(back[spec.key] - p[spec.key]) < tol,
        `迭代 ${iter} ${spec.key}: ${back[spec.key]} vs ${p[spec.key]}`,
      );
    }
  }
});

test('decodeParams 容忍前导 ? 与 #', () => {
  for (const q of ['?m=x20t&bl=6000', '#m=x20t&bl=6000', 'm=x20t&bl=6000']) {
    const p = decodeParams(q);
    assert.equal(p.boomLength, 6000);
    assert.equal(p.id, 'x20t');
  }
});

test('decodeParams 处理空串与垃圾输入', () => {
  for (const q of ['', '?', '#', '???', '&=&=', 'xyz', 'm=', 'm=nope']) {
    const p = decodeParams(q);
    assert.ok(Number.isFinite(p.boomLength), `输入 ${JSON.stringify(q)} 未回落到有效参数`);
    assert.ok(Number.isFinite(p.armLength));
    assert.ok(Number.isFinite(p.pivotY));
  }
});

test('超范围数值被收敛到规范区间', () => {
  const spec = PARAM_SPEC.find((s) => s.key === 'boomLength');
  const p = decodeParams(`m=x20t&bl=${spec.max + 99999}`);
  assert.equal(p.boomLength, spec.max);
  const p2 = decodeParams(`m=x20t&bl=${spec.min - 99999}`);
  assert.equal(p2.boomLength, spec.min);
});

test('非数值字段被忽略而不是变成 NaN', () => {
  const p = decodeParams('m=x20t&bl=abc&al=&py=NaN');
  assert.equal(p.boomLength, 5700);
  assert.equal(p.armLength, 2925);
  assert.equal(p.pivotY, 1367);
});

test('未知机型回落到默认机型但仍接受覆盖值', () => {
  const p = decodeParams('m=unknown-model&bl=4321');
  assert.equal(p.boomLength, 4321);
  assert.equal(p.id, 'custom');
  assert.ok(Number.isFinite(p.armLength));
});

test('无机型标识时使用传入的基底', () => {
  const base = clonePreset('x20t');
  const p = decodeParams('bl=6000', base);
  assert.equal(p.boomLength, 6000);
  assert.equal(p.armLength, base.armLength);
  assert.equal(p.pivotY, base.pivotY);
});

test('matchPreset 能识别未改动的预设，改动后返回 null', () => {
  for (const m of PRESETS) {
    assert.equal(matchPreset(clonePreset(m.id)), m.id);
  }
  const p = clonePreset('x20t');
  p.boomLength += 100;
  assert.equal(matchPreset(p), null);
});

test('buildShareUrl 产出可被 decodeParams 解析的完整链接', () => {
  const p = clonePreset('x20t');
  p.armLength = 2750;
  const url = buildShareUrl(p, 'https://example.com/');
  assert.ok(url.startsWith('https://example.com/?'), url);
  const back = decodeParams(url.slice(url.indexOf('?')));
  assert.equal(back.armLength, 2750);
  assert.equal(back.id, 'x20t');
  assert.equal(back.boomLength, p.boomLength);
});

test('encodeParams --all 写出全部字段', () => {
  const q = encodeParams(clonePreset('x20t'), { all: true });
  const count = q.split('&').length;
  assert.equal(count, PARAM_SPEC.length + 1, `应写出 1 个机型标识 + ${PARAM_SPEC.length} 个字段`);
  const back = decodeParams(q);
  assert.equal(back.id, 'x20t');
});

test('自定义机型名称可往返', () => {
  const p = defaultParams();
  p.name = '客户A-加长臂';
  p.boomLength = 6800;
  const back = decodeParams(encodeParams(p));
  assert.equal(back.name, '客户A-加长臂');
  assert.equal(back.boomLength, 6800);
});

/** 可复现的伪随机数（避免测试抖动） */
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
