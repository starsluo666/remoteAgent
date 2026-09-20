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
# relay（默认 :8080）
cd relay && go run .

# daemon（M1 起本地模式 :9800，M2 起连中继）
cd daemon && cargo run

# web
cd web && npm install && npm run dev
```

## 路线（v0.1）

- [ ] M0 骨架 + 协议
- [ ] M1 本地全链路（PTY ↔ xterm.js，不经中继）
- [ ] M2 中继 + 出站连接
- [ ] M3 TLS + token 分离 + 端到端加密
- [ ] M4 多 session + 设备列表
- [ ] M5 手动接管 / 暂停
- [ ] M6 稳定性（重连 / scrollback / 移动端触控）
- [ ] M7 AI session 识别 + Quick Chips

## License（计划）

Apache 2.0（daemon / 客户端）+ AGPL-3.0（relay）。
