# RemoteAgent

为 AI Agent 时代打造的极简远程终端：家里一行命令装好 daemon，出门用手机浏览器 / 任何电脑接管家里正在跑的 Claude Code、Codex、Aider。

PRD 见 `../RemoteAgent PRD v0.1 · 完整产品需求文档（18 章）`。

## 仓库结构

| 目录 | 内容 | 技术栈 |
|---|---|---|
| `relay/` | 自托管中继服务器（WebSocket 房间转发） | Go |
| `daemon/` | 家里端守护进程（持 PTY，出站连中继） | Rust |
| `web/` | 客户端（浏览器 / 日后 Tauri 壳复用） | React + TS + xterm.js |
| `docs/` | 协议与设计文档 | — |

**先读 [docs/protocol.md](docs/protocol.md)** —— 它是三方共同的线协议契约。

## 开发

```bash
# relay（默认 0.0.0.0:8080，同时托管 web 页面）
cd relay && go run . -web ../web/dist

# daemon 本地模式（127.0.0.1:9800，浏览器直连）
cd daemon && cargo run

# daemon 中继模式（出站连接 relay，手机/外网经中继访问）
cd daemon && cargo run -- --relay ws://<relay-host>:8080/ws
# 启动后日志会打印配对链接：http://<relay-host>:8080/?device=<id>&token=<t>

# web（开发模式，/ws 代理到本地 daemon）
cd web && npm install && npm run dev

# smoke 测试
cd web && node scripts/smoke-relay.mjs              # 中继逻辑（假 daemon + 假 client）
cd web && node scripts/smoke-ws.mjs                 # 端到端（本地模式）
cd web && node scripts/smoke-ws.mjs ws://127.0.0.1:8080/ws <deviceId> <token>   # 端到端（经中继）
```

## 路线（v0.1）

- [x] M0 骨架 + 协议
- [x] M1 本地全链路（PTY ↔ xterm.js，不经中继）
- [x] M2 中继 + 出站连接
- [x] M3 端到端加密 + token 分离（TLS 部署项顺延：自托管公网暴露时启用）
- [ ] M4 多 session + 设备列表
- [ ] M5 手动接管 / 暂停
- [ ] M6 稳定性（重连 / scrollback / 移动端触控）
- [ ] M7 AI session 识别 + Quick Chips

## License（计划）

Apache 2.0（daemon / 客户端）+ AGPL-3.0（relay）。
