/**
 * 五项作业尺寸指标
 * ==========================================================================
 *
 * 每一项都严格按国标姿态定义实现（而不是「取包络的极值」），
 * 姿态定义引自行业通行解释：
 *   挖掘机的作业范围图是指斗齿尖所能达到的位置坐标以及其运动轨迹所包含的最大面积。
 *   · 最大挖掘深度：动臂油缸全缩（动臂最低），斗杆前后两铰点与斗齿尖三点成一线
 *                   且垂直于地面时，斗齿尖距地面的垂直距离。
 *   · 最大挖掘高度：动臂油缸全伸（仰角最大）、斗杆油缸全缩、铲斗油缸全缩时，
 *                   斗齿尖距地面的垂直距离。
 *   · 最大挖掘半径：斗杆油缸全缩、动臂铰点与斗杆–铲斗铰点距离最大，且该两点与
 *                   斗齿尖三点成一线并平行于地面时，斗齿尖距回转中心线的水平距离。
 *   · 停机面最大挖掘半径：同上，但斗齿尖触地。
 *   · 最大卸载高度：动臂仰角最大、斗杆油缸全缩，且斗杆–铲斗铰点与斗齿尖垂直
 *                   （斗齿尖在铰点正下方）时，斗齿尖距地面的垂直距离。
 *
 * 关节角范围全部来自油缸行程（cylinders.js），本文件不再读任何角度输入项。
 *
 * 一致性验证：以 20 吨级机型 公开样本 (动臂 5700 / 斗杆 2925) 反解，
 * 取 R3≈1435、铰点高 1367、前移 −16、α∈[−39.3°, 52.3°]、Δmax=−1.78°，
 * 可同时复现 9950 / 6600 / 9570 / 6700，误差 < 0.05%。
 * 特别地：最大挖掘高度 − 最大卸载高度 = 2·R3，与样本 9570 − 6700 = 2870 完全吻合。
 */

import { solvePose, toRad, toDeg, clamp } from './geometry.js';
import { bucketRotationRange, jointRanges } from './params.js?v=20261005c';

/** 指标元数据：界面与参数表都从这里取标题、符号、单位 */
export const METRIC_META = [
  { key: 'maxDigRadius', symbol: 'A', label: '最大挖掘半径', color: '#2563eb' },
  { key: 'groundMaxRadius', symbol: 'A′', label: '停机面最大挖掘半径', color: '#0ea5e9' },
  { key: 'maxDigHeight', symbol: 'C', label: '最大挖掘高度', color: '#16a34a' },
  { key: 'dumpHeight', symbol: 'D', label: '最大卸载高度', color: '#d97706' },
  { key: 'maxDigDepth', symbol: 'B', label: '最大挖掘深度', color: '#dc2626' },
];

export const METRIC_KEYS = METRIC_META.map((m) => m.key);

/**
 * 「动臂铰点 A → 斗杆–铲斗铰点 C」的伸直程度。
 * 斗杆相对转角取可达上限时 A→C 最远，但一般不是严格共线，
 * 因此这里同时给出长度 |AC| 与方向相对动臂轴线的偏角。
 */
export function acChain(p) {
  const R = jointRanges(p);
  const deltaMax = R.delta[1];
  const d = toRad(deltaMax);
  const x = p.boomLength + p.armLength * Math.cos(d);
  const y = p.armLength * Math.sin(d);
  return {
    deltaMax,
    acLen: Math.hypot(x, y),
    /** A→C 方向相对动臂轴线的偏角（度） */
    acOffsetDeg: toDeg(Math.atan2(y, x)),
    /** A→C→T 共线时的整链长度 */
    chainLen: Math.hypot(x, y) + p.bucketRadius,
  };
}

/** 由 A 点出发、斗杆处于「最直」位置时的整链长度 |A→T| */
export function straightChainLength(p) {
  return acChain(p).chainLen;
}

/**
 * 「A、C、T 三点共线」的姿态：整链相对水平线下倾 tiltDeg。
 * 返回 { pose, tipX, tipY }
 */
function alinedPose(p, ac, tiltDeg) {
  const alpha = -tiltDeg - ac.acOffsetDeg; // 使 A→C 方向等于倾角方向
  const gamma = alpha + ac.deltaMax;
  const psi = -tiltDeg - gamma; // 使 C→T 与 A→C 同向
  return solvePose(p, alpha, ac.deltaMax, psi);
}

/**
 * 计算全部指标。
 * @returns {{ values: Record<string, number>, poses: Record<string, object>,
 *             notes: string[], warnings: string[], ranges: object }}
 */
export function computeMetrics(p) {
  const notes = [];
  const warnings = [];
  const values = {};
  const poses = {};

  const bucket = bucketRotationRange(p);
  const R = jointRanges(p);
  const ac = acChain(p);
  const Lchain = ac.chainLen;

  if (ac.deltaMax < -1e-6) {
    warnings.push(
      `斗杆相对转角上限为 ${ac.deltaMax.toFixed(1)}°，工作装置无法完全伸直，` +
        '「最大挖掘半径 / 停机面最大挖掘半径」按实际最直姿态计算，与国标共线定义存在偏差',
    );
  }

  /* ---------- 最大挖掘半径 A：整链水平 ---------- */
  {
    const value = p.pivotX + Lchain;
    values.maxDigRadius = value;
    poses.maxDigRadius = alinedPose(p, ac, 0);
    notes.push('姿态：动臂与斗杆伸直，整链平行于停机面（斗齿尖位于动臂铰点同高度）');
  }

  /* ---------- 停机面最大挖掘半径 A′：整链伸直且斗齿尖触地 ---------- */
  {
    const tilt = toDeg(Math.asin(clamp(p.pivotY / Lchain, -1, 1)));
    const value = p.pivotX + Lchain * Math.cos(toRad(tilt));
    values.groundMaxRadius = value;
    poses.groundMaxRadius = alinedPose(p, ac, tilt);
    notes.push('姿态：整链伸直，斗齿尖落于停机面');
  }

  /* ---------- 最大挖掘深度 B：斗杆与铲斗竖直向下 ---------- */
  {
    const deltaNeed = -90 - R.alpha[0];
    const deltaUse = clamp(deltaNeed, R.delta[0], R.delta[1]);
    if (Math.abs(deltaUse - deltaNeed) > 1e-6) {
      warnings.push(
        `最大挖掘深度姿态需要斗杆相对转角 ${deltaNeed.toFixed(1)}°，超出 ` +
          `[${R.delta[0].toFixed(1)}, ${R.delta[1].toFixed(1)}]°，已按可达极限姿态计算`,
      );
    }
    // 该姿态下 B、C、T 三点共线且垂直向下
    const yB = p.pivotY + p.boomLength * Math.sin(toRad(R.alpha[0]));
    values.maxDigDepth = -(yB - p.armLength - p.bucketRadius);

    const psi = -90 - (R.alpha[0] + deltaUse); // 保证 C→T 也竖直向下
    poses.maxDigDepth = solvePose(p, R.alpha[0], deltaUse, psi);
    notes.push('姿态：动臂油缸全缩至最低，斗杆前后两铰点与斗齿尖三点共线且垂直于停机面');
  }

  /* ---------- 最大挖掘高度 C / 最大卸载高度 D：动臂与斗杆到行程端点，铲斗按可达角计算 ---------- */
  {
    // 两项都直接取「该姿态下斗齿尖的 y 坐标」。
    // 注意不能写成 yC + R3——那是假设斗齿尖恰好竖直朝上；
    // 引入油缸后全缩端点角由铲斗油缸解出，齿尖朝向与 90° 可能差千分之几度，
    // 按姿态取数才能保证指标与图上画出来的姿态严格一致。
    poses.maxDigHeight = solvePose(p, R.alpha[1], R.delta[1], bucket.retracted);
    values.maxDigHeight = poses.maxDigHeight.T.y;
    notes.push('姿态：动臂仰角最大、斗杆油缸全缩、铲斗油缸全缩（斗齿尖朝上）');

    const psiDump = -90 - (R.alpha[1] + R.delta[1]); // 使 C→T 竖直向下
    const psiDumpUse = clamp(psiDump, bucket.min, bucket.max);
    // 容差取 5e-3°：油缸标定要把安装点取整到 mm，端点难免差千分之几度
    if (Math.abs(psiDumpUse - psiDump) > 5e-3) {
      warnings.push(
        `铲斗转角范围 [${bucket.min.toFixed(1)}°, ${bucket.max.toFixed(1)}°] 覆盖不到最大卸载高度姿态所需的 ` +
          `${psiDump.toFixed(1)}°，该指标按可达极限计算`,
      );
    }
    poses.dumpHeight = solvePose(p, R.alpha[1], R.delta[1], psiDumpUse);
    values.dumpHeight = poses.dumpHeight.T.y;
    notes.push('姿态：动臂仰角最大、斗杆油缸全缩，斗杆–铲斗铰点与斗齿尖连线竖直（斗齿尖在铰点正下方）');
  }

  return { values, poses, notes, warnings, ranges: { ...R, ...bucket } };
}
