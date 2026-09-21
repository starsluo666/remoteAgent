// 中继服务页：连接状态 + 地址配置 + 手机接入说明

import { useState } from 'react';
import type { LocalInfo } from './types';

interface Props {
  local: LocalInfo;
  refresh: () => void;
}

export default function RelayPage({ local, refresh }: Props) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Shell 轮询 local，这里只需触发即时刷新（轮询 5s 内自动跟上）
  const apply = (url: string | null) => {
    setBusy(true);
    setError(null);
    fetch('/api/local/relay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.text()) || '请求失败');
        refresh();
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  const connect = () => {
    const t = input.trim();
    if (!t) {
      setError('请输入中继地址，例如 wss://relay.example.com/ws');
      return;
    }
    apply(/^wss?:\/\//.test(t) ? t : `wss://${t}/ws`);
  };

  const connected = !!local.relayUrl;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-title">中继服务</div>
          <div className="page-sub">经自建中继从外网/手机访问本机，无需公网 IP</div>
        </div>
        {connected && (
          <button className="ghost-btn danger" disabled={busy} onClick={() => apply(null)}>
            断开连接
          </button>
        )}
      </div>

      <div className={`relay-status big ${local.relayOnline ? 'on' : connected ? 'wait' : 'off'}`}>
        <span className="dot" />
        <div className="relay-status-text">
          <div className="relay-url mono">{local.relayUrl ?? '未连接'}</div>
          <div className="relay-note">{local.relayNote}</div>
        </div>
      </div>

      <div className="panel-card">
        <div className="panel-title">{connected ? '更换中继' : '连接中继'}</div>
        <div className="relay-row">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && connect()}
            placeholder="wss://relay.example.com/ws"
            spellCheck={false}
          />
          <button className="mini-btn browse-btn" disabled={busy} onClick={connect}>
            {busy ? '处理中…' : '连接'}
          </button>
        </div>
        <div className="relay-hint">只填域名也行（自动补 wss:// 和 /ws）。公网务必使用 wss（TLS）。</div>
        {error && <div className="connect-error" style={{ marginTop: 10 }}>{error}</div>}
      </div>

      <div className="panel-card">
        <div className="panel-title">部署自己的中继</div>
        <div className="panel-text">
          中继是一个单文件 Go 程序 + 静态网页，无数据库。放到任意服务器：
        </div>
        <pre className="code-block">{`# 服务器上
scp -r deploy/ root@你的服务器:/opt/remoteagent
systemctl enable --now remoteagent-relay   # 详见 deploy/DEPLOY.md
# 然后把 wss://你的域名/ws 填到上面`}</pre>
      </div>

      <div className="panel-card">
        <div className="panel-title">安全性</div>
        <ul className="security-list">
          <li>🔒 会话数据在设备与浏览器间端到端加密（X25519 + AES-256-GCM），中继无法读取</li>
          <li>🔑 连接需要本机访问令牌（设置 → 关于 可查看），令牌不上链路明文</li>
          <li>🌐 公网部署建议套 TLS（Caddy 自动 HTTPS），防止 relay_key 被窃听</li>
        </ul>
      </div>
    </div>
  );
}
