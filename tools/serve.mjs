#!/usr/bin/env node
/**
 * 零依赖本地静态服务器
 * ==========================================================================
 * 为什么不能直接双击 index.html：
 * 页面用的是原生 ES 模块，file:// 协议下浏览器会以 CORS 为由拒绝加载模块。
 * 所以本地调试必须走一个 HTTP 服务。这里只用 node:http + node:fs，
 * 不装任何依赖，也不用 Python。
 *
 *   node tools/serve.mjs               默认 http://127.0.0.1:8080
 *   node tools/serve.mjs --port 5000
 *   node tools/serve.mjs --host 0.0.0.0  允许局域网内其它设备访问
 */

import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');

const argv = process.argv.slice(2);
const getArg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const PORT = Number(getArg('port', '8080'));
const HOST = getArg('host', '127.0.0.1');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';

    // 目录穿越防护：解析后必须仍在 ROOT 内
    const target = path.resolve(ROOT, `.${pathname}`);
    if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
      return send(res, 403, 'Forbidden');
    }

    const info = await stat(target).catch(() => null);
    if (!info) return send(res, 404, `404 Not Found: ${pathname}`, { 'Content-Type': 'text/plain; charset=utf-8' });
    if (info.isDirectory()) {
      res.writeHead(302, { Location: `${pathname.replace(/\/?$/, '/')}index.html` });
      return res.end();
    }

    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-store',
    });
    createReadStream(target).pipe(res);
  } catch (err) {
    send(res, 500, `500 ${err.message}`, { 'Content-Type': 'text/plain; charset=utf-8' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`挖掘机作业范围图生成器 · 本地服务已启动`);
  console.log(`  http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/`);
  console.log(`  根目录：${ROOT}`);
  console.log(`  按 Ctrl+C 停止`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，换一个：node tools/serve.mjs --port ${PORT + 1}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
