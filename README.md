# RemoteAgent

**人在外面，遥控家里的 AI 终端。** 家用电脑跑一个 daemon 托管 PTY（Codex / Claude Code / 任意 shell），手机或浏览器经自建中继连回来：看输出、发输入、感知 AI 会话状态。全程端到端加密，中继零信任 —— 它不知道你的令牌，也读不到任何会话内容。

PRD 见 `../RemoteAgent PRD v0.1 · 完整产品需求文档（18 章）`；线协议契约先读 [docs/protocol.md](docs/protocol.md)。

```
┌─────────┐   wss   ┌─────────┐   ws(出站)  ┌──────────┐
│ 手机/浏览器 │ ◄─────► │  relay   │ ◄────────── │  daemon   │
│ (PWA/exe) │         │ (自建)    │             │ (家里电脑) │
└─────────┘         └─────────┘             └──────────┘
                        │                        │
                 不存内容·不枚举设备            ConPTY + Codex
                                                状态识别
```

## 仓库结构

| 目录 | 内容 | 技术栈 |
|---|---|---|
| `daemon/` | 家里端守护进程：ConPTY 会话管理、Codex 状态识别（M7）、本机面板（127.0.0.1:9800） | Rust |
| `relay/` | 自托管中继：WebSocket 房间转发 + 静态托管 web 客户端；不持久化、不读密文 | Go |
| `web/` | 客户端：xterm 终端、面板、连接页；同时是 relay 静态资源与桌面壳前端 | React + TS + xterm.js |
| `desktop-tauri/` | Tauri 2 桌面客户端（Windows NSIS 安装包）；exe 打开即拉起内嵌 daemon，双向：既是面板也是被控节点 | Rust + Tauri 2 |
| `deploy/` | 服务器部署：Linux 二进制、systemd 单元、Caddyfile、DEPLOY.md | — |
| `docs/` | 协议与设计文档 | — |

## 安全模型（一句话版）

**中继上没有任何可枚举的东西，连接的唯一入口是配对链接（9 位设备号 + 访问令牌）。**

- 设备注册需 `relay_key`（中继准入，一台中继一把）；查看端凭配对令牌与 daemon 完成 X25519 + HMAC 握手，之后全部载荷 AES-256-GCM 端到端加密
- 访问令牌可自定义（≥8 位，面板概览页直接编辑，热生效，旧配对立即失效）；E2E 握手证明可被离线爆破，弱口令会降低门槛，建议混合字符
- 本机面板仅监听 127.0.0.1，Host 白名单 + tauri.localhost CORS 白名单双门槛

## 快速开始

**家里电脑（Windows）**：装 `desktop-tauri` 产出的 NSIS 安装包，打开 exe 即自动拉起 daemon 并恢复中继连接；「设置 → 常规」可开**开机自启**（登录即在线，隐藏窗口无感运行）。

**中继（Linux 服务器）**：见 [deploy/DEPLOY.md](deploy/DEPLOY.md) —— 二进制 + systemd + `-relay-key <key>`；daemon 侧 `~/.remoteagent/identity.json` 的 `relay_key` 必须与之一致。

**手机**：家里面板「概览」页复制**配对链接**发到手机，浏览器打开即连（建议「添加到主屏幕」作 PWA）。

## 开发

```bash
# relay（默认 0.0.0.0:8080，同时托管 web 页面）
cd relay && go run . -web ../web/dist

# daemon 本地模式（127.0.0.1:9800，浏览器直连）
cd daemon && cargo run

# daemon 中继模式（出站连接 relay，手机/外网经中继访问）
cd daemon && cargo run -- --relay ws://<relay-host>:8080/ws

# web（开发模式，/ws 代理到本地 daemon）
cd web && npm install && npm run dev

# 桌面客户端（详见 desktop-tauri/README.md，国内镜像需 unset 代理）
cd desktop-tauri && npx tauri build
```

## 冒烟测试

```bash
cd web
node scripts/smoke-relay.mjs [relayUrl] [relayKey]   # 中继逻辑（假 daemon + 假 client）
node scripts/smoke-ws.mjs                            # 端到端（本地模式）
node scripts/check-token.mjs <token> [relayUrl]      # 配对令牌握手验证（@noble，与生产同源）
```

## 路线（v0.1）

- [x] M0-M4 骨架 / 协议 / 本地全链路 / 中继出站 / E2E 加密 / 多会话
- [x] M5-M6 手动接管、观察模式、断线自愈、移动端适配
- [x] M7 Codex 会话状态识别（输出流状态机，交互式 TUI 与 exec 双模式）
- [x] 桌面客户端（Tauri 双向 exe）+ PWA + 公网部署 + 开机自启
- [x] 全私有中继（无设备枚举）+ 自定义令牌 + 9 位设备号
- [ ] 会话持久化（daemon 重启后恢复）
- [ ] Claude Code / Aider 识别规则
- [ ] 多观看端镜像

## License

Apache 2.0（daemon / web）+ AGPL-3.0（relay）。
