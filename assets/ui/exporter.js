/**
 * 导出：SVG / PNG / 打印 PDF
 * ==========================================================================
 * 全部零依赖：
 *   · SVG —— 序列化页面上那个 <svg>。因为绘图时用的是「表现属性」而不是外部
 *            CSS 类，序列化出来的文件自带全部样式，可以脱离网页单独打开。
 *   · PNG —— 把 SVG 变成 data URL 交给 <img>，再画到 canvas 上导出。
 *           按倍数放大以保证印刷清晰。
 *   · PDF —— 走浏览器打印（另存为 PDF），矢量输出、零依赖、排版由 @media print 控制。
 *
 * 注意：PNG 走的是 data URL + Image 的路径，因此 SVG 里不能引用任何外部资源，
 * 这也是本图不使用外部字体/图片的原因。
 */

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 给浏览器一点时间发起下载再回收
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** 把页面上渲染出的 <svg> 序列化成独立文件 */
export function serializeSvg(svgEl) {
  const clone = svgEl.cloneNode(true);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  if (!clone.getAttribute('width') || !clone.getAttribute('height')) {
    const box = svgEl.viewBox?.baseVal;
    if (box?.width) {
      clone.setAttribute('width', box.width);
      clone.setAttribute('height', box.height);
    }
  }
  const src = new XMLSerializer().serializeToString(clone);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${src}`;
}

export function exportSvg(svgEl, filename = 'excavator-working-range.svg') {
  const text = serializeSvg(svgEl);
  triggerDownload(new Blob([text], { type: 'image/svg+xml;charset=utf-8' }), filename);
}

/** 把 SVG 画到 canvas 上，返回 canvas */
export async function svgToCanvas(svgEl, scale = 2, background = '#ffffff') {
  const text = serializeSvg(svgEl);
  const box = svgEl.viewBox?.baseVal;
  const w = Math.max(1, Math.round(box?.width || svgEl.clientWidth || 1200));
  const h = Math.max(1, Math.round(box?.height || svgEl.clientHeight || 800));

  const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;

  const img = await new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('SVG 转位图失败'));
    el.src = svgUrl;
  });

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export async function exportPng(svgEl, filename = 'excavator-working-range.png', scale = 2) {
  const canvas = await svgToCanvas(svgEl, scale);
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG 生成失败'))), 'image/png');
  });
  triggerDownload(blob, filename);
}

/** 复制纯文本到剪贴板（带降级方案） */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 落到下面的降级方案 */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** 文件名安全化 */
export function safeFilename(name, ext) {
  const base = String(name ?? 'excavator')
    .replace(/[\\/:*?"<>|\s]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 60);
  return `${base || 'excavator'}-作业范围图.${ext}`;
}
