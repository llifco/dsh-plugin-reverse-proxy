# dsh-plugin-reverse-proxy

> DSH Web 的两个「网络入口」能力，合成一个插件：**局域网反向代理** + **免 Token 登录**。
>
> **当前版本：v0.2.0**　｜　改了什么见 [CHANGELOG.md](CHANGELOG.md)　｜　反馈请看文末

一条命令装上，局域网里的手机、平板、另一台电脑就能直接打开你的 DSH 网页界面，
**而且不用再从启动日志里抄那串随机 token**。

---

## 两个能力

### 1. 反向代理（默认启用）

```
局域网浏览器 ──▶ 0.0.0.0:8080 (本插件)
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
以前靠 nginx 反代改写请求头，现在这段逻辑跑在插件里。

- 流式不缓冲（SSE、大文件下载不卡）
- WebSocket 用 `net.connect` 手写 101 透传
- 长连接超时对齐 nginx 的 3600s，请求体上限 200 MiB
- 端口被占每 5 秒重试，加载期绝不抛异常

### 2. 免 Token 登录（版本门控，命中才启用）

替换官方 `@deepseek-ai/dsh-client-connection` 提供方，跳过 BrowserAuth：
浏览器直接打开 Web 地址就能用，不用复制启动 URL 里的随机 token。

- **web-only**：desktop 宿主一律休眠（多进程树判别），官方行为不受影响
- **精确版本白名单**：runtime 与 connection 包必须成对命中已知版本，否则自动休眠、官方 connection 原样保留
- **不修改 DSH 本体**：只通过官方插件 patch 机制替换那一行，卸载/禁用即完全恢复
- 当前覆盖：`0.1.2-rc.1` `0.1.5-rc.1/rc.2` `0.1.7-rc.1/rc.2` `0.2.0-rc.1/rc.2` `0.2.1-rc.1~rc.5` `0.2.2-rc.1`

> 这部分的实现参考并内联自 [`@iasiv5/dsh-skip-browser-auth`](https://github.com/iasiv5/dsh-skip-browser-auth)（MIT），
> 在 `vendor/skip/` 下，保留其 LICENSE 与 NOTICE。

---

## 适用范围（重要）

| 场景 | 能不能用 |
|---|---|
| **Web UI 版**（浏览器打开 `http://<局域网IP>:8080`） | ✅ 就是给它用的 |
| **桌面版 / 客户端版** | ❌ 用不上，也不建议用 |

桌面版本来就在本机跑，直连 `127.0.0.1:3080` 即可，**不需要反代，也不需要跳过认证**。

---

## 安装

```bash
git clone https://github.com/llifco/dsh-plugin-reverse-proxy.git
cd dsh-plugin-reverse-proxy
dsh plugin --profile web add .
```

或用打包好的版本（见 `dist/`）：

```bash
dsh plugin --profile web add ./dist/dsh-plugin-reverse-proxy-0.2.0.tgz
```

装完重启一次宿主：

```bash
systemctl restart dsh
```

然后浏览器打开 `http://<这台机器的局域网IP>:8080`，无需 token。

---

## 配置

反向代理（`cordis.patch.yml` 里 `dsh-plugin-reverse-proxy` 行）：

| 配置项 | 默认值 | 对应原 nginx |
|---|---|---|
| `listenHost` | `0.0.0.0` | `listen 8080` |
| `listenPort` | `8080` | 同上 |
| `listenIpv6` | `false` | `listen [::]:8080` |
| `upstreamHost` / `upstreamPort` | `127.0.0.1` / `3080` | `proxy_pass` |
| `upstreamHostHeader` | `127.0.0.1:3080` | `proxy_set_header Host` |
| `upstreamOrigin` | `http://127.0.0.1:3080` | `proxy_set_header Origin` |
| `maxBodyBytes` | `209715200` | `client_max_body_size 200m` |
| `retryMs` | `5000` | —（端口冲突重试间隔） |

免 Token 登录（`dsh-plugin-reverse-proxy-trusted-connection*` 行）的 `trustedHosts`
由 DSH 的 Web 运行时配置自动注入，一般不用手改。

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

**Q：装完 8080 还是打不开？**
`ss -ltnp | grep 8080` 看占用者。还是 nginx 的话，旧的 `sites-enabled/dsh` 软链没删，两个会抢端口。

**Q：打开又要 token 了？**
说明免登录那半休眠了 —— 多半是 DSH 升级后版本不在白名单里。看日志有没有
`BrowserAuth has been skipped`；没有就是休眠，官方行为，功能上等价。

**Q：能穿透公网吗？**
不能，也不建议。它只是把「局域网可访问」做对；公网请自己加隧道并做鉴权。

**Q：桌面版能用吗？**
用不上 —— 桌面版本机直连 `127.0.0.1:3080` 即可。

---

## 版本与反馈

- 当前版本：**v0.2.0**（更新记录：[CHANGELOG.md](CHANGELOG.md)）
- 问题反馈 / 功能建议 / 装不上的报错：**QQ 3538638569**（3538638569@qq.com）
  带上 `dsh --version`、`dsh plugin --profile web list` 和你看到的日志，能快很多。

## 许可

MIT（`vendor/skip/` 内代码来自 @iasiv5/dsh-skip-browser-auth，同样 MIT）
