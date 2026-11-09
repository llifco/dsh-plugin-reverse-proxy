# dsh-plugin-reverse-proxy

> 把原来由 nginx 承担的 **DSH Web UI 反向代理**，搬进 DSH 插件本体。

一条命令装上，局域网里的手机、平板、另一台电脑就能直接打开你的 DSH 网页界面，
不用再维护一份 nginx 配置，也不用担心哪天改配置漏了哪个 `proxy_set_header`。

---

## 为什么需要它

`dsh web` 默认只监听 `127.0.0.1:3080`，而且会校验请求的 `Host` / `Origin`
是不是「像本机访问」。所以直接把它暴露到局域网上是打不开的 —— 会被判成跨站请求，回你一个 403。

以前的通用做法是加一段 nginx 反代，靠这几行把请求伪装成本机来源：

```nginx
proxy_pass http://127.0.0.1:3080;
proxy_set_header Host "127.0.0.1:3080";
proxy_set_header Origin "http://127.0.0.1:3080";
proxy_set_header Sec-Fetch-Site "same-origin";
```

这个插件就是把上面这套逻辑用纯 Node 重写了一遍，直接跑在 DSH 进程里。
**装插件 = 装反代**，少一层 nginx，也少一个可能配错的环节。

---

## 适用范围（重要）

| 场景 | 能不能用 |
|---|---|
| **Web UI 版**（浏览器打开 `http://<局域网IP>:8080`） | ✅ 就是给它用的 |
| **桌面版 / 客户端版** | ❌ 用不上，也不建议用 |

原因很简单：这个插件解决的是「浏览器要跨机器访问 Web UI」这件事。
桌面版本来就在本机跑，直接连 `127.0.0.1:3080` 就行，**不需要也不应该再走一层反代**。
如果你只用桌面版，这个插件对你没有价值，装了也只是多占一个端口。

---

## 工作原理

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

细节：

- **流式不缓冲**：`req.pipe(upstream)` / `up.pipe(res)`，SSE、大文件下载都不会卡住
- **WebSocket**：`upgrade` 事件里用 `net.connect` 手动转发 101，聊天/实时预览都能用
- **长连接超时**：`requestTimeout: 0, headersTimeout: 0`，对齐 nginx 的 3600s
- **请求体上限**：默认 200 MiB，对齐 `client_max_body_size 200m`
- **端口被占不慌**：每 5 秒重试一次，插件加载期**绝不抛异常**（否则宿主崩了连修都没法修）

---

## 安装

```bash
git clone https://github.com/llifco/dsh-plugin-reverse-proxy.git
cd dsh-plugin-reverse-proxy
dsh plugin --profile web add .
```

或者直接用打包好的版本（见 `dist/` 目录）：

```bash
dsh plugin --profile web add ./dsh-plugin-reverse-proxy-0.1.0.tgz
```

装完重启一次宿主：

```bash
systemctl restart dsh
```

然后浏览器打开 `http://<这台机器的局域网IP>:8080`，第一次会让你用 `?token=...` 认证一次。

---

## 配置

全部在 `cordis.patch.yml` 里，按键位和 nginx 指令一一对应：

| 配置项 | 默认值 | 对应 nginx |
|---|---|---|
| `listenHost` | `0.0.0.0` | `listen 8080` |
| `listenPort` | `8080` | 同上 |
| `listenIpv6` | `false` | `listen [::]:8080` |
| `upstreamHost` / `upstreamPort` | `127.0.0.1` / `3080` | `proxy_pass` |
| `upstreamHostHeader` | `127.0.0.1:3080` | `proxy_set_header Host` |
| `upstreamOrigin` | `http://127.0.0.1:3080` | `proxy_set_header Origin` |
| `maxBodyBytes` | `209715200` | `client_max_body_size 200m` |
| `retryMs` | `5000` | —（端口冲突重试间隔） |

想换端口？改 `listenPort` 就行，不用动 nginx。

---

## 卸载 / 回退到 nginx

```bash
dsh plugin --profile web remove dsh-plugin-reverse-proxy
systemctl restart dsh
```

要退回 nginx，把原先那份站点配置重新挂上即可：

```bash
ln -sf /etc/nginx/sites-available/dsh /etc/nginx/sites-enabled/dsh
nginx -t && systemctl reload nginx
```

---

## 常见问题

**Q：装完 8080 还是打不开？**
先看谁在占 8080：`ss -ltnp | grep 8080`。如果还是 nginx，说明旧的 `sites-enabled/dsh` 软链没删，两个会抢端口。

**Q：能穿透公网吗？**
不能，也不建议。它只是把「局域网可访问」这件事做对；要从公网进，请自己加隧道（frp / cloudflared / tailscale 之类）并在那层做鉴权。

**Q：会拖慢页面吗？**
不会。除了改写几个请求头，其余是原样管道转发，实测首页字节数和直连 `3080` 完全一致。

**Q：桌面版能用吗？**
用不上 —— 桌面版就在本机，直连 `127.0.0.1:3080` 即可，反代是给「浏览器跨机器访问」准备的。

---

## 许可

MIT
