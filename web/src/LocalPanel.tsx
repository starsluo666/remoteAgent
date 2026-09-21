// 本机面板：daemon 托管页（127.0.0.1:9800）无参数打开时显示。
// 设备身份（ID/令牌）+ 中继服务连接（主操作）。参考设备管理类客户端的页面逻辑。

import { useCallback, useEffect, useRef, useState } from 'react';
import { copyText } from './lib/clipboard';

interface LocalInfo {
  deviceId: string;
  accessToken: string;
  relayUrl: string | null;
  relayOnline: boolean;
  relayNote: string;
}

export default function LocalPanel() {
  const [info, setInfo] = useState<LocalInfo | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [relayInput, setRelayInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  const showToast = (msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2400);
  };

  const refresh = useCallback(() => {
    return fetch('/api/local')
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: LocalInfo) => setInfo(d))
      .catch(() => setInfo(null));
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const copy = (text: string, label: string) => {
    void copyText(text).then((ok) => showToast(ok ? `${label}已复制` : `${label}复制失败，请手动复制`));
  };

  // 连接 / 断开中继
  const applyRelay = (url: string | null) => {
    setBusy(true);
    setError(null);
    fetch('/api/local/relay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.text()) || '请求失败');
        await refresh();
        showToast(url ? '正在连接中继…' : '已断开中继');
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  const connectRelay = () => {
    const t = relayInput.trim();
    if (!t) {
      setError('请输入中继地址，例如 wss://relay.example.com/ws');
      return;
    }
    applyRelay(/^wss?:\/\//.test(t) ? t : `wss://${t}/ws`);
  };

  const connected = !!info?.relayUrl;

  return (
    <div className="connect-page">
      <div className="connect-card">
        <div className="connect-logo">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 7.5l4 4.5-4 4.5M12 16.5h7" />
          </svg>
        </div>
        <div className="connect-title">本机 RemoteAgent</div>
        <div className="connect-sub">连接中继后，即可从手机或其他设备远程本机终端</div>

        {/* 中继服务：主操作 */}
        <div className="relay-block">
          <div className="section-title">中继服务</div>

          <div className={`relay-status ${info ? (info.relayOnline ? 'on' : connected ? 'wait' : 'off') : 'off'}`}>
            <span className="dot" />
            <div className="relay-status-text">
              <div className="relay-url mono">{info?.relayUrl ?? '未连接'}</div>
              <div className="relay-note">{info?.relayNote ?? (info ? '未连接' : '读取中…')}</div>
            </div>
            {connected && (
              <button className="mini-btn danger" disabled={busy} onClick={() => applyRelay(null)}>
                断开
              </button>
            )}
          </div>

          <div className="relay-row">
            <input
              value={relayInput}
              onChange={(e) => setRelayInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && connectRelay()}
              placeholder="wss://relay.example.com/ws"
              spellCheck={false}
            />
            <button className="mini-btn browse-btn" disabled={busy} onClick={connectRelay}>
              {busy ? '处理中…' : connected ? '连接' : '连接'}
            </button>
          </div>
          <div className="relay-hint">连接后配置会保存，daemon 重启自动恢复</div>
        </div>

        {error && <div className="connect-error">{error}</div>}

        {/* 设备身份：供其他设备连接时使用 */}
        <div className="section-title" style={{ marginTop: 18 }}>
          设备身份
        </div>
        {!info ? (
          <div className="info-hint">无法读取本机信息（/api/local），请确认 daemon 正在运行</div>
        ) : (
          <>
            <div className="info-row">
              <div className="info-label">设备 ID</div>
              <div className="info-value mono">{info.deviceId}</div>
              <button className="mini-btn" onClick={() => copy(info.deviceId, '设备 ID')}>
                复制
              </button>
            </div>

            <div className="info-row">
              <div className="info-label">访问令牌</div>
              <div className="info-value mono">{showToken ? info.accessToken : '•'.repeat(24)}</div>
              <button className="mini-btn" onClick={() => setShowToken(!showToken)}>
                {showToken ? '隐藏' : '显示'}
              </button>
              <button className="mini-btn" onClick={() => copy(info.accessToken, '访问令牌')}>
                复制
              </button>
            </div>
            <div className="relay-hint">手机端：打开中继网页 → 查看设备 → 选本机 → 输入访问令牌</div>
          </>
        )}

        <button
          className="local-link"
          onClick={() => location.assign(`${location.origin}${location.pathname}?local=1`)}
        >
          打开本机终端
        </button>

        <div className="connect-foot">🔒 会话数据端到端加密，中继与外网无法读取</div>
      </div>

      {toast && (
        <div className="toast">
          <span className="toast-bar" />
          {toast}
        </div>
      )}
    </div>
  );
}
