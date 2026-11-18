<p align="center">
  <img src="assets/logo.jpg" width="132" alt="大肥鱼">
</p>

<h1 align="center">dsh-plugin-reverse-proxy</h1>

<p align="center">简体中文 ｜ <a href="README.en.md">English</a></p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="license"></a>
  <a href="https://www.npmjs.com/package/dsh-plugin-reverse-proxy"><img src="https://img.shields.io/npm/v/dsh-plugin-reverse-proxy?label=npm" alt="npm"></a>
  <a href="https://www.npmjs.com/package/dsh-plugin-reverse-proxy"><img src="https://img.shields.io/npm/dm/dsh-plugin-reverse-proxy?label=downloads" alt="downloads"></a>
  <a href="https://github.com/llifco/dsh-plugin-reverse-proxy/releases/latest"><img src="https://img.shields.io/github/v/release/llifco/dsh-plugin-reverse-proxy?label=release" alt="release"></a>
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen.svg" alt="dependencies">
  <img src="https://img.shields.io/badge/build-none-brightgreen.svg" alt="build">
  <a href="#适用范围"><img src="https://img.shields.io/badge/dsh-0.2.2--rc.1~rc.3-blueviolet.svg" alt="dsh"></a>
  <a href="https://github.com/llifco/dsh-plugin-reverse-proxy/actions"><img src="https://img.shields.io/github/actions/workflow/status/llifco/dsh-plugin-reverse-proxy/publish.yml?label=publish" alt="publish"></a>
  <a href="https://github.com/llifco/dsh-plugin-reverse-proxy/stargazers"><img src="https://img.shields.io/github/stars/llifco/dsh-plugin-reverse-proxy" alt="stars"></a>
</p>

> 一条命令装上，局域网里的手机、平板、另一台电脑就能直接打开你的 DSH 网页界面，
> **而且不用再从启动日志里抄那串随机 token**。

```bash
dsh plugin --profile web add dsh-plugin-reverse-proxy   # 推荐：npm 包，免构建
```

装完打开 **设置 → 局域网访问**：默认只监听本机，点开关 → 确认 → 手机就能进。
（也可以 `github:llifco/dsh-plugin-reverse-proxy` 从源码装，见 [安装](#安装)。）

---

## 三个能力

> 0.3.5 起：设置页开关换成紫色，**监听端口**也能自己填了（默认 8080，保存即生效，重启保留）。

### 1. 反向代理（默认启用）

```
局域网浏览器 ──▶ 0.0.0.0:8080 (本插件，开关开启后才会监听；端口可改)
                    │  改写请求头：
                    │    Host             → 127.0.0.1:3080
                    │    Origin           → http://127.0.0.1:3080
                    │    Sec-Fetch-Site   → same-origin
                    │    Referer          → 清空
                    │  补充：X-Real-IP / X-Forwarded-For / X-Forwarded-Proto
                    ▼
             127.0.0.1:3080 (dsh web 本体)
```

`dsh web` 只监听回环，且会校验 `Host` / `Origin` 是否「像本机访问」，直接暴露到局域网会被 403。
以前靠 nginx 改写请求头，现在这段逻辑跑在插件里。

- 流式不缓冲（SSE、大文件下载不卡）
- WebSocket 用 `net.connect` 手写 101 透传
- 长连接超时对齐 nginx 的 3600s，请求体上限 200 MiB
- 端口被占每 5 秒重试，加载期绝不抛异常

### 2. 局域网访问开关与端口（默认关闭 / 8080）

默认只监听 `127.0.0.1:8080`，也就是**只有跑 DSH 的这台机器自己**能打开后台。
要把后台共享给同一个 Wi-Fi / 局域网里的手机、平板、另一台电脑，必须在两个入口之一**显式确认**：

- 设置页：**设置 → 局域网访问**，点开关（紫色）→ 弹安全提示 → 点「确定」才生效；
  同一页还有「监听端口」输入框，改完点「保存」立刻切端口。
- 命令行（斜杠命令）：在 DSH 输入框里发 `/lan` 看状态，`/lan yes` 开启（先给出同一份安全提示），`/lan no` 关闭。
- 命令行（终端）：`reproxy-lan status` 看状态，`reproxy-lan enable` 需敲 `yes` 确认后才开，`reproxy-lan disable` 直接关。

两个入口读写同一份状态文件 `<DSH_HOME>/plugin-reverse-proxy/lan-access.json`，
所以永远同步；切换后立即重建监听，**重启 dsh 也不会丢**，不需要重新打开。

> ⚠️ 开启后，同一网络里的任何设备直接访问 `http://<这台机器的IP>:<端口>` 就能进入完整后台
> （会话、终端、设置），不需要 Token、不需要登录。只在信任当前局域网时开启。

#### 怎么用（三个入口，改的是同一份状态）

**① 设置页**

设置 → 局域网访问 → 点开关 → 弹「对局域网开放访问？」→ 点「确定」才生效。
左侧会同时显示「已开启 / 已关闭」，下面带状态与上次修改时间。

#### 改端口（默认 8080）

同一页第二张卡片就是「监听端口」：输入框填数字 → 点 **保存** → 立刻重建监听，
**不用重启 dsh**，重启后也会保留。规则：1024–65535，不能占 3080（那是 DSH 自己的端口），
不在这个区间或已被占用会直接报错、不改动现状（被占用会返回 409）。

三个入口都能改端口：

```
/lan port          看当前端口
/lan port 9000     改端口
reproxy-lan port 9000    (SSH 里)
```

**② 对话输入框里的斜杠命令**

```
/lan            看当前状态
/lan status     同上
/lan yes        开启（打 yes 即确认）
/lan no         关闭
```

**③ 终端命令**（SSH 上机器）

```bash
reproxy-lan status     # 看状态
reproxy-lan enable     # 先打安全提示，输入 yes 才真正开启
reproxy-lan disable    # 直接关闭
reproxy-lan port 9000  # 改监听端口（1024–65535，不能占 3080）
reproxy-lan --help
```

终端示例（`status` → `enable` → 输入 `yes` 确认 → 立刻监听 `0.0.0.0:8080`）：

![reproxy-lan 终端示例](assets/lan-access-cli.jpg)

切换后**立刻重建监听**（旧连接会断开，重新打开即可），**`systemctl restart dsh` 也不会丢**，
因为状态存在 `<DSH_HOME>/plugin-reverse-proxy/lan-access.json`，一条 JSON 而已：

```json
{ "lanAccess": true, "port": 8080, "updatedAt": "2026-11-15T06:06:33.690Z", "updatedBy": "cli" }
```

想彻底关闭又不点开关？`reproxy-lan disable` 或 `/lan no` 都行；想手动改文件也可以，
插件用 `fs.watch` 盯着它，改完一两秒内自动生效（`updatedBy` 可以写 `manual`）。

### 3. 免 Token 登录（版本门控，命中才启用）

替换官方 `@deepseek-ai/dsh-client-connection` 提供方，跳过 BrowserAuth：
浏览器直接打开 Web 地址就能用。

- **web-only**：desktop 宿主一律休眠（多进程树判别），官方行为不受影响
- **精确版本白名单**：runtime 与 connection 包必须成对命中已知版本，否则自动休眠、官方 connection 原样保留
- **不改 DSH 本体**：只通过官方插件 patch 机制替换那一行，卸载/禁用即完全恢复
- 当前覆盖：`0.1.2-rc.1` `0.1.5-rc.1/rc.2` `0.1.7-rc.1/rc.2` `0.2.0-rc.1/rc.2` `0.2.1-rc.1~rc.5` `0.2.2-rc.1/rc.2/rc.3`

> 这部分参考并内联自 [`@iasiv5/dsh-skip-browser-auth`](https://github.com/iasiv5/dsh-skip-browser-auth)（MIT），
> 在 `vendor/skip/` 下，保留其 LICENSE 与 NOTICE。

---

## 适用范围

| 场景 | 能不能用 |
|---|---|
| **Web UI 版**（浏览器打开 `http://<局域网IP>:8080`，端口可改，需先开启局域网访问） | ✅ 就是给它用的 |
| **桌面版 / 客户端版** | ❌ 用不上，也不建议用 |

桌面版本来就在本机跑，直连 `127.0.0.1:3080` 即可，不需要反代，也不需要跳过认证。

---

## 安装

**从 npm 装（最简单，已收录 awesome-dsh-plugin）**

```bash
dsh plugin --profile web add dsh-plugin-reverse-proxy
```

或在插件市场里搜 `reverse-proxy`，点「安装」。

**从源码装**

```bash
git clone https://github.com/llifco/dsh-plugin-reverse-proxy.git
cd dsh-plugin-reverse-proxy
dsh plugin --profile web add .
```

或者用 Release / npm 上的 tarball（文件名带当前版本号）：

```bash
dsh plugin --profile web add ./dsh-plugin-reverse-proxy-0.4.3.tgz
# 或 npm 包：https://registry.npmjs.org/dsh-plugin-reverse-proxy/-/dsh-plugin-reverse-proxy-0.4.3.tgz
```

装完重启一次宿主：

```bash
systemctl restart dsh
```

**默认只监听 `127.0.0.1:8080`**，所以装完先在本机打开 `http://127.0.0.1:8080` 确认能用。
要让手机 / 平板 / 别的电脑进来，先开「局域网访问」开关（见上一节三种入口），
再打开 `http://<这台机器的局域网IP>:8080`，无需 token。

第一次开启建议用终端，确认提示看得清清楚楚：

```bash
reproxy-lan enable    # 读完提示，输入 yes
```

---

## 配置

反向代理（`cordis.patch.yml` 里 `dsh-plugin-reverse-proxy` 行）：

| 配置项 | 默认值 | 对应原 nginx |
|---|---|---|
| `listenHost` | 由「局域网访问」开关决定（默认 `127.0.0.1`） | `listen 127.0.0.1:8080` |
| `listenPort` | 由设置页「监听端口」决定（默认 `8080`，存状态文件） | 不需要写配置 |
| `listenIpv6` | `false` | `listen [::]:8080` |
| `upstreamHost` / `upstreamPort` | `127.0.0.1` / `3080` | `proxy_pass` |
| `upstreamHostHeader` | `127.0.0.1:3080` | `proxy_set_header Host` |
| `upstreamOrigin` | `http://127.0.0.1:3080` | `proxy_set_header Origin` |
| `maxBodyBytes` | `209715200` | `client_max_body_size 200m` |
| `retryMs` | `5000` | —（端口冲突重试间隔） |

免 Token 登录（`dsh-plugin-reverse-proxy-trusted-connection*` 行）的 `trustedHosts`
由 DSH 的 Web 运行时配置自动注入，一般不用手改。

---

## 目录结构

```
dsh-plugin-reverse-proxy/
├── index.js                  # 入口：按 cordis 行 id 分发（反代 / 免登录）
├── lan-access.js             # 局域网访问开关：状态读写 + 监听重建
├── cordis.patch.yml          # 官方插件 patch：版本门控 + 插入两条能力行
├── assets/logo.jpg           # 仓库头像
├── vendor/skip/              # 免 Token 登录实现（MIT，来自 dsh-skip-browser-auth）
│   ├── host.js  gate.js  compatibility.js
│   ├── trust-fence.js  trusted-auth.js  bridge.js
│   ├── connection-runtime.js
│   ├── adapters/             # carrier-neutral / -017 / -021
│   └── client.js             # 浏览器端 bundle（已注入）
├── dist/*.tgz                # 打包产物（离线安装用）
├── CHANGELOG.md
├── README.md / README.en.md
└── LICENSE
```

---

## 卸载 / 回退到 nginx

```bash
dsh plugin --profile web remove dsh-plugin-reverse-proxy
systemctl restart dsh
```

退回 nginx 反代：

```bash
ln -sf /etc/nginx/sites-available/dsh /etc/nginx/sites-enabled/dsh
nginx -t && systemctl reload nginx
```

---

## 常见问题

**Q：只能本机打开，手机/局域网里的设备打不开？**
这是 0.3.2 起的新默认：只监听 `127.0.0.1`。用 `/lan yes` 或 `reproxy-lan enable` 开启，
或者去 设置 → 局域网访问 点开关。开完 `ss -ltnp | grep 8080` 应该看到 `0.0.0.0:8080`。

**Q：能不能用别的端口？比如 3000、9000？**

能。设置 → 局域网访问 → 第二张卡「监听端口」→ 填数字 → **保存**，立刻切换（不用重启）。
也可以在输入框发 `/lan port 9000`，或 SSH 里 `reproxy-lan port 9000`。允许 1024–65535。

**Q：能不能用 80 / 443 这种端口？**

当前版本限制在 1024 以上，故意不给选 80——本机如果还留着 nginx，80 会被它占着；
而且 80 是最容易被局域网里乱扫描的设备撞上的端口，安全上不划算。想改这段门槛，
得改 `lan-access.js` 的 `validatePort()` 并确保进程有绑定特权端口的权限。

**Q：同一台设备开第二个窗口，资源和聊天记录都加载不出来？**

**当前已知限制：暂时不支持同一浏览器开多个窗口。** 第二块窗口会一直转圈、聊天记录空着，
关掉其他窗口（或断网重连）才恢复；手机和电脑各开一个、或其中一个用无痕窗口不受影响。

原因在 DSH 官方的身份模型：一个浏览器 cookie = 一份 Peer = 一条能回答 waterfall 的事件流，
网关转发事件时认的是「一个活着的客户端」而不是「一个标签」。本插件 0.4.x 已经给每个标签页
单独发了身份（`x-dsh-tab` 头 + mux 上的 `?tab=`，日志里能看到 `http tab …` / `mux admit …`
分别是不同的 id），但网关那一层仍只认一条回答流，所以插件侧绕不过去，得等官方放开。

设置页的「局域网访问」面板里也写了这条提示，免得下次又当故障排查。

**Q：装完 8080 还是打不开？**
`ss -ltnp | grep 8080` 看占用者。还是 nginx 的话，旧的 `sites-enabled/dsh` 软链没删，两个会抢端口。

**Q：打开又要 token 了？**
说明免登录那半休眠了——多半是 DSH 升级后版本不在白名单里。看日志有没有
`BrowserAuth has been skipped`；没有就是休眠，官方行为，功能上等价。

**Q：能穿透公网吗？**
不能，也不建议。它只把「局域网可访问」做对；公网请自己加隧道并做鉴权。

**Q：桌面版能用吗？**
用不上——桌面版本机直连 `127.0.0.1:3080` 即可。

---

## 反馈

- 问题反馈 / 功能建议 / 装不上的报错：**QQ 3538638569**（3538638569@qq.com）
- 反馈时带上 `dsh --version`、`dsh plugin --profile web list` 和你看到的日志，能快很多。

## 许可

MIT（`vendor/skip/` 内代码来自 @iasiv5/dsh-skip-browser-auth，同样 MIT）
