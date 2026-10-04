/**
 * 机型预设库
 * ==========================================================================
 *
 * 每个机型的「几何参数」都是用 tools/fit-preset.mjs 从厂家公开样本的作业范围
 * 指标反解标定出来的——样本只给指标，不给铰点高度和关节角范围。
 * 而油缸安装位置、安装距、行程、铲斗连杆尺寸样本一律不公开，
 * 因此这些由 tools/setup-cylinders.mjs 按机型尺度构造并反算：
 * 让解出的关节角范围与标定好的角度逐一对应，这样预设仍能精确复现样本指标。
 * ⚠️ 油缸与连杆数据是「可替换的示例值」——拿到真机图纸后直接覆盖即可。
 *
 * 油缸布置口径（与界面输入、cylinders.js 完全一致）
 * --------------------------------------------------------------------------
 *   · 动臂油缸缸筒端：相对动臂根部铰点 A 的 (ΔX, ΔY)，ΔX > 0（装在转台前部）、
 *     ΔY < 0（在 A 下方）；活塞杆端在动臂中段下表面。
 *   · 斗杆油缸缸筒端：动臂坐标系，位于动臂上表面；
 *     活塞杆端：斗杆坐标系，位于 B 点后方、斗杆上平面（沿斗杆为负、垂直斗杆为正）。
 *     这样布置下「油缸伸出 = 斗杆收拢（挖掘方向）」，且油缸轴线全程不进入动臂本体。
 *   · 铲斗连杆机构：摇杆与连杆都是「两铰点杆」——
 *     摇杆一端铰在斗杆的 D 点，另一端 P 与铲斗油缸活塞杆、连杆共用一个销轴；
 *     连杆另一端铰在铲斗背板的 E 点（斗杆–摇杆–连杆–铲斗四连杆）。
 *     铲斗油缸全缩 = 收斗位、全伸 = 卸料位。
 *   以上每一条都由 verifyCylinderLayout() 逐项自检，并由 tests/cylinders.test.js 守住。
 *
 * `nominal`   厂家标称值，仅用于对标校验与参数表参考列，不参与几何计算。
 * `calibration` 标定得到的关节角目标值，作为文档保留，并由油缸标定工具读取。
 *
 * 标定数据来源（某主机厂 20 吨级机型的公开产品样本，已逐条核对原文）：
 *   · 某 20 吨级挖掘机 —— 动臂 5700、斗杆 2925、斗容 0.93 m³
 *     停机面最大挖掘半径 9950、最大挖掘深度 6600、最大挖掘高度 9570、
 *     最大卸载高度 6700、最大垂直挖掘深度 5800、最小回转半径 3730
 *
 * 标定结果（tools/calibrate.mjs 输出）：全部标称项偏差 < 0.07%。
 */

/** 某 20 吨级挖掘机的油缸/连杆块，同时作为自定义机型的默认值 */
const BASE_CYL = {
  // 动臂油缸
  boomCylBodyDX: 171,
  boomCylBodyDY: -467,
  boomCylRodAlong: 2964,
  // ⚠️ 活塞杆端垂直动臂的滑块区间是 −1000 ~ +1000（params.js），预设值必须落在区间内。
  //    这里取 −1000（区间下界，与原来标定的 −1198 最接近）：这个值同时决定动臂油缸的
  //    「杠杆比」——取到 −800 以上（更靠近动臂轴线）时，油缸与动臂近乎共线，行程稍变
  //    仰角就狂涨（行程 ×1.5 会转到 120° 以上，挖掘高度反而下降），真机不会这么装。
  //    改这个值会改变油缸安装几何，安装距/行程要一起重标定（calibrateCylinders 按标定角反算），
  //    否则关节角范围与样本指标会跟着漂。
  boomCylRodPerp: -1000,
  boomCylClosed: 2643.7,
  boomCylStroke: 636.8,

  // 斗杆油缸
  armCylBodyAlong: -2992,
  armCylBodyPerp: 627,
  armCylRodAlong: -702,
  armCylRodPerp: 322,
  armCylClosed: 2317.7,
  armCylStroke: 1445.3,

  // 铲斗油缸（缸筒端在斗杆上方，活塞杆端与摇杆端、连杆端共用销轴 P）
  bktCylBodyAlong: -2691,
  bktCylBodyPerp: 410,
  bktCylClosed: 1343.7,
  bktCylStroke: 1187.6,

  // 铲斗四连杆：摇杆（D→P，两铰点杆）+ 连杆（P→E，两铰点杆）
  bktBellAlong: -732,
  bktBellPerp: 76,
  bktRockerLen: 665,
  bktEAlong: -28,
  bktEPerp: 553,
  bktLinkLen: 981,
  bktBranch: 1,
};

/** 通用默认值（新建自定义机型时使用） */
export const BASE_DEFAULTS = {
  id: 'custom',
  name: '自定义机型',
  boomLength: 5700,
  armLength: 2925,
  bucketRadius: 1435,
  bucketCapacity: 0.93,
  boomBend: 300,
  bucketBottomAngle: 63.74,
  pivotX: -16,
  pivotY: 1367,
  tailSwingRadius: 2890,
  trackLength: 4450,
  trackWidth: 2980,
  trackHeight: 940,
  groundClearance: 440,
  cabHeight: 2710,
  platformFront: 1200,
  boomWidth: 520,
  armWidth: 340,
  ...BASE_CYL,
  nominal: {},
  calibration: { boomAngleMin: -39.26, boomAngleMax: 52.3, armRelMin: -140.5, armRelMax: -1.78 },
};

export const PRESETS = [
  {
    id: 'x20t',
    name: '某 20 吨级挖掘机',
    boomLength: 5700,
    armLength: 2925,
    bucketRadius: 1435,
    bucketCapacity: 0.93,
    boomBend: 300,
    bucketBottomAngle: 63.74,
    pivotX: -16,
    pivotY: 1367,
    tailSwingRadius: 2890,
    trackLength: 4450,
    trackWidth: 2980,
    trackHeight: 940,
    groundClearance: 440,
    cabHeight: 2710,
    platformFront: 1200,
    boomWidth: 520,
    armWidth: 340,
    ...BASE_CYL,
    nominal: {
      groundMaxRadius: 9950,
      maxDigDepth: 6600,
      maxDigHeight: 9570,
      dumpHeight: 6700,
      verticalWallDepth: 5800,
      minSwingRadius: 3730,
    },
    calibration: { boomAngleMin: -39.26, boomAngleMax: 52.3, armRelMin: -140.5, armRelMax: -1.78 },
  },
];

export const PRESET_IDS = PRESETS.map((m) => m.id);

export function getPreset(id) {
  return PRESETS.find((m) => m.id === id) ?? null;
}

/** 复制一份预设（避免调用方误改常量） */
export function clonePreset(id) {
  const found = getPreset(id) ?? PRESETS[0];
  return {
    ...found,
    nominal: { ...(found.nominal ?? {}) },
    calibration: { ...(found.calibration ?? {}) },
  };
}

/** 由 BASE_DEFAULTS 造一个干净的默认机型 */
export function defaultParams() {
  return { ...BASE_DEFAULTS, nominal: {}, calibration: { ...BASE_DEFAULTS.calibration } };
}
