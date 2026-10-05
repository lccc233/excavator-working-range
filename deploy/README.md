# 部署手册 —— 挖掘机作业范围图生成器

## 线上地址

站点已在自有云主机上线，最近一次代码部署验证于 **2026-10-05** 完成。**具体实例与地址不随本仓库公开**，下表中以占位符给出。

> 本文里的 `<实例ID>`、`<安全组ID>`、`<域名或 IP>` 都是占位符，按实际替换。

| 项 | 值 |
|---|---|
| 实例 | `<实例ID>`（cn-hangzhou，Ubuntu 26.04.1 LTS） |
| 公网 | 弹性公网 IP `<域名或 IP>`（已绑定） |
| 线上代码版本 | commit `2ecf455`（2026-10-05：移除最大垂直挖掘深度、修正挖掘力方向和不可达姿态处理） |
| 回滚点 | `/root/site-backup-2ecf455-20261005145811`（本次部署前的整目录备份） |
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

本次交付共 **17 个文件、248,918 字节（约 243 KiB）**，压缩包 81,772 字节。`tests/`、`tools/`、`deploy/`、`docs/`、`.verify/` 都不在部署包中。所有计算都在浏览器里完成，没有业务数据接口或数据库；分享 URL 中的参数可能出现在浏览器历史或 Web 访问日志中。

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

# 3) 服务器端准备、验证和切换：见下面的目录发布流程

# 4) 外部逐文件验证（PowerShell 环境变量写法）
$env:SITE = 'http://<域名或 IP>'
node tools/verify-deploy.mjs
#    → 当前版本应为 17/17 一致，并通过首页与页面资源引用检查
#    不带 SITE 时默认校验本地服务 http://127.0.0.1:8080（改版前自检用）
```

服务器端目录发布流程：

1. 比对上传包的 SHA-256；在 `/var/www/excavator-release-<版本>` 新目录解包，确认只包含 `index.html` 和 `assets/**`，逐文件与本地清单比对。
2. 设置站点属主为 `www-data`、目录权限 0755、文件权限 0644；执行 `nginx -t`，并将当前 `/var/www/excavator` 完整备份到 `/root/site-backup-<版本>`。
3. 在同一文件系统上通过 Linux `renameat2(..., RENAME_EXCHANGE)` 原子交换站点目录与发布目录。交换后站点目录指向新文件，发布目录保留上一版。本次部署使用 Python 3 调用该系统接口；接口返回失败时停止发布，不清空现有站点。
4. 请求本机首页并比对内容，再从公网执行上述验证。只更新静态文件时无需重载 nginx；只有修改 nginx 配置时才需要在配置检查通过后重载。

远端脚本建议先保存、上传，再用 `workbench exec --instance-id <实例ID> -c 'python3 /root/<发布脚本>.py'` 执行，避免把长脚本和多层引号直接嵌进 PowerShell 命令。本次发布清单、执行记录和校验回执保存在本地 `.verify/`，不随公开仓库发布。

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

## 3. 验证结果（2026-10-05，commit `2ecf455`）

| 检查 | 结果 |
|---|---|
| `http://<域名或 IP>/` | 200，`text/html; charset=utf-8` |
| 全部静态文件 | **SHA-256 逐个一致 17/17**，包含当前 `forces.js`、`presets.js` 和 `app.js` |
| 页面原样资源引用 | 8 个引用均返回 200，内容与本地一致 |
| 上传包完整性 | 本地与服务器 SHA-256 均为 `0711d4bd65dc07b298b748c036de148cbb743bff138e9c198c6c91ff9abbb466` |
| 已有特性检查 | 动态斗形、斗杆后跟、油缸端支座关键字检查通过，旧斗形常量不存在 |
| 服务器端自检 | 解包目录和站点文件校验通过，原子交换后首页与本地一致；`nginx -t` 通过，服务保持 active |
| 代码验证基线 | Node 159 项、浏览器自检 113 项通过；两预设八步轨迹验证见 [包络验证](../docs/包络验证.md) |

历史记录：2026-10-04 的 `53622d3` 版本交付 15 个文件，15/15 校验通过。当时仍包含最大垂直挖掘深度，不能直接沿用为当前界面的指标数量。

---

## 4. 注意与风险

| 项 | 说明 |
|---|---|
| 实例标签 | `ecs=trial`，存在试用到期回收风险；正式对外前建议换包年包月实例 |
| HTTPS | 443 已监听但是**自签证书**，浏览器报不受信；要正式上 HTTPS 得有域名 + 可信证书（Let's Encrypt 或阿里云证书） |
| 域名上线 | 域名、证书和备案等上线条件应按实际服务场景及云厂商当前要求另行核对 |
| 回滚 | 保留发布目录中的上一版和 `/root/site-backup-<版本>`；用同一原子交换流程恢复完整目录，避免新旧版本文件混合，随后重新验证 |
| 配置漂移 | 线上多了 443/SSL server 块，静态资源缓存为 **5 分钟**（2026-10-05 已核对），入口页没有仓库参考配置中的 `no-cache` 块。改配置前先读取并备份线上文件 |
| 缓存 | 入口与模块引用携带 `?v=<发版戳>`，本次核心模块与入口脚本为 `20261005c`；版本串与 5 分钟缓存共同处理更新。部署校验同时检查穿透缓存请求和页面原样引用 |
| 带宽 | EIP 按量计费，注意带宽上限（静态站点很小，正常够用） |
