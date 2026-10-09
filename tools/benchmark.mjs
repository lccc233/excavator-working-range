#!/usr/bin/env node
/**
 * 最小回转半径性能基线（零依赖）。
 * 首次调用包含关节角反解与斗形支撑值预计算；预热后统计 31 次独立网格求解，
 * 不缓存最终半径、不放宽 25×25 网格。耗时与机器及运行时有关，不作为数值正确性断言。
 *
 *   node tools/benchmark.mjs
 *   node tools/benchmark.mjs --json
 */
import { PRESETS } from '../assets/core/presets.js';
import { computeMinSwingRadius } from '../assets/core/envelope.js';

const results = PRESETS.map((p) => {
  const start = performance.now();
  const radiusMm = computeMinSwingRadius(p);
  const firstMs = performance.now() - start;
  for (let i = 0; i < 5; i++) computeMinSwingRadius(p);
  const times = [];
  for (let i = 0; i < 31; i++) {
    const t0 = performance.now();
    computeMinSwingRadius(p);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return { id: p.id, samples: 25, radiusMm, firstMs, medianMs: times[15], p95Ms: times[29] };
});

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ runtime: process.version, iterations: 31, results }, null, 2));
} else {
  console.log(`最小回转半径 · ${process.version} · 25×25 网格 · 预热后 31 次独立计算`);
  console.table(results.map((r) => ({
    机型: r.id,
    '半径 mm': r.radiusMm.toFixed(3),
    '首次 ms': r.firstMs.toFixed(3),
    '中位 ms': r.medianMs.toFixed(3),
    'P95 ms': r.p95Ms.toFixed(3),
  })));
}
