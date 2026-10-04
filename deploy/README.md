# 部署手册 —— 挖掘机作业范围图生成器

## 线上地址

站点已在自有云主机上线并验证通过（2026-10-04）。**具体实例与地址不随本仓库公开**，下表中以占位符给出，换成你自己的即可。

> 本文里的 `<实例ID>`、`<安全组ID>`、`<域名或 IP>` 都是占位符，按实际替换。

| 项 | 值 |
|---|---|
| 实例 | `<实例ID>`（cn-hangzhou，Ubuntu 26.04.1 LTS） |
| 公网 | 弹性公网 IP `<域名或 IP>`（已绑定） |
| 线上版本 | commit `53622d3`（2026-10-04 17:25 更新：切半圆斗形 + 油缸端支座） |
| 回滚点 | `/root/site-backup-20261004-172535`（上一版整目录备份，见第 1 节） |
| Web 服务器 | nginx 1.28.3（Ubuntu），`systemctl is-enabled nginx` = enabled（开机自启） |
| 站点目录 | `/var/www/excavator`（属主 www-data） |
| 站点配置 | `/etc/nginx/sites-available/excavator` → `sites-enabled/excavator`（default_server）；**线上实际内容与仓库 `deploy/nginx-excavator.conf` 不一致**，改配置前先 `cat` 线上文件（见第 4 节） |
| 安全组 | `<安全组ID>` 入方向已放行 `tcp 80/80 <- 0.0.0.0/0`（443 也已通） |
| HTTPS | 443 已监听，用自签证书（`/etc/nginx/ssl/excavator.crt`），浏览器会提示不受信；要正式用需换域名 + 可信证书 |
| 同机其他服务 | mosquitto 监听 1883（离线调试用），本次部署未改动 |

---

## 0. 交付物形态

纯静态站点，**没有构建步骤、没有运行时依赖、没有后端**。上线内容只有：

```
index.html
assets/style.css
assets/core/*.js      （几何/指标/包络/油缸/预设/分享链接）
assets/ui/*.js        （绘图/控件/导出/参数表/主控）
```

`tests/`、`tools/`、`deploy/`、`.verify/` **都不上线**。所有计算都在浏览器里完成，参数通过 URL 分享，服务端不存任何数据。

---

## 1. 改完代码后如何更新线上

```powershell
# 1) 本地打包（Windows 自带 tar.exe；新模块会被 glob 自动收进来）
#    本机只有 Windows PowerShell 5.1（没有 pwsh），且脚本未签名，直接 & 调用会被执行策略拦；
#    用下面的写法（-ExecutionPolicy Bypass）即可：
powershell.exe -NoProfile -ExecutionPolicy Bypass -File deploy\package.ps1
#    → dist/excavator.tar.gz（同时做 BOM / UTF-8 / 本地地址残留体检）

# 2) 上传到 /tmp 或 /root 下的新文件名
#    ⚠️ workbench upload 在目标文件已存在时会交互式询问是否覆盖，自动化里会卡住；
#       传到新路径（带版本/commit）就绕开这个提示。
workbench upload dist\excavator.tar.gz /root/excavator-<版本>.tar.gz `
  --instance-id <实例ID>

# 3) 备份 + 解包替换 + reload（整目录替换，回滚就是把备份目录拷回去）
#    ⚠️ -c 后面整段用单引号包住，别在远端命令里写双引号：
#       PowerShell 会把内层双引号吃掉，curl -w "..." 之类会收到错参数（实测 exit 2）。
workbench exec -i <实例ID> --timeout 120 -c 'set -e; \
  ts=$(date +%Y%m%d-%H%M%S); cp -a /var/www/excavator /root/site-backup-$ts; \
  rm -rf /var/www/excavator/*; tar -xzf /root/excavator-<版本>.tar.gz -C /var/www/excavator; \
  chown -R www-data:www-data /var/www/excavator; nginx -t && systemctl reload nginx; \
  echo backup=/root/site-backup-$ts; \
  curl -s -o /dev/null -w localhost_index=%{http_code} http://127.0.0.1/'

# 4) 外部逐文件验证（本机 Node 的 fetch 可用；PowerShell 的 TLS 在沙箱里被拦）
SITE=http://<域名或 IP> node tools/verify-deploy.mjs
#    → 逐个文件比对本地与线上的 sha256，并检查新特性确实在线上（15/15 才算通过）
#    不带 SITE 时默认校验本地服务 http://127.0.0.1:8080（改版前自检用）
```

> 沙箱注意：`workbench` CLI 通过本机命名管道与守护进程通信，沙箱会拒绝（`Access is denied`）。
> 运行 workbench 命令时需要对这条命令放宽权限。

---

## 2. 首次部署做过什么（完整记录）

```bash
# 2.1 装 nginx（实例已绑 EIP，可直接 apt）
apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nginx
systemctl enable --now nginx            # 1.28.3，开机自启

# 2.2 上传并解包（见第 1 节第 2、3 步）
# 2.3 写站点配置 → /etc/nginx/sites-available/excavator，并禁用默认站点
rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/excavator /etc/nginx/sites-enabled/excavator
nginx -t && systemctl reload nginx

# 2.4 安全组放行 80（workbench CLI 不管安全组，用 ECS OpenAPI）
node deploy/aliyun-sg.mjs show        # 看现状
node deploy/aliyun-sg.mjs open 80     # 放行 tcp/80 <- 0.0.0.0/0
```

`deploy/aliyun-sg.mjs` 用 `~/.workbench/config.json` 里当前 profile 的 AK 调 ECS OpenAPI（RPC 签名 v1.0），
只做两件事：查安全组规则、放行某个端口。密钥只在本机读取，不落盘、不打印。

---

## 3. 验证结果（2026-10-04 17:25 复验，commit `53622d3`）

| 检查 | 结果 |
|---|---|
| `http://<域名或 IP>/` | 200，text/html |
| 全部 15 个文件与本地构建 | **sha256 逐个一致 15/15**（`tools/verify-deploy.mjs`，带查询串绕开 7 天缓存，平均 34 ms/文件） |
| 上传包完整性 | 本地与线上 tar.gz 的 sha256 一致（`bf8f20f2…b28b`） |
| 新特性确实在线上 | `bucketLocalShape` / `armHeelAlong` / `cylinderMounts` / `data-mount` 均在；旧常量 `BUCKET_LOCAL_SHAPE` 已不存在 |
| 指标（实体外形渲染） | 10043 / 9950 / 9570 / 6700 / 6600 / 5799 / **3732**（切半圆斗形后最小回转半径由 3740 → 3732，厂家样本 3730） |
| 服务器端自检 | `/var/www/excavator` 文件齐全，`nginx -t` 通过并已 reload |
| 端口探测 | 22 ✅、1883 ✅（原有）、80 ✅；443 未开 |

> 首次上线（同一实例）的历史结果：15/15 一致，指标 10043 / 9950 / 9571 / 6701 / 6599 / 5799 / 3740。

---

## 4. 注意与风险

| 项 | 说明 |
|---|---|
| 实例标签 | `ecs=trial`，存在试用到期回收风险；正式对外前建议换包年包月实例 |
| HTTPS | 443 已监听但是**自签证书**，浏览器报不受信；要正式上 HTTPS 得有域名 + 可信证书（Let's Encrypt 或阿里云证书） |
| ICP 备案 | 用**域名**对外服务必须备案（约 10–20 工作日）；`http://IP` 直连不需要，适合先做测试 |
| 回滚 | 站点目录整目录替换；部署前会先 `cp -a` 一份 `/root/site-backup-<时间戳>`，回滚 = 把该目录内容拷回 `/var/www/excavator` 再 reload |
| 配置漂移 | 线上 `/etc/nginx/sites-available/excavator` 与仓库 `deploy/nginx-excavator.conf` 不一致：线上多了 443/SSL server 块，静态资源缓存 **7 天**（`expires 7d`），且没有 index.html 的 `no-cache` 块。**不要**拿仓库文件直接覆盖线上配置 |
| 缓存 | 静态资源 7 天缓存，且文件名不带内容指纹 —— 发新版后老访客可能仍拿旧 JS，需要强刷（Ctrl+F5）。想根治就得给文件名加指纹或把缓存降到分钟级 |
| 带宽 | EIP 按量计费，注意带宽上限（静态站点很小，正常够用） |
