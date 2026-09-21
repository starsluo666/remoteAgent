// 本机面板：daemon 托管页（127.0.0.1:9800）无参数打开时显示。
// 展示本机设备 ID / 访问令牌 / 中继配置 / 配对链接 —— 电脑端"客户端"的身份页。

import { useEffect, useState } from 'react';
import { copyText } from './lib/clipboard';

interface LocalInfo {
  deviceId: string;
  accessToken: string;
  relayUrl: string | null;
  pairingUrl: string | null;
}

export default function LocalPanel() {
  const [info, setInfo] = useState<LocalInfo | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [toastTimer, setToastTimer] = useState<number | undefined>(undefined);

  useEffect(() => {
    fetch('/api/local')
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);

  const showToast = (msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer);
    setToastTimer(window.setTimeout(() => setToast(null), 2400));
  };

  const copy = (text: string, label: string) => {
    void copyText(text).then((ok) => showToast(ok ? `${label}已复制` : `${label}复制失败，请手动选择复制`));
  };

  return (
    <div className="connect-page">
      <div className="connect-card">
        <div className="connect-logo">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 7.5l4 4.5-4 4.5M12 16.5h7" />
          </svg>
        </div>
        <div className="connect-title">本机 RemoteAgent</div>
        <div className="connect-sub">设备身份信息 —— 在其他设备上配对时使用</div>

        {!info ? (
          <div className="connect-error">无法读取本机信息（/api/local），请确认 daemon 正在运行</div>
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
              <div className="info-value mono">
                {showToken ? info.accessToken : '•'.repeat(24)}
              </div>
              <button className="mini-btn" onClick={() => setShowToken(!showToken)}>
                {showToken ? '隐藏' : '显示'}
              </button>
              <button className="mini-btn" onClick={() => copy(info.accessToken, '访问令牌')}>
                复制
              </button>
            </div>

            <div className="info-row">
              <div className="info-label">中继服务</div>
              <div className="info-value mono">{info.relayUrl ?? '未连接'}</div>
            </div>

            {info.pairingUrl ? (
              <div className="info-row">
                <div className="info-label">配对链接</div>
                <div className="info-value mono pair">{info.pairingUrl}</div>
                <button className="mini-btn accent" onClick={() => copy(info.pairingUrl!, '配对链接')}>
                  复制
                </button>
              </div>
            ) : (
              <div className="info-hint">
                未连接中继：用 <code>--relay wss://你的中继域名/ws</code> 启动后，
                手机即可经公网访问本机
              </div>
            )}

            <button
              className="primary-btn connect-go"
              onClick={() => location.assign(`${location.origin}${location.pathname}?local=1`)}
            >
              打开本机终端
            </button>
          </>
        )}

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
