# 更新日志

本文件记录每个版本改了什么。格式：版本号（日期）先概述，再分条列具体改动。

---

## 0.3.5（2026-11-17）

**一句话：设置页的开关换成紫色，并新增「监听端口」输入框（保存即生效、重启保留）。**

### 更新

- 设置页「局域网访问」开关改用紫色（`#8b5cf6`）+ 白色圆钮，深色主题下更显眼。
- 新增「监听端口」输入框：默认 8080，允许 1024–65535，改完点「保存」立即重建监听（不用重启 dsh），重启后保留。
- 端口也进状态文件 `<DSH_HOME>/plugin-reverse-proxy/lan-access.json` 的 `port` 字段；设置页、斜杠命令、命令行三个入口读写同一份。
- `POST /reproxy-lan/port` 新接口：先探测端口是否被占（被占返回 409），再写入并重建监听。
- 斜杠命令扩展：`/lan port` 看当前端口、`/lan port 9000` 直接改。
- `GET /reproxy-lan/status` 多返回 `defaultPort`，方便前端显示默认值。

### 修复

- 端口从未真正生效过（`normalize()` 一直读配置里的 8080），现在以状态文件为准。

---

## 0.3.4（2026-11-15）

**一句话：只打包文档，把 0.3.x 的用法和截图一起塞进发行包（代码与 0.3.3 相同）。**

### 文档

- README / README.en：新增「局域网访问」完整用法（设置页开关、`/lan` 斜杠命令、
  终端 `reproxy-lan status|enable|disable`）、状态文件说明、终端示例截图 `assets/lan-access-cli.jpg`。
- 明确默认只监听 `127.0.0.1:8080`；安装段、适用范围与 FAQ 同步补「要开开关才对外」。
- 免 Token 登录覆盖版本补 `0.2.2-rc.2/rc.3`；目录结构补 `lan-access.js`。
- `package.json` 的 `files` 增加 `assets`、`README.en.md`，保证包内 README 的图片能正常显示。

---

## 0.3.3（2026-11-15）

**一句话：设置页里的「局域网访问」开关真的会出现了（0.3.2 的入口实际没渲染）。**

### 修复

- 设置面板不显示：前端 bundle 的四个 `profile` 分支都会提前 `return`，面板代码写在分支之后，
  命中任一分支就永远执行不到（`const` 未初始化，包裹调用会撞 TDZ 并被 catch 静默吞掉）。
  现在把面板定义提到分支之前，并在返回的模块上合并 `inject: ['slots']` 与面板的 `apply`，
  任何 profile 下都会挂上设置项。
- 开关样式改为与内置控件一致（轨道 `--dsw-alias-border-l1`、`on` 用 `--dsw-alias-brand-primary`、
  圆钮带阴影，左侧显示「已开启 / 已关闭」），此前半透明白轨道在一个深色主题下几乎看不见。

### 文档

- README / README.en：DSH 徽章更新到 0.2.2-rc.3；补充终端入口 `reproxy-lan`（`status|enable|disable`）。

---

## 0.3.2（2026-11-15）

**一句话：默认只允许本机访问；要共享给局域网，必须在设置页或命令行里显式确认。**

### 更新

- 新增「局域网访问」开关：设置页（设置 → 局域网访问）与命令行 `/lan yes|no|status` 两个入口，
  读写同一份状态文件 `<DSH_HOME>/plugin-reverse-proxy/lan-access.json`，切换后立即重建监听、重启保留。
- 监听地址不再由配置写死，改由开关状态决定：关闭 = `127.0.0.1`，开启 = `0.0.0.0`（含 IPv6 时 `::`）。
- 开启时启动日志打一条 `warn`，提醒同网段设备可直接进入后台。

### 修复

- 安全：此前默认监听 `0.0.0.0:8080` 且免 Token 登录，装好即对局域网全开，且没有任何一次主动同意
  （社区审核 fkysly 指出）。现在默认关闭，开启前必须过安全提示并确认。

---

## 0.3.1（2026-11-15）

**一句话：适配 DSH 0.2.2-rc.2 / rc.3，升级后免 Token 登录不再失效。**

### 更新

- 兼容表 `carrier-neutral-v4` 新增 `0.2.2-rc.2`、`0.2.2-rc.3` 两个版本对（§5.15 审计）。
- 发布包不再把 `dist/*.tgz` 套进 tgz（避免 tgz 套 tgz 体积翻倍）。

### 修复

- 升级到 DSH `0.2.2-rc.3` 后进入后台报 401「dsh web authentication required」：
  版本门控不认识新版本 → 免登录行休眠 → 官方 BrowserAuth 接管。

---

## 0.3.0（2026-11-13）

**一句话：反代加 gzip 与静态资源长缓存，弱网下 Web UI 首屏快一个数量级。**

### 更新

- 文本类响应（JS / JSON / HTML / SVG / manifest）自动 gzip 压缩（`zlib.createGzip`，流式管道），
  首屏 JS 传输体积约降到原来的 1/3~1/4。
- `/assets/*` 与带 `rev=` 内容指纹的 `/plugins/*` 组合包返回
  `cache-control: public, max-age=31536000, immutable`，二次访问不再重新下载。
- `text/event-stream`（SSE）、WebSocket、二进制与已压缩响应直通，不二次压缩。

### 修复

- 手机弱网下首屏约 16MB 未压缩 JS 加载不完，导致「聊天记录不显示、刷新一直转圈」；
  电脑 LAN 下同样因为体积大而慢。

---

## 0.2.0（2026-11-11）

**一句话：反代插件把「免 Token 登录」吞了，一个包同时做两件事。**

### 新增

- 合并免 Token 登录能力：替换官方 `@deepseek-ai/dsh-client-connection` 提供方，
  浏览器打开 Web 地址即可使用，不再需要从启动日志里复制 token。
- 免登录部分按「runtime 包 + connection 包」双锚点做精确版本门控，
  命中才替换，不命中自动休眠（官方行为原样保留，等价于没装）。
- 支持版本：`0.1.2-rc.1`、`0.1.5-rc.1/rc.2`、`0.1.7-rc.1/rc.2`、
  `0.2.0-rc.1/rc.2`、`0.2.1-rc.1~rc.5`、`0.2.2-rc.1`。
- desktop 宿主一律休眠（按安装槽位 / 启动 argv / 宿主二进制三重判别），
  不会把桌面版带崩。
- 免登录源码内联在 `vendor/skip/`（参考 `@iasiv5/dsh-skip-browser-auth`，MIT，
  保留其 LICENSE / NOTICE）。

### 修复

- 入口漏声明 `inject: ['webServer']`，导致替换 connection 后注册路由时报
  `cannot get property "webServer" without inject`（0.2.0 第一次上线踩到，
  已修复并二次验证通过）。
- 启动流程改为「模块级 inject + 行级 inject 合并」：`webServer` 与
  `webStartup` / `webRuntime` 同时注入，替换行与反代行都能正常拿到服务。

### 文档

- README 重写：两个能力的原理图、适用范围表（Web UI ✅ / 桌面版 ❌）、
  配置项与 nginx 原配置对照、卸载与回退步骤、常见问题。
- 新增本 CHANGELOG。

### 已知限制

- 仅 Web UI 版适用；桌面版/客户端用不上。
- 免登录依赖版本白名单：DSH 升级到白名单外的版本后会自动休眠，
  表现为「又需要 token 了」，不是故障。

---

## 0.1.0（2026-11-09）

**一句话：把 nginx 承担的 dsh 反向代理搬进插件。**

- 监听 `0.0.0.0:8080`，转发到 `127.0.0.1:3080`。
- 改写请求头以通过 dsh 的 Host/Origin 校验：
  `Host: 127.0.0.1:3080`、`Origin: http://127.0.0.1:3080`、`Sec-Fetch-Site: same-origin`，
  清空 `Referer`，补 `X-Real-IP` / `X-Forwarded-For` / `X-Forwarded-Proto`。
- WebSocket 用 `net.connect` 手写 101 透传；响应不缓冲；请求体上限 200 MiB；
  端口占用每 5 秒重试；加载期异常不外抛（不会拖垮宿主）。
- 与 nginx 行为对齐验证：`/` 响应字节数、`/api` 302 行为、静态资源 sha256 均一致。
