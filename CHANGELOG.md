# 更新日志

本文件记录每个版本改了什么。格式：版本号（日期）先概述，再分条列具体改动。

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
