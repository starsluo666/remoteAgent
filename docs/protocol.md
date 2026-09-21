# RemoteAgent 线协议 v1

> 状态：生效中 · 上次更新：2026-09-20
>
> 本文档是 daemon（家里 Rust 守护进程）、relay（Go 中继）、client（Web/桌面客户端）三方共同的契约。
> 改动协议必须先改本文档。

## 1. 总览

```
┌────────┐  WSS(出站)   ┌────────┐   WSS   ┌────────┐
│ daemon │ ───────────► │ relay  │ ◄────── │ client │
└────────┘              └────────┘         └────────┘
```

- relay 按 `deviceId` 组织**房间**：每个设备一个房间，daemon 是房间的所有者，多个 client 可加入（多端镜像在协议上天然支持）。
- daemon 只**出站**连接 relay，无需公网 IP / 端口转发。
- 消息分两层：
  - **控制层**（§3）：relay 必须解析的消息 —— 认证、presence、心跳。
  - **载荷层**（§4）：daemon ↔ client 的端到端消息，relay 原样转发、不解析。
- M3 加密上线后，载荷层整体包进 `enc` 加密信封（§5），relay 依旧只看到密文。

## 2. 传输与编码

- WebSocket，文本帧，UTF-8 JSON。
- 每条消息必有 `"t"`（类型）字段；请求类消息带 `reqId`（客户端自增整数）用于关联应答。
- `hello` 携带 `v`（协议版本），当前 `v: 1`。不兼容版本 relay 返回 `error(unsupported_version)` 并断开。
- **PTY 数据一律 base64 编码**放在 `data` 字段（终端字节流不是合法 UTF-8，base64 避免转码损失）。
- 大小与分块：`output` 每帧 ≤ 64KB（base64 后），daemon 侧每 ~16ms 合并 flush 一次，防止刷屏淹没。
- 心跳：双方每 30s 发 `ping`，60s 未收到即断开重连。

## 3. 控制层消息（relay 解析）

### client/daemon → relay

```jsonc
{ "t": "hello", "v": 1, "role": "daemon" | "client", "deviceId": "uuid", "token": "..." }
{ "t": "ping" }
```

- `role: "daemon"` 用**设备 token** 注册为房间所有者；`role: "client"` 用**访问 token** 加入房间。
- 两种 token 独立签发、独立轮换（PRD §11：中继登录与设备访问分离）。
- 同一房间已存在 daemon 时，新 daemon 的 hello 被拒绝（`error(device_already_online)`）。

### relay → client/daemon

```jsonc
{ "t": "hello_ack", "deviceId": "uuid" }
{ "t": "error", "code": "auth_failed", "msg": "..." }
{ "t": "presence", "deviceId": "uuid", "online": true }
{ "t": "pong" }
```

- `presence` 广播给所有订阅该设备房间的连接（设备列表 UI 用）。

## 4. 载荷层消息（端到端，relay 透传）

### client → daemon：会话管理

```jsonc
{ "t": "session.list",  "reqId": 1 }
{ "t": "session.create","reqId": 2, "cols": 120, "rows": 32, "cwd": "/home/me/proj", "cmd": "claude" }
{ "t": "session.attach","reqId": 3, "sessionId": "s_abc" }
{ "t": "session.kill",  "reqId": 4, "sessionId": "s_abc" }
```

- `cmd` 缺省 = 用户默认 shell；`cwd` 缺省 = 用户主目录。
- `session.attach`：订阅该 session 的实时输出。daemon 回 `session.attached` 并**紧随一条 `snapshot`**（当前环形缓冲全量）。重连恢复、多端镜像补画面都走这一条路径。

### client → daemon：I/O

```jsonc
{ "t": "input",  "sessionId": "s_abc", "data": "<base64>" }
{ "t": "resize", "sessionId": "s_abc", "cols": 100, "rows": 28 }
```

### daemon → client

```jsonc
{ "t": "session.list.result", "reqId": 1,
  "sessions": [ { "id": "s_abc", "cmd": "claude", "cwd": "...", "startedAt": 1695200000,
                  "agent": { "kind": "claude-code", "state": "working" } } ] }

{ "t": "session.created", "reqId": 2, "sessionId": "s_abc" }
{ "t": "session.attached", "reqId": 3, "sessionId": "s_abc" }
{ "t": "output",  "sessionId": "s_abc", "seq": 42, "data": "<base64>" }
{ "t": "snapshot","sessionId": "s_abc", "seq": 43, "data": "<base64>" }   // attach 时全量回放
{ "t": "session.exited", "sessionId": "s_abc", "exitCode": 0 }
{ "t": "agent.state", "sessionId": "s_abc", "kind": "claude-code",
  "state": "idle" | "working" | "waiting", "since": 1695200123 }          // M7 预留
{ "t": "error", "reqId": 2, "code": "session_not_found", "msg": "..." }
```

### 序列号与重连

- `output.seq` 从 1 严格递增（每 session 独立）；client 用于检测丢帧。
- daemon 为每个 session 维护 **200KB 环形缓冲**（已解码的字节流）。
- 客户端 `session.attach` 后 daemon 主动推一条 `snapshot`（当前缓冲全量），随后继续 `output`。
  这一份机制同时满足：断线重连恢复画面、多端镜像新加入者补画面。

## 5. 加密信封（M3 预留，先定形后启用）

```jsonc
{ "t": "enc", "nn": "<base64 12字节 nonce>", "ct": "<base64 AES-256-GCM 密文>" }
```

- 密钥：daemon 与 client 在 hello 之后做 X25519 ECDH 协商（信令明文，会话密钥不出端）。
- 启用后 §4 所有消息整体作为明文加密；§3 控制层保持明文（relay 必须读）。
- seq 不加密不隐藏（relay 需要它做背压统计）→ seq 提升到 `enc` 外层：
  `{ "t": "enc", "seq": 42, "nn": "...", "ct": "..." }`

## 6. 错误码

| code | 含义 | 谁发 |
|---|---|---|
| `auth_failed` | token 无效 | relay |
| `device_already_online` | 房间已有 daemon | relay |
| `device_offline` | 设备不在线 | relay |
| `rate_limited` | 触发限流 | relay |
| `unsupported_version` | 协议版本不兼容 | relay |
| `session_not_found` | 会话不存在 | daemon |
| `spawn_failed` | PTY 创建失败 | daemon |
| `protocol_error` | 消息格式非法 | 双方 |

## 7. 演进策略

- 加字段：兼容，旧端忽略未知字段。
- 改字段语义 / 删字段：升 `v`，relay 拒绝旧版本并提示升级。
- 性能需要时：文本 JSON → 二进制帧（ArrayBuffer + 4 字节头），仅影响 §4，§3 保持 JSON。
