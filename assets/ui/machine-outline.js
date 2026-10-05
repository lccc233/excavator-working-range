/**
 * 临工 H 系列风格的整机侧视外观。
 * 只负责 SVG 表现；尺寸沿用 bodyPolygons，不修改运动学或回转半径计算。
 * 所有细节按世界尺寸缩放，导出无需图片、外部字体或网络资源。
 */

const n = (v) => (Math.round(v * 100) / 100).toFixed(2);
const FONT = 'Arial, "Microsoft YaHei", sans-serif';

export function machinePaintDefs() {
  return `<defs>
    <linearGradient id="sdlg-yellow" x1="0" y1="0" x2="0.2" y2="1">
      <stop stop-color="#ffe17a"/><stop offset="0.45" stop-color="#f9c62c"/><stop offset="1" stop-color="#e9a914"/>
    </linearGradient>
    <linearGradient id="sdlg-arm" x1="0" y1="0" x2="0" y2="1">
      <stop stop-color="#ffdc59"/><stop offset="0.6" stop-color="#f6c329"/><stop offset="1" stop-color="#e7a812"/>
    </linearGradient>
    <linearGradient id="sdlg-glass" x1="0" y1="0" x2="1" y2="1">
      <stop stop-color="#9bbfc8"/><stop offset="0.38" stop-color="#527780"/><stop offset="1" stop-color="#253e48"/>
    </linearGradient>
    <linearGradient id="sdlg-steel" x1="0" y1="0" x2="0" y2="1">
      <stop stop-color="#69727a"/><stop offset="0.5" stop-color="#353e46"/><stop offset="1" stop-color="#20272e"/>
    </linearGradient>
  </defs>`;
}

/** SDLG 字标以实体尺寸排版；跟随机体/动臂缩放，可独立导出。 */
export function sdlgWordmark(x, y, width, height, fill = '#20272e', extra = '') {
  return `<text data-brand="SDLG" x="${n(x)}" y="${n(y)}" text-anchor="middle" dominant-baseline="central"
    font-family='${FONT}' font-size="${n(height)}" font-weight="900" font-style="italic"
    textLength="${n(width)}" lengthAdjust="spacingAndGlyphs" fill="${fill}" ${extra}>SDLG</text>`;
}

export function drawMachineBody(p, T, body) {
  const parts = [];
  const point = (x, y) => `${n(T.X(x))},${n(T.Y(y))}`;
  const path = (d, fill, stroke = '#303840', w = 1) =>
    `<path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"/>`;
  const poly = (pts, fill, stroke = '#303840', w = 1, extra = '') =>
    `<polygon points="${pts.map((q) => point(q.x, q.y)).join(' ')}" fill="${fill}" stroke="${stroke}" stroke-width="${w}" stroke-linejoin="round" ${extra}/>`;
  const line = (x0, y0, x1, y1, stroke = '#303840', w = 0.8) =>
    `<line x1="${n(T.X(x0))}" y1="${n(T.Y(y0))}" x2="${n(T.X(x1))}" y2="${n(T.Y(y1))}" stroke="${stroke}" stroke-width="${w}" stroke-linecap="round"/>`;
  const rect = (x, y, w, h, fill, stroke = 'none', r = 0, sw = 0.8) =>
    `<rect x="${n(T.X(x))}" y="${n(T.Y(y + h))}" width="${n(w * T.s)}" height="${n(h * T.s)}" rx="${n(r * T.s)}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
  const circle = (x, y, r, fill, stroke = '#303840', sw = 0.7) =>
    `<circle cx="${n(T.X(x))}" cy="${n(T.Y(y))}" r="${n(r * T.s)}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;

  const h = Math.max(1, p.trackHeight);
  const L = Math.max(1, p.trackLength);
  const half = L / 2;
  const r = Math.min(h / 2, L / 2);
  const straight = Math.max(0, L - 2 * r);
  const rear = -Math.max(1, p.tailSwingRadius);
  const front = Math.max(0, p.platformFront);
  const { deck, top, cabFloor, hoodTop } = body;
  const bodyH = top - deck;
  const cabL = body.cab[0].x;
  const cabR = body.cab[1].x;
  const cabW = cabR - cabL;
  const cabH = top - cabFloor;
  const cwR = Math.max(...body.counterweight.map((q) => q.x));
  const cwTop = Math.max(...body.counterweight.map((q) => q.y));
  const cwW = cwR - rear;
  const cwH = cwTop - deck;

  // 履带板沿跑道形链轨排列，端部沿圆弧转向；不穿过轮系。
  parts.push(`<g data-detail="tracks">`);
  parts.push(rect(-half, 0, L, h, 'url(#sdlg-steel)', '#20272e', r, 1.15));
  const shoeStep = Math.max(100, h * 0.18);
  const count = Math.max(1, Math.round(straight / shoeStep));
  for (let i = 0; i <= count; i++) {
    const x = -half + r + straight * i / count;
    parts.push(line(x, h * 0.025, x, h * 0.15, '#899198', 0.75));
    parts.push(line(x, h * 0.85, x, h * 0.975, '#899198', 0.75));
  }
  for (const side of [-1, 1]) {
    const cx = side * (half - r);
    for (let i = -4; i <= 4; i++) {
      const a = i * Math.PI / 9;
      const dx = side * Math.cos(a);
      const dy = Math.sin(a);
      parts.push(line(cx + dx * r * 0.73, h / 2 + dy * r * 0.73,
        cx + dx * r * 0.97, h / 2 + dy * r * 0.97, '#899198', 0.75));
    }
  }
  parts.push(rect(-half + h * 0.12, h * 0.15, Math.max(1, L - h * 0.24), h * 0.70, '#222a31', '#838b91', r * 0.74));
  parts.push(rect(-half + r, h * 0.34, straight, h * 0.27, '#444e56', '#1c2329', h * 0.05));
  for (const w of body.wheels.filter((wheel) => wheel.kind !== 'road')) {
    const big = w.kind !== 'carrier';
    parts.push(circle(w.x, w.y, w.r * 0.93, 'url(#sdlg-steel)', '#151c22', big ? 1 : 0.6));
    parts.push(circle(w.x, w.y, w.r * 0.68, 'none', '#818a91', 0.65));
    parts.push(circle(w.x, w.y, w.r * 0.23, '#899197', '#20272e', 0.65));
    if (big) {
      for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4;
        parts.push(circle(w.x + Math.cos(a) * w.r * 0.47, w.y + Math.sin(a) * w.r * 0.47,
          h * 0.018, '#a4abb0', 'none'));
      }
    }
  }
  const wheelSpan = Math.max(0, L - 2.65 * r);
  for (let i = 0; i < 7; i++) {
    const x = -wheelSpan / 2 + wheelSpan * i / 6;
    parts.push(circle(x, h * 0.275, h * 0.135, '#515c65', '#151c22'));
    parts.push(circle(x, h * 0.275, h * 0.063, '#92999e', '#303840', 0.6));
  }
  parts.push(`</g>`);

  // 侧视回转支承是扁平的轴承座，底盘与上车之间有明确层次。
  parts.push(poly(body.carbody, '#3d474f'));
  const slewW = body.slewRing.r * 3.3;
  parts.push(rect(-slewW / 2, deck - h * 0.055, slewW, h * 0.12, '#78828a', '#303840', h * 0.025));
  parts.push(line(-slewW / 2, deck + h * 0.005, slewW / 2, deck + h * 0.005, '#c1c6ca', 0.65));
  parts.push(rect(rear + cwW * 0.08, deck - h * 0.05, front - rear - cwW * 0.08,
    h * 0.19, '#303840', '#20272e', h * 0.035, 1));
  parts.push(poly(body.upper, 'url(#sdlg-yellow)'));

  // 宽厚配重：弧形机尾、黄色上壳及深色下裙边。
  const corner = Math.min(cwH * 0.18, cwW * 0.16);
  const tail = `M ${point(rear + corner, deck)} L ${point(cwR, deck)} L ${point(cwR, cwTop - corner)}
    Q ${point(cwR, cwTop)} ${point(cwR - corner, cwTop)} L ${point(rear + corner, cwTop)}
    Q ${point(rear, cwTop)} ${point(rear, cwTop - corner)} L ${point(rear, deck + corner)}
    Q ${point(rear, deck)} ${point(rear + corner, deck)} Z`;
  parts.push(path(tail, 'url(#sdlg-yellow)', '#806416', 1.15));
  parts.push(line(rear + corner * 0.55, deck + cwH * 0.20, cwR - cwW * 0.05, deck + cwH * 0.20, '#ad801b', 0.8));
  parts.push(path(`M ${point(rear + cwW * 0.07, deck + cwH * 0.69)} L ${point(cwR - cwW * 0.05, deck + cwH * 0.69)}
    L ${point(cwR - cwW * 0.12, deck + cwH * 0.36)} L ${point(rear + cwW * 0.07, deck + cwH * 0.36)} Z`, '#28323a', 'none'));
  parts.push(sdlgWordmark(T.X(rear + cwW * 0.48), T.Y(deck + cwH * 0.535), cwW * 0.65 * T.s, cwH * 0.25 * T.s, '#fff'));

  // 发动机罩：上盖斜面、检修门、百叶格栅和门锁。
  const hoodL = Math.min(...body.hood.map((q) => q.x));
  const hoodR = Math.max(...body.hood.map((q) => q.x));
  const hoodW = Math.max(1, hoodR - hoodL);
  const hoodH = hoodTop - deck;
  parts.push(poly(body.hood, 'url(#sdlg-yellow)', '#806416'));
  parts.push(line(hoodL + hoodW * 0.1, hoodTop - hoodH * 0.07, hoodR - hoodW * 0.07, hoodTop - hoodH * 0.07, '#fff0a4', 0.8));
  parts.push(rect(hoodL + hoodW * 0.13, deck + hoodH * 0.19, hoodW * 0.65, hoodH * 0.63, '#edb522', '#af821c', hoodH * 0.06, 0.65));
  parts.push(rect(hoodL + hoodW * 0.22, deck + hoodH * 0.30, hoodW * 0.46, hoodH * 0.39, '#303a42', 'none', hoodH * 0.04));
  for (let i = 1; i <= 7; i++) {
    const y = deck + hoodH * (0.30 + 0.39 * i / 8);
    parts.push(line(hoodL + hoodW * 0.25, y, hoodL + hoodW * 0.65, y, '#738087', 0.6));
  }
  parts.push(rect(hoodL + hoodW * 0.70, deck + hoodH * 0.57, hoodW * 0.065, hoodH * 0.09, '#303840', 'none', hoodH * 0.025));
  parts.push(rect(hoodL + hoodW * 0.15, hoodTop - hoodH * 0.025, hoodW * 0.08, bodyH * 0.14, '#343e46', '#20272e', hoodW * 0.025));
  parts.push(line(hoodL + hoodW * 0.13, hoodTop + bodyH * 0.12, hoodL + hoodW * 0.25, hoodTop + bodyH * 0.12, '#20272e', 1.3));

  // 深色驾驶室和大面积玻璃，所有窗框都在驾驶室局部坐标中布局。
  const cab = (u, v) => ({
    x: cabL + cabW * (0.05 * v + u * (1 - 0.14 * v)),
    y: cabFloor + cabH * v,
  });
  const window = (u0, v0, u1, v1) => [cab(u0, v0), cab(u1, v0), cab(u1, v1), cab(u0, v1)];
  parts.push(`<g data-detail="cab">`);
  parts.push(poly(body.cab, '#283239', '#20272e', 1.2));
  parts.push(poly(window(0.06, 0.40, 0.27, 0.90), 'url(#sdlg-glass)', '#111c24', 0.7));
  parts.push(poly(window(0.32, 0.40, 0.90, 0.90), 'url(#sdlg-glass)', '#111c24', 0.7));
  parts.push(poly(window(0.32, 0.12, 0.90, 0.36), 'url(#sdlg-glass)', '#111c24', 0.7));
  // 玻璃反光和驾驶座剪影。
  parts.push(poly([cab(0.35, 0.88), cab(0.51, 0.88), cab(0.86, 0.45), cab(0.70, 0.45)], '#d8eced', 'none', 0, 'opacity="0.18"'));
  parts.push(poly([cab(0.44, 0.42), cab(0.48, 0.67), cab(0.56, 0.67), cab(0.57, 0.46), cab(0.69, 0.46), cab(0.69, 0.42)], '#223039', 'none'));
  parts.push(line(cab(0.29, 0.05).x, cab(0.29, 0.05).y, cab(0.29, 0.94).x, cab(0.29, 0.94).y, '#8a969c', 0.6));
  parts.push(line(cab(0.12, 0.30).x, cab(0.12, 0.30).y, cab(0.24, 0.30).x, cab(0.24, 0.30).y, '#c2cbd0', 1.1));
  parts.push(line(cab(0.88, 0.43).x, cab(0.88, 0.43).y, cab(0.75, 0.75).x, cab(0.75, 0.75).y, '#20272e', 0.9));
  const roofL = cab(0, 1).x;
  const roofR = cab(1, 1).x;
  parts.push(rect(roofL - cabW * 0.02, top - cabH * 0.02, roofR - roofL + cabW * 0.05, cabH * 0.055, '#dfe4e5', '#303840', cabH * 0.02));
  parts.push(rect(roofR - cabW * 0.09, top - cabH * 0.10, cabW * 0.07, cabH * 0.04, '#fff2c0', '#20272e', cabH * 0.01, 0.6));
  parts.push(rect(roofL + cabW * 0.12, top + cabH * 0.035, cabW * 0.04, cabH * 0.04, '#ed9b20', '#845817', cabH * 0.015, 0.6));
  // 前侧扶手、后视镜及登车踏板。
  const hand = [cab(0.97, 0.18), cab(0.97, 0.63), cab(1.07, 0.68)];
  parts.push(path(`M ${point(hand[0].x, hand[0].y)} L ${point(hand[1].x, hand[1].y)} L ${point(hand[2].x, hand[2].y)}`, 'none', '#4f5b62', 0.9));
  parts.push(rect(hand[2].x - cabW * 0.015, hand[2].y, cabW * 0.065, cabH * 0.09, '#2f3b44', '#111c24', cabW * 0.015, 0.6));
  parts.push(rect(cabL + cabW * 0.32, deck + h * 0.16, cabW * 0.62, h * 0.09, '#465159', '#20272e', h * 0.02));
  parts.push(line(cabL + cabW * 0.36, deck + h * 0.24, cabR - cabW * 0.10, deck + h * 0.24, '#a4adb2', 0.65));
  parts.push(`</g>`);

  // 动臂支座盖住驾驶室下部，体现前后装配关系。
  parts.push(poly(body.boomFoot, 'url(#sdlg-yellow)', '#806416'));
  const railY = hoodTop + bodyH * 0.16;
  const railL = hoodL + hoodW * 0.36;
  const railR = hoodR - hoodW * 0.08;
  parts.push(path(`M ${point(railL, hoodTop)} L ${point(railL, railY - bodyH * 0.025)}
    Q ${point(railL, railY)} ${point(railL + hoodW * 0.05, railY)} L ${point(railR, railY)} L ${point(railR, hoodTop)}`, 'none', '#37434b', 1));

  return `<g data-layer="machine-body"><title>山东临工 SDLG 风格整机外形</title>${parts.join('')}</g>`;
}

/** 动臂字标贴在弯臂中段，方向跟随中段切线，始终从左向右可读。 */
export function drawBoomBrand(p, pose, T) {
  const a = pose.alphaDeg * Math.PI / 180;
  const t = 0.43;
  const bend = p.boomBend ?? 0;
  const offset = bend * 4 * t * (1 - t);
  const x = pose.A.x + p.boomLength * t * Math.cos(a) - offset * Math.sin(a);
  const y = pose.A.y + p.boomLength * t * Math.sin(a) + offset * Math.cos(a);
  const tangent = a + Math.atan2(4 * bend * (1 - 2 * t), p.boomLength);
  let angle = -tangent * 180 / Math.PI;
  while (angle > 90) angle -= 180;
  while (angle < -90) angle += 180;
  const width = Math.min(p.boomLength * 0.22, (p.boomWidth ?? 520) * 2.25) * T.s;
  const height = (p.boomWidth ?? 520) * 0.48 * T.s;
  return `<g data-detail="boom-brand" transform="translate(${n(T.X(x))} ${n(T.Y(y))}) rotate(${n(angle)})">${sdlgWordmark(0, 0, width, height)}</g>`;
}

/** 构件表面的焊接边、液压管线与斗壁加强板；保持原来的轮廓和铰点。 */
export function drawAttachmentDetails(att, T) {
  const pts = (qs) => qs.map((q) => `${n(T.X(q.x))},${n(T.Y(q.y))}`).join(' ');
  const insetSide = (qs, fraction) => qs.slice(0, qs.length / 2).map((q, i) => {
    const opposite = qs[qs.length - i - 1];
    return { x: q.x + (opposite.x - q.x) * fraction, y: q.y + (opposite.y - q.y) * fraction };
  });
  const boom = att.boomSegs[0];
  const edge = insetSide(boom, 0.16);
  const arm = insetSide(att.armQuad, 0.16);
  const hose = insetSide(boom, 0.06);
  const bucket = att.bucket;
  const center = bucket.reduce((c, q) => ({ x: c.x + q.x / bucket.length, y: c.y + q.y / bucket.length }), { x: 0, y: 0 });
  const plate = bucket.slice(2).map((q) => ({ x: center.x + (q.x - center.x) * 0.80, y: center.y + (q.y - center.y) * 0.80 }));
  return `<g data-detail="attachment-surfaces" fill="none" stroke-linejoin="round" stroke-linecap="round">
    <polyline points="${pts(edge)}" stroke="#fff0a1" stroke-width="0.8"/>
    <polyline points="${pts(arm)}" stroke="#fff0a1" stroke-width="0.8"/>
    <polyline points="${pts(hose)}" stroke="#3c454b" stroke-width="1.2"/>
    <polyline points="${pts(plate)}" stroke="#89959d" stroke-width="1"/>
  </g>`;
}
