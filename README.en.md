<p align="center">
  <img src="assets/logo.jpg" width="132" alt="Da Fei Yu">
</p>

<h1 align="center">dsh-plugin-reverse-proxy</h1>

<p align="center"><a href="README.md">简体中文</a> ｜ English</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="license"></a>
  <a href="https://www.npmjs.com/package/dsh-plugin-reverse-proxy"><img src="https://img.shields.io/npm/v/dsh-plugin-reverse-proxy?label=npm" alt="npm"></a>
  <a href="https://www.npmjs.com/package/dsh-plugin-reverse-proxy"><img src="https://img.shields.io/npm/dm/dsh-plugin-reverse-proxy?label=downloads" alt="downloads"></a>
  <a href="https://github.com/llifco/dsh-plugin-reverse-proxy/releases/latest"><img src="https://img.shields.io/github/v/release/llifco/dsh-plugin-reverse-proxy?label=release" alt="release"></a>
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen.svg" alt="dependencies">
  <img src="https://img.shields.io/badge/build-none-brightgreen.svg" alt="build">
  <a href="#scope"><img src="https://img.shields.io/badge/dsh-0.2.2--rc.1~rc.3-blueviolet.svg" alt="dsh"></a>
  <a href="https://github.com/llifco/dsh-plugin-reverse-proxy/actions"><img src="https://img.shields.io/github/actions/workflow/status/llifco/dsh-plugin-reverse-proxy/publish.yml?label=publish" alt="publish"></a>
  <a href="https://github.com/llifco/dsh-plugin-reverse-proxy/stargazers"><img src="https://img.shields.io/github/stars/llifco/dsh-plugin-reverse-proxy" alt="stars"></a>
  <a href="#community"><img src="https://img.shields.io/badge/QQ%20group-1065464637-12B7F5.svg" alt="QQ group"></a>
</p>

> One command and any device on your LAN — phone, tablet, another laptop — can open your DSH web UI,
> **without copying the random token out of the startup log**.
```bash
dsh plugin --profile web add dsh-plugin-reverse-proxy   # recommended: npm package, no build
```

Then open **Settings → LAN access**: it listens on loopback only by default, flip the switch,
confirm — your phone can connect.
(You can also install from source: `github:llifco/dsh-plugin-reverse-proxy`, see [Install](#install).)


---

## What it looks like

**Settings → LAN access** (off by default; flipping it asks for confirmation first):

<p align="center">
  <img src="assets/settings-lan-access.jpg" width="620" alt="Settings · LAN access">
</p>

No GUI around? The same switch works from a terminal (`yes` is required) — see [Usage](#usage).



**Access IPs and blacklist** (0.5.0+) — hit "Add" to blacklist a device; it then only sees a 403 page:

<p align="center">
  <img src="assets/access-ip.jpg" width="620" alt="Settings · access IPs and blacklist">
</p>

<p align="center">
  <img src="assets/blocked-403.jpg" width="320" alt="403 page shown to a blacklisted device">
</p>
---

## Four capabilities

> Since 0.3.5: the settings switch is purple, and the **listening port** is editable
> (default 8080, applied on save, kept across restarts).

### 1. Reverse proxy (on by default)

```
LAN browser ──▶ 0.0.0.0:8080 (this plugin)
                   │  rewrite headers:
                   │    Host             → 127.0.0.1:3080
                   │    Origin           → http://127.0.0.1:3080
                   │    Sec-Fetch-Site   → same-origin
                   │    Referer          → cleared
                   │  plus: X-Real-IP / X-Forwarded-For / X-Forwarded-Proto
                   ▼
            127.0.0.1:3080 (dsh web itself)
```

`dsh web` binds to loopback only and validates `Host` / `Origin`, so exposing it directly
returns 403. nginx used to rewrite those headers; now the plugin does.

- streaming, no buffering (SSE and large downloads stay smooth)
- WebSocket: hand-rolled 101 tunneling over `net.connect`
- 3600s long-connection timeout to match nginx; 200 MiB request body cap
- retries every 5s when the port is taken; never throws during load

### 2. LAN access switch and port (off by default / 8080)

The proxy only listens on `127.0.0.1:8080` — reachable from **this machine only**.
To share the UI with a phone, tablet or another computer on the same Wi-Fi / LAN you must
explicitly turn it on through one of three entries, all backed by the same state file:

```bash
# terminal
reproxy-lan status     # show state
reproxy-lan enable     # prints the warning, needs the word yes
reproxy-lan disable    # turn off immediately
reproxy-lan port 9000  # change the listening port (1024-65535; 3080 is DSH's own)
```

```
/lan status    /lan yes    /lan no      # or the slash command in the DSH input box
```

or **Settings → 局域网访问 (LAN access)** → flip the switch → confirm the warning dialog.

Terminal example (`status` → `enable` → typing `yes` → listening on `0.0.0.0:8080`):

![reproxy-lan in a terminal](assets/lan-access-cli.jpg)

### Changing the port (default 8080)

The same settings page has a **port** field: type a number → **Save** → the listener is
rebuilt immediately (**no restart needed**) and the value survives restarts.
Rules: 1024–65535, never 3080 (that is DSH itself); an unavailable port returns 409 and
nothing changes.

```
/lan port           show the current port
/lan port 9000      change it (or `reproxy-lan port 9000` over SSH)
```

State lives in `<DSH_HOME>/plugin-reverse-proxy/lan-access.json`
(`{"lanAccess": true, "port": 8080, ...}`), so it survives `systemctl restart dsh`;
edits to that file are picked up within a second (`fs.watch`).

> ⚠️ Once enabled, any device on the same network can open `http://<machine-ip>:8080` and get
> the full back end (sessions, terminal, settings) with no token and no login.
> Only enable it on a network you trust.

---

### 3. Access IPs and blacklist (off by default)

- Lists every device that recently hit the port (IP, last seen, request count).
- **Add** drops that IP into the blacklist; the device then gets a 403 page until you remove it.
- A **blacklist switch** sits right below the list ("no need, do not enable") — turning it off stops blocking but keeps the list.
- Adding the same IP twice is a no-op (`added:false`); loopback and the device you are currently using cannot be blocked (HTTP 400), so you cannot lock yourself out.
- The list is stored in the same state file (`blacklistEnabled`, `blockedIps`) and survives restarts.

**Reset (safety valve for misconfiguration):**

```bash
reproxy-lan reset      # shows what will be restored, then asks you to type yes
```

Or `/lan reset` in chat, confirmed with `/lan reset yes`. Reset turns LAN access off, port back to 8080,
blacklist off and clears the list — devices currently connected over 8080 drop immediately, by design.

### 4. Token-free login (version-gated)

Replaces the official `@deepseek-ai/dsh-client-connection` provider and skips BrowserAuth.

- **web-only**: desktop hosts go dormant (process-tree detection), official behavior untouched
- **strict allowlist**: the runtime and connection packages must both match a known version,
  otherwise it sleeps and the official connection row stays as-is
- **no patching of DSH itself**: only the official plugin patch mechanism is used; remove or
  disable the plugin and everything is back
- covered: `0.1.2-rc.1` `0.1.5-rc.1/rc.2` `0.1.7-rc.1/rc.2` `0.2.0-rc.1/rc.2` `0.2.1-rc.1~rc.5` `0.2.2-rc.1/rc.2/rc.3`

> Based on and partly inlined from [`@iasiv5/dsh-skip-browser-auth`](https://github.com/iasiv5/dsh-skip-browser-auth) (MIT),
> kept under `vendor/skip/` with its LICENSE and NOTICE.

---

## Scope

| Where | Supported |
|---|---|
| **Web UI** (`http://<LAN-IP>:8080`, port configurable, LAN access switch must be on) | ✅ what it is for |
| **Desktop / client app** | ❌ pointless there |

The desktop app runs locally and can hit `127.0.0.1:3080` directly — no proxy, no auth skip needed.

---

## Install

**From npm (easiest; also listed in awesome-dsh-plugin)**

```bash
dsh plugin --profile web add dsh-plugin-reverse-proxy
```

or search `reverse-proxy` in the plugin marketplace and hit Install.

**From source**

```bash
git clone https://github.com/llifco/dsh-plugin-reverse-proxy.git
cd dsh-plugin-reverse-proxy
dsh plugin --profile web add .
```

or use the tarball from the releases page / npm (filename carries the current version):

```bash
dsh plugin --profile web add ./dsh-plugin-reverse-proxy-0.4.3.tgz
# or: https://registry.npmjs.org/dsh-plugin-reverse-proxy/-/dsh-plugin-reverse-proxy-0.4.3.tgz
```

Restart the host once:

```bash
systemctl restart dsh
```

By default it listens on `127.0.0.1:8080` only, so first check `http://127.0.0.1:8080` locally.
To let other devices in, enable the LAN access switch (`reproxy-lan enable`, `/lan yes`, or
Settings → LAN access) and then open `http://<LAN-IP>:8080` — no token.

---

## Configuration

Reverse proxy (the `dsh-plugin-reverse-proxy` row in `cordis.patch.yml`):

| Key | Default | Former nginx directive |
|---|---|---|
| `listenHost` | decided by the LAN switch (default `127.0.0.1`) | `listen 127.0.0.1:8080` |
| `listenPort` | `8080` | same |
| `listenIpv6` | `false` | `listen [::]:8080` |
| `upstreamHost` / `upstreamPort` | `127.0.0.1` / `3080` | `proxy_pass` |
| `upstreamHostHeader` | `127.0.0.1:3080` | `proxy_set_header Host` |
| `upstreamOrigin` | `http://127.0.0.1:3080` | `proxy_set_header Origin` |
| `maxBodyBytes` | `209715200` | `client_max_body_size 200m` |
| `retryMs` | `5000` | — (port-conflict retry) |

`trustedHosts` for the token-free rows is injected by DSH's web runtime; usually no manual edit.

---

## Layout

```
dsh-plugin-reverse-proxy/
├── index.js                  # entry: dispatch by cordis row id (proxy / skip-auth)
├── cordis.patch.yml          # official patch: version gate + the capability rows
├── assets/logo.jpg           # repo avatar
├── vendor/skip/              # token-free implementation (MIT, from dsh-skip-browser-auth)
│   ├── host.js  gate.js  compatibility.js
│   ├── trust-fence.js  trusted-auth.js  bridge.js
│   ├── connection-runtime.js
│   ├── adapters/             # carrier-neutral / -017 / -021
│   └── client.js             # prebuilt browser bundle
├── dist/*.tgz                # packaged builds (offline install)
├── CHANGELOG.md
├── README.md / README.en.md
└── LICENSE
```

---

## Uninstall / roll back to nginx

```bash
dsh plugin --profile web remove dsh-plugin-reverse-proxy
systemctl restart dsh
```

Back to nginx:

```bash
ln -sf /etc/nginx/sites-available/dsh /etc/nginx/sites-enabled/dsh
nginx -t && systemctl reload nginx
```

---

## FAQ

**Only this machine can open it; my phone cannot?**
That is the 0.3.2+ default (`127.0.0.1` only). Enable the switch — `reproxy-lan enable`,
`/lan yes`, or Settings → LAN access. `ss -ltnp | grep 8080` should then show `0.0.0.0:8080`.

**Port 8080 still dead after install?**
`ss -ltnp | grep 8080` — if nginx still owns it, the old `sites-enabled/dsh` symlink is still there.

**It asks for a token again?**
The skip-auth half went dormant, usually because DSH was upgraded past the allowlist.
Check the log for `BrowserAuth has been skipped`; absent means dormant (official behavior).

**Can it reach the internet?**
No, and it should not. It only makes LAN access work; add your own tunnel plus auth.

**Does the desktop app use it?**
No — connect to `127.0.0.1:3080` directly.

**Q: Opening a second window on the same device shows a blank page and no chat history?**

Fixed in 0.3.6. Without an identity layer every browser request shares one
`browserPeer`, and a Peer serves only the stream bound to it — the second
window's stream competed for the same endpoints and waited forever until every
window was closed. Each mux connection now mints its own Peer. Look for
`[reproxy-lan] per-socket peers enabled (multi-window)` in the log to confirm.

---

## Feedback

- Bugs / feature requests: **QQ 3538638569** (3538638569@qq.com)
- Include `dsh --version`, `dsh plugin --profile web list` and the relevant log lines.

## License

MIT (`vendor/skip/` code comes from @iasiv5/dsh-skip-browser-auth, also MIT).

**Q: A second tab on the same device stays on a spinner?**

**Known limitation: multiple tabs of the same browser are not supported yet.** The second tab
spins forever and shows an empty session list; closing the other tabs (or a network reconnect)
recovers it. One tab per device, or one of them in a private window, works fine.

Cause is upstream: one browser cookie = one Peer = one answering event stream, and the gateway
routes events to the single live client rather than per tab. 0.4.x already gives each tab its own
identity (`x-dsh-tab` header plus `?tab=` on the mux — visible as `http tab ...` / `mux admit ...`
in the log), but the gateway still accepts only one answering stream, so the plugin cannot work
around it.

---

## Community

Questions, ideas and war stories: **QQ group 1065464637**.

For bugs, please open an [Issue](https://github.com/llifco/dsh-plugin-reverse-proxy/issues/new/choose) — the template asks for your DSH version, switch state and logs, which is far faster than guessing.
