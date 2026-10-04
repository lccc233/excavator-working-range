/**
 * 作业范围图 —— 缩放 / 平移控制器
 * ==========================================================================
 *
 * 为什么要有它：这是一张标注密集的工程图（铰点、油缸、支座、六条尺寸线）。
 * 手机上画布只有 360~430px 宽，整幅缩进来看得见但看不清，必须能就近放大。
 *
 * 三条设计约定：
 *
 * 1. **变换加在包裹层，不加在 <svg> 上。**
 *    exporter.js 的 serializeSvg() 直接序列化屏幕上那个 <svg>，
 *    如果把 transform 写在它身上，导出/打印出来的图会带着缩放与位移。
 *    所以 index.html 里多了一层 <div class="chart-zoom">，缩放只动这一层。
 *
 * 2. **纯数学与 DOM 分离。**
 *    clampTransform / zoomAt 是零 DOM 的纯函数，能在 Node 里单测（tests/zoom.test.js）；
 *    只有 createChartZoom 里才碰 document —— 与 docs/开发与测试.md 的分层判据一致。
 *
 * 3. **钳制保证「图不会被拖飞」。**
 *    内容盒 = 视口盒（都是画布尺寸），所以缩放 k 倍后合法的位移区间是
 *    [W − W·k, 0]：k = 1 时退化为 [0, 0]，即 1× 下不存在残留位移。
 *    「拖到一半就露出白边」和「缩小后图飘到角落」都是靠这一条避免的。
 */

export const MIN_K = 1;
export const MAX_K = 8;

const clampNum = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * 把变换钳制到合法范围。
 * @param {{k:number, tx:number, ty:number}} t
 * @param {number} W 视口宽（= 画布宽）
 * @param {number} H 视口高
 */
export function clampTransform(t, W, H) {
  const k = clampNum(Number.isFinite(t.k) ? t.k : MIN_K, MIN_K, MAX_K);
  const w = Math.max(1, W);
  const h = Math.max(1, H);
  const minX = w - w * k; // ≤ 0
  const minY = h - h * k;
  return {
    k,
    tx: clampNum(Number.isFinite(t.tx) ? t.tx : 0, minX, 0),
    ty: clampNum(Number.isFinite(t.ty) ? t.ty : 0, minY, 0),
  };
}

/**
 * 以 (cx, cy) 为锚点缩放 factor 倍：锚点下面的那个世界点保持不动。
 * 这是「捏合」与「滚轮」共用的核心 —— 缩放必须锚在手势中点 / 光标的那个位置，
 * 否则图会朝画布角落跑。
 */
export function zoomAt(t, factor, cx, cy, W, H) {
  const cur = clampTransform(t, W, H);
  const k = clampNum(cur.k * factor, MIN_K, MAX_K);
  const r = k / cur.k;
  return clampTransform({ k, tx: cx - (cx - cur.tx) * r, ty: cy - (cy - cur.ty) * r }, W, H);
}

/** 1× 的基准变换 */
export function identityTransform() {
  return { k: MIN_K, tx: 0, ty: 0 };
}

/** 变换 → CSS transform 字符串 */
export function transformCss(t) {
  return `translate(${t.tx.toFixed(2)}px, ${t.ty.toFixed(2)}px) scale(${t.k.toFixed(4)})`;
}

/**
 * 绑定到 DOM。
 *
 * 手势策略：未放大时**不拦截**单指拖动，页面照常上下滚（靠 CSS 的 touch-action: pan-y）；
 * 一旦 k > 1 就给 host 加 .is-zoomed 切到 touch-action: none，此时拖动只平移图。
 * 这样「手机上想滚页面」和「放大后想平移图」两个诉求不会互相打架。
 *
 * @param {HTMLElement} o.host    裁剪盒 + 手势区（.chart）
 * @param {HTMLElement} o.content 变换目标（.chart-zoom）
 * @param {(t:{k:number,tx:number,ty:number}) => void} [o.onChange]
 */
export function createChartZoom({ host, content, onChange }) {
  let t = identityTransform();
  const pointers = new Map(); // pointerId -> { x, y }
  let pinchBase = null; // { dist, cx, cy, at }
  let dragging = false;

  const size = () => ({ W: Math.max(1, host.clientWidth), H: Math.max(1, host.clientHeight) });

  function apply(next, notify = true) {
    const { W, H } = size();
    t = clampTransform(next, W, H);
    content.style.transform = transformCss(t);
    host.classList.toggle('is-zoomed', t.k > MIN_K + 1e-6);
    if (notify) onChange?.({ ...t });
    return t;
  }

  /** 内容尺寸变化（重绘 / 转屏）后重新钳制，避免旧位移落到新区间外 */
  function clampContent() {
    return apply(t, false);
  }

  function zoomBy(factor, cx, cy) {
    const { W, H } = size();
    return apply(zoomAt(t, factor, cx ?? W / 2, cy ?? H / 2, W, H));
  }

  function reset() {
    return apply(identityTransform());
  }

  /* ---------------- 指针手势（触摸 / 鼠标 / 触控笔统一） ---------------- */

  const midpoint = () => {
    const pts = [...pointers.values()];
    return { cx: (pts[0].x + pts[1].x) / 2, cy: (pts[0].y + pts[1].y) / 2 };
  };
  const distance = () => {
    const pts = [...pointers.values()];
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  };
  /** setPointerCapture 对「非活动指针」会抛 NotFoundError（合成事件、已抬起的指针） */
  const capture = (id) => {
    try {
      host.setPointerCapture?.(id);
    } catch {
      /* 抓不到就算了，不影响变换本身 */
    }
  };

  function onPointerDown(ev) {
    // 只处理落在图上的主键指针；缩放按钮在 .chart 内，必须放过它们
    if (ev.target.closest?.('.zoom-ctl')) return;
    if (ev.button > 0) return;
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pointers.size === 2) {
      const { cx, cy } = midpoint();
      pinchBase = { dist: Math.max(1, distance()), cx, cy, at: t };
      dragging = false;
      capture(ev.pointerId);
    } else if (pointers.size === 1 && t.k > MIN_K + 1e-6) {
      dragging = true;
      capture(ev.pointerId);
    }
  }

  function onPointerMove(ev) {
    const p = pointers.get(ev.pointerId);
    if (!p) return;
    const prev = { x: p.x, y: p.y };
    p.x = ev.clientX;
    p.y = ev.clientY;
    // client 坐标（相对视口）要换算成 host 内坐标
    const rect = host.getBoundingClientRect();

    if (pointers.size === 2 && pinchBase) {
      ev.preventDefault?.();
      const { W, H } = size();
      const factor = distance() / pinchBase.dist;
      const { cx, cy } = midpoint();
      const scaled = zoomAt(
        pinchBase.at,
        factor,
        cx - rect.left,
        cy - rect.top,
        W,
        H,
      );
      // 两指距离不变时的整体拖动 = 中点位移；叠在缩放结果上
      apply({
        k: scaled.k,
        tx: scaled.tx + (cx - pinchBase.cx),
        ty: scaled.ty + (cy - pinchBase.cy),
      });
      return;
    }

    if (dragging && pointers.size === 1) {
      ev.preventDefault?.();
      apply({ k: t.k, tx: t.tx + (p.x - prev.x), ty: t.ty + (p.y - prev.y) });
    }
  }

  function onPointerUp(ev) {
    pointers.delete(ev.pointerId);
    if (pointers.size < 2) pinchBase = null;
    // 双指抬起一根后：已放大就把平移交给剩下那根，否则交回页面滚动
    dragging = pointers.size === 1 && t.k > MIN_K + 1e-6;
  }

  /* ---------------- 滚轮 / 双击 ---------------- */

  function onWheel(ev) {
    // 带 Ctrl/Cmd 的滚轮是浏览器页面缩放，明确放行
    if (ev.ctrlKey || ev.metaKey) return;
    ev.preventDefault();
    const rect = host.getBoundingClientRect();
    // deltaY < 0（向上滚）→ 放大
    const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
    zoomBy(factor, ev.clientX - rect.left, ev.clientY - rect.top);
  }

  function onDblClick(ev) {
    ev.preventDefault(); // 免得顺带选中标注文字
    if (t.k > MIN_K + 1e-6) reset();
    else zoomBy(2.5);
  }

  host.addEventListener('pointerdown', onPointerDown);
  host.addEventListener('pointermove', onPointerMove);
  host.addEventListener('pointerup', onPointerUp);
  host.addEventListener('pointercancel', onPointerUp);
  host.addEventListener('wheel', onWheel, { passive: false });
  host.addEventListener('dblclick', onDblClick);
  content.style.transform = transformCss(t);

  return {
    zoomBy,
    reset,
    clampContent,
    getTransform: () => ({ ...t }),
    isZoomed: () => t.k > MIN_K + 1e-6,
    destroy() {
      host.removeEventListener('pointerdown', onPointerDown);
      host.removeEventListener('pointermove', onPointerMove);
      host.removeEventListener('pointerup', onPointerUp);
      host.removeEventListener('pointercancel', onPointerUp);
      host.removeEventListener('wheel', onWheel);
      host.removeEventListener('dblclick', onDblClick);
      host.classList.remove('is-zoomed');
      content.style.transform = '';
    },
  };
}
