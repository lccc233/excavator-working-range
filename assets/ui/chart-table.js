/**
 * 参数表生成
 * ==========================================================================
 * 输出两段可打印的 HTML：
 *   · 作业尺寸表 —— 计算值 / 厂家标称值 / 偏差，偏差超 5% 标红
 *   · 几何参数表 —— 当前全部输入参数
 * 既用于页面下方的"参数表"页签，也用于打印 PDF 的第二页。
 */

import { PARAM_SPEC, PARAM_GROUPS, bucketRotationRange, jointRanges } from '../core/params.js?v=20261005b';
import { boomCylBodyPoint, armRodPerpSpan, verifyCylinderLayout } from '../core/cylinders.js';
import { METRIC_META } from '../core/metrics.js';

const mm = (v) => Math.round(v).toLocaleString('en-US');

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/**
 * @param {object} p 机型参数
 * @param {object} values 指标计算值
 * @param {object} poses  指标姿态
 * @param {object} [opts] { showNominal: boolean }
 */
export function renderSpecTables(p, values, poses, opts = {}) {
  const showNominal = opts.showNominal !== false && Object.keys(p.nominal ?? {}).length > 0;

  /* ---------- 作业尺寸 ---------- */
  const nominalRows = METRIC_META.map((m) => {
    const calc = values[m.key];
    if (!Number.isFinite(calc)) return '';
    const nom = p.nominal?.[m.key];
    const hasNom = Number.isFinite(nom);
    const dev = hasNom ? (calc - nom) / nom : null;
    const devCls = dev == null ? '' : Math.abs(dev) <= 0.05 ? 'dev-good' : 'dev-bad';
    return `<tr${m.key === 'groundMaxRadius' ? ' class="hi"' : ''}>
      <td><b>${esc(m.symbol)}</b>　${esc(m.label)}</td>
      <td class="num">${mm(calc)}</td>
      <td>mm</td>
      ${showNominal ? `<td class="num">${hasNom ? mm(nom) : '—'}</td>` : ''}
      ${showNominal ? `<td class="num ${devCls}">${dev == null ? '—' : `${dev >= 0 ? '+' : ''}${(dev * 100).toFixed(2)}%`}</td>` : ''}
    </tr>`;
  }).join('');

  const minSwing = values.minSwingRadius;
  const minSwingRow = Number.isFinite(minSwing)
    ? `<tr>
        <td><b>R</b>　最小回转半径</td>
        <td class="num">${mm(minSwing)}</td>
        <td>mm</td>
        ${showNominal ? `<td class="num">${Number.isFinite(p.nominal?.minSwingRadius) ? mm(p.nominal.minSwingRadius) : '—'}</td>` : ''}
        ${showNominal
          ? `<td class="num ${Number.isFinite(p.nominal?.minSwingRadius) && Math.abs((minSwing - p.nominal.minSwingRadius) / p.nominal.minSwingRadius) <= 0.05 ? 'dev-good' : Number.isFinite(p.nominal?.minSwingRadius) ? 'dev-bad' : ''}">${
              Number.isFinite(p.nominal?.minSwingRadius)
                ? `${minSwing - p.nominal.minSwingRadius >= 0 ? '+' : ''}${(((minSwing - p.nominal.minSwingRadius) / p.nominal.minSwingRadius) * 100).toFixed(2)}%`
                : '—'
            }</td>`
          : ''}
      </tr>`
    : '';

  const sizeTable = `
    <table class="spec-table">
      <caption>一、作业尺寸（由几何模型实时计算）</caption>
      <thead>
        <tr>
          <th style="width:34%">项目</th><th class="num">计算值</th><th>单位</th>
          ${showNominal ? '<th class="num">厂家标称</th><th class="num">偏差</th>' : ''}
        </tr>
      </thead>
      <tbody>
        ${nominalRows}
        ${minSwingRow}
      </tbody>
    </table>`;

  /* ---------- 几何参数 ---------- */
  const grouped = PARAM_GROUPS.map((group) => {
    const rows = PARAM_SPEC.filter((s) => s.group === group)
      .map((s) => {
        const v = p[s.key];
        if (!Number.isFinite(v)) return '';
        const shown = s.kind === 'number' ? v.toFixed(s.decimals ?? 2) : String(Math.round(v * 1000) / 1000);
        return `<tr><td>${esc(s.label)}</td><td class="num">${esc(shown)}</td><td>${esc(s.unit ?? '')}</td></tr>`;
      })
      .join('');
    if (!rows) return '';
    return `<tbody>
      <tr><th colspan="3" style="background:#f1f5f9">${esc(group)}</th></tr>
      ${rows}
    </tbody>`;
  }).join('');

  const geomTable = `
    <table class="spec-table">
      <caption>二、几何参数（当前输入）</caption>
      <thead><tr><th style="width:56%">参数</th><th class="num">数值</th><th>单位</th></tr></thead>
      ${grouped}
    </table>`;

  /* ---------- 派生关节角（只读） ---------- */
  const R = jointRanges(p);
  const b = bucketRotationRange(p);
  const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '—');
  const derivedTable = `
    <table class="spec-table">
      <caption>三、由油缸反解出的关节角范围（派生量，不可直接编辑）</caption>
      <thead><tr><th style="width:56%">项目</th><th class="num">下限</th><th class="num">上限</th><th>单位</th></tr></thead>
      <tbody>
        <tr><td>动臂仰角 α</td><td class="num">${f2(R.alpha[0])}</td><td class="num">${f2(R.alpha[1])}</td><td>°</td></tr>
        <tr><td>斗杆相对转角 Δ</td><td class="num">${f2(R.delta[0])}</td><td class="num">${f2(R.delta[1])}</td><td>°</td></tr>
        <tr><td>铲斗相对转角 ψ</td><td class="num">${f2(b.min)}</td><td class="num">${f2(b.max)}</td><td>°</td></tr>
        <tr><td>收斗位 ψ收（铲斗油缸全缩）</td><td class="num" colspan="2" style="text-align:center">${f2(b.curl)}</td><td>°</td></tr>
        <tr><td>卸料位 ψ卸（铲斗油缸全伸）</td><td class="num" colspan="2" style="text-align:center">${f2(b.dump)}</td><td>°</td></tr>
      </tbody>
    </table>`;

  /* ---------- 铰点整机坐标（输入口径的校验） ---------- */
  const pin = (q) => `(${mm(q.x)}, ${mm(q.y)})`;
  // 斗杆油缸活塞杆端随斗杆转动，它在「动臂两端点连线 A–B」上方还是下方决定了圆交点取哪一支
  const rodSpan = armRodPerpSpan(p);
  const rodSpanText = Number.isFinite(rodSpan.min)
    ? `行程内相对 A–B 连线 ${mm(rodSpan.min)} ~ ${mm(rodSpan.max)} mm（${rodSpan.above ? '全程在上方' : '有落到下方'}）`
    : '解不出装配支';
  const mountTable = `
    <table class="spec-table">
      <caption>四、铰点坐标对照（输入口径 → 整机坐标，便于与图纸核对）</caption>
      <thead><tr><th style="width:56%">铰点</th><th class="num">整机坐标 (x, y)</th><th>说明</th></tr></thead>
      <tbody>
        <tr><td>动臂根部铰点 A</td><td class="num">${pin({ x: p.pivotX, y: p.pivotY })}</td><td>输入基准</td></tr>
        <tr><td>动臂油缸缸筒端</td><td class="num">${pin(boomCylBodyPoint(p))}</td><td>A + (ΔX, ΔY)</td></tr>
        <tr><td>动臂油缸活塞杆端</td><td class="num">动臂坐标 (${mm(p.boomCylRodAlong)}, ${mm(p.boomCylRodPerp)})</td><td>随动臂转动</td></tr>
        <tr><td>斗杆油缸缸筒端</td><td class="num">自 B：(${mm(p.armCylBodyAlong)}, ${mm(p.armCylBodyPerp)})</td><td>动臂上表面；随动臂末端 B 移动</td></tr>
        <tr><td>斗杆油缸活塞杆端</td><td class="num">斗杆坐标 (${mm(p.armCylRodAlong)}, ${mm(p.armCylRodPerp)})</td><td>B 点后方、斗杆上平面；${rodSpanText}</td></tr>
        <tr><td>铲斗油缸缸筒端</td><td class="num">自 C：(${mm(p.bktCylBodyAlong)}, ${mm(p.bktCylBodyPerp)})</td><td>斗杆上方；随斗杆末端 C 移动</td></tr>
        <tr><td>摇杆铰点 D</td><td class="num">自 C：(${mm(p.bktBellAlong)}, ${mm(p.bktBellPerp)})</td><td>摇杆在斗杆上的铰点；随 C 移动</td></tr>
        <tr><td>摇杆长度</td><td class="num">${mm(p.bktRockerLen)}</td><td>D → 共用销轴 P</td></tr>
        <tr><td>连杆长度</td><td class="num">${mm(p.bktLinkLen)}</td><td>P → 铲斗铰点 E</td></tr>
        <tr><td>连杆–铲斗铰点 E</td><td class="num">铲斗坐标 (${mm(p.bktEAlong)}, ${mm(p.bktEPerp)})</td><td>相对铲斗铰点 C，沿斗齿方向为 x</td></tr>
      </tbody>
    </table>`;

  /* ---------- 布置自检（安装点口径 / 伸出方向 / 干涉） ---------- */
  const layout = verifyCylinderLayout(p);
  const layoutTable = `
    <table class="spec-table">
      <caption>五、油缸布置自检</caption>
      <thead><tr><th style="width:64%">检查项</th><th class="num">结果</th><th>实测</th></tr></thead>
      <tbody>
        ${layout.checks
          .map(
            (c) => `<tr><td>${esc(c.label)}</td>
              <td class="num ${c.ok ? 'dev-good' : 'dev-bad'}">${c.ok ? '通过' : '不通过'}</td>
              <td>${esc(c.detail)}</td></tr>`,
          )
          .join('')}
      </tbody>
    </table>`;

  /* ---------- 姿态说明 ---------- */
  const notes = [
    '关节角范围不是输入项：它由动臂油缸、斗杆油缸、铲斗油缸的「安装位置 + 安装距 + 行程」经连杆机构反解得到。改写油缸数据，角度与作业尺寸会同步变化。',
    '铰点坐标口径与真机图纸一致：动臂油缸缸筒端以「相对动臂铰点 A 的 ΔX/ΔY」给出（一般 ΔX>0、ΔY<0）；斗杆油缸缸筒端用动臂坐标、活塞杆端用斗杆坐标（真机在 B 点后方、斗杆上平面，即沿斗杆为负、垂直斗杆为正）；铲斗油缸与摇杆铰点都在斗杆上方（垂直斗杆为正）。',
    '铲斗采用标准的「斗杆–摇杆–连杆–铲斗」四连杆：摇杆与连杆都是两铰点杆，摇杆一端铰在斗杆的 D 点，另一端与铲斗油缸活塞杆、连杆共用一个销轴；连杆另一端铰在铲斗背板的 E 点。参数在「铲斗油缸与四连杆」组里。',
    '伸出方向由安装几何决定：动臂油缸伸出 → 抬起；斗杆油缸伸出 → 收拢（挖掘方向）；铲斗油缸全缩 → 收斗、全伸 → 卸料。自检表会逐条校验，改出装不上的组合会在参数面板给出提示。',
    '各指标均按国标姿态定义计算：最大挖掘深度取斗杆两铰点与斗齿尖三点共线且垂直停机面；最大挖掘高度取动臂仰角最大、斗杆与铲斗油缸全缩；最大卸载高度取同一姿态下斗齿尖垂直向下；最大挖掘半径取整链伸直且平行停机面；停机面最大挖掘半径取整链伸直且斗齿尖触地；最大垂直挖掘深度取斗底贴壁切削。',
    '油缸与连杆尺寸是标定得到的示例值（厂家样本不公开这些数据），拿到真机图纸后直接覆盖即可。表中「厂家标称」仅为对标参考，不参与几何计算。',
  ];

  const poseTable = `
    <div class="spec-table" style="border:none">
      <caption style="text-align:left;font-weight:700;font-size:13px;padding:12px 0 6px">六、计算口径说明</caption>
      <ul style="margin:0;padding-left:18px;font-size:11.5px;line-height:1.75;color:#475569">
        ${notes.map((t) => `<li>${esc(t)}</li>`).join('')}
      </ul>
    </div>`;

  return {
    sizeTable,
    geomTable,
    derivedTable,
    mountTable,
    layoutTable,
    poseTable,
    html: sizeTable + geomTable + derivedTable + mountTable + layoutTable + poseTable,
  };
}

/** 打印页眉 */
export function renderPrintHeader(p, when = new Date()) {
  const stamp = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')} ${String(
    when.getHours(),
  ).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
  return `<div style="display:flex;align-items:baseline;gap:12px;border-bottom:2px solid #0f172a;padding-bottom:6px;margin-bottom:10px">
    <b style="font-size:15px">挖掘机作业范围图</b>
    <span style="font-size:12px;color:#475569">${esc(p.name ?? '自定义机型')}</span>
    <span style="flex:1"></span>
    <span style="font-size:11px;color:#94a3b8">生成时间 ${stamp}</span>
  </div>`;
}
