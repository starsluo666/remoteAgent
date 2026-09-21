# RemoteAgent 中继部署指南

中继 = 一个静态 Go 二进制 + 网页静态文件，无数据库、无其他依赖。

## 包内容

```
relay-linux-amd64    Linux x86_64（绝大多数云服务器）
relay-linux-arm64    Linux ARM64（如树莓派 / ARM 云主机）
web/                 网页端静态文件（含配对页）
remoteagent-relay.service   systemd 服务模板
Caddyfile            Caddy 反代配置（自动 HTTPS，强烈推荐）
```

## 一、上传

在本机执行（换成你的服务器地址和用户）：

```bash
scp -r deploy/ root@你的服务器IP:/opt/remoteagent
```

> 若用 ARM 机器：`mv /opt/remoteagent/relay-linux-arm64 /opt/remoteagent/relay`

## 二、 systemd 常驻

```bash
ssh root@你的服务器IP

# 选一个架构的二进制作为正式名字
mv /opt/remoteagent/relay-linux-amd64 /opt/remoteagent/relay
chmod +x /opt/remoteagent/relay

cp /opt/remoteagent/remoteagent-relay.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now remoteagent-relay
systemctl status remoteagent-relay    # 应显示 active (running)
curl http://127.0.0.1:8080/health     # 应返回 OK
```

## 三、公网访问（两种方式选一）

### 方式 A：有域名 → Caddy 自动 HTTPS（推荐）

会话内容本身有端到端加密保护，但 daemon 的 relay_key 在控制层是明文传输的，
**公网必须上 TLS**，否则 relay_key 可能被窃听者拿去顶替你的设备。

```bash
# 域名 DNS A 记录指到服务器 IP 后：
apt install -y caddy
cp /opt/remoteagent/Caddyfile /etc/caddy/
# 编辑 /etc/caddy/Caddyfile，把 relay.example.com 换成你的域名
systemctl reload caddy
```

完成后：
- 网页端：`https://relay.example.com`
- 家里 daemon 启动：`remoteagent-daemon.exe --relay wss://relay.example.com/ws`

### 方式 B：没有域名（临时/内网）

直接开放 8080 端口（防火墙/安全组放行）：

```bash
# daemon 侧用 ws://
remoteagent-daemon.exe --relay ws://服务器IP:8080/ws
```

⚠️ 明文公网有 relay_key 被窃听的风险（会话内容仍受 E2E 保护），
仅建议内网/测试用，公网尽快上 TLS。

## 四、日常运维

```bash
journalctl -u remoteagent-relay -f          # 看日志（设备注册/转发/断开）
systemctl restart remoteagent-relay         # 重启（daemon 会自动重连，1-30s 退避）
```

## 验证清单

1. `https://域名/health` → OK
2. 家里启动 daemon（带 `--relay wss://...`），日志出现 `registered at relay`
3. 打开 `https://域名/?device=<id>&token=<t>`，看到「在线」徽章和终端

## 五、公网必配：relay-key 白名单

任何人连上你的中继都能尝试注册任意 deviceId。配置 `-relay-key`（或环境变量
`REMOTEAGENT_RELAY_KEY`）后，只有持有正确密钥的 daemon 能注册：

```bash
# 密钥在家里 daemon 的 ~/.remoteagent/identity.json → relay_key 字段
# systemd：改 /etc/systemd/system/remoteagent-relay.service 的 -relay-key 参数后
systemctl daemon-reload && systemctl restart remoteagent-relay
# 验证：中继日志出现 "relay-key allowlist enabled"
```

不配置时中继会打印 WARNING —— 本地/内网开发可忽略，公网必须配。
