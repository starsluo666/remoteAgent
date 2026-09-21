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

- `role: "daemon"` 用**中继密钥（relay_key）** 注册为房间所有者；`role: "client"` 加入房间（中继不校验客户端身份）。
- **客户端认证在 daemon 侧完成**（§5 的 auth.proof HMAC），accessToken **永不明文上链路**，中继对它一无所知。
- 同一房间已存在 daemon 时，新 daemon 的 hello 被拒绝（`error(device_already_online)`）。
- **v0.1 单 viewer**：房间已有 client 时新加入者被拒（`error(device_busy)`）；M4 多端镜像时放开。

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

## 5. 端到端加密（M3 已实现）

### 5.1 握手（PSK = accessToken，永不明文上链路）

```
client → daemon:  { "t": "auth.proof", "pub": "<b64 X25519 client_pub>",
                    "mac": "<b64 HMAC-SHA256(accessToken, client_pub)>" }
daemon → client:  { "t": "auth.ok",     "pub": "<b64 X25519 daemon_pub>",
                    "mac": "<b64 HMAC-SHA256(accessToken, daemon_pub)>" }
```

- 双向认证：双方各自验证对方 HMAC（中继无私钥、无 token，既不能解密也不能伪造）。
- 会话密钥：`key = HKDF-SHA256(ECDH(client_priv, daemon_pub), salt = daemon_pub || client_pub, info = "remoteagent-payload-v1", len = 32)`
  **盐按角色定序（daemon 在前）**，两端实现必须一致。
- 客户端换人：`auth.proof` 任意时刻可重发，daemon 重新握手并**重置会话密钥**。

### 5.2 enc 信封

```jsonc
{ "t": "enc", "nn": "<base64 12字节 nonce>", "ct": "<base64 AES-256-GCM 密文||tag>" }
```

- §4 所有消息整体作为明文加密；§3 控制层保持明文（relay 必须读）。
- **JSON 键序无关**：判断消息类型必须解析后看 `t` 字段（serde_json 默认按键名排序输出，禁止字符串前缀判断）。
- 认证门：daemon 在收到有效 `auth.proof` 之前，除 `auth.proof`/`ping` 外的消息一律回 `error(auth_required)`；
  建立加密通道后，明文载荷一律丢弃（防降级攻击）。

### 5.3 token 模型（现状）

- `relay_key`：daemon 向中继注册的身份（中继可见），存于 `~/.remoteagent/identity.json`。
- `access_token`：客户端配对凭据，只存在于 daemon 与客户端（配对链接 `?token=`），**只以 HMAC 证明形式上线**。
- 轮换：`remoteagent-daemon --rotate-access-token` 换新后旧配对链接立即失效。

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
