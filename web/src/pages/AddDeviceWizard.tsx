// 添加设备向导（对齐设计稿）：三步指示 + 二维码配对 / 粘贴配对码 / SSH 命令。
// 二维码编码真实配对链接（中继网页地址 + device + token）；短配对码待协议支持。

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { copyText } from '../lib/clipboard';
import { relayHttpBase } from '../lib/target';
import type { LocalInfo } from './types';

type TabId = 'qr' | 'code' | 'ssh';

const TABS: { id: TabId; label: string }[] = [
  { id: 'qr', label: '二维码配对' },
  { id: 'code', label: '粘贴配对码' },
  { id: 'ssh', label: 'SSH 命令' },
];

export default function AddDeviceWizard({ local, onClose }: { local: LocalInfo; onClose: () => void }) {
  const [tab, setTab] = useState<TabId>('qr');
  const [qrData, setQrData] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const relayOk = !!local.relayUrl;
  const relayWeb = local.relayUrl ? `${relayHttpBase(local.relayUrl)}/` : null;
  // fragment 格式：token 不随 HTTP 请求发给中继（不进访问日志）
  const pairUrl = relayWeb && local.deviceId
    ? `${relayWeb}#device=${local.deviceId}&token=${local.accessToken}`
    : null;

  useEffect(() => {
    if (tab === 'qr' && pairUrl && !qrData) {
      QRCode.toDataURL(pairUrl, {
        width: 320,
        margin: 1,
        errorCorrectionLevel: 'M',
        color: { dark: '#0a0c10', light: '#ffffff' },
      })
        .then(setQrData)
        .catch(() => setQrData(null));
    }
  }, [tab, pairUrl, qrData]);

  const copy = (text: string, label: string) => {
    void copyText(text).then((ok) => {
      setCopied(ok ? `${label}已复制` : `${label}复制失败`);
      window.setTimeout(() => setCopied(null), 2000);
    });
  };

  return (
    <div className="connect-overlay" onClick={onClose}>
      <div className="wizard" onClick={(e) => e.stopPropagation()}>
        <div className="wizard-breadcrumb">
          设备 / <span className="accent">本机配对码</span>
          <button className="mini-btn" style={{ marginLeft: 'auto' }} onClick={onClose}>
            取消
          </button>
        </div>

        <div className="wizard-steps">
          <div className="w-step done">
            <span className="w-num">1</span> 选择类型
          </div>
          <div className="w-line" />
          <div className="w-step cur">
            <span className="w-num">2</span> 设备配对
          </div>
          <div className="w-line" />
          <div className="w-step">
            <span className="w-num">3</span> 完成
          </div>
        </div>

        <div className="wizard-tabs">
          {TABS.map((t) => (
            <button key={t.id} className={`w-tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>

        {!relayOk ? (
          <div className="wizard-body">
            <div className="info-hint">
              需要先连接中继服务才能生成配对信息。到{' '}
              <button className="linklike" onClick={() => (location.hash = '#/relay')}>
                中继服务
              </button>{' '}
              页完成连接后再来添加设备。
            </div>
          </div>
        ) : tab === 'qr' ? (
          <div className="wizard-body qr">
            <div className="qr-box">
              {qrData ? <img src={qrData} alt="配对二维码" /> : <div className="qr-loading">生成中…</div>}
            </div>
            <div className="qr-side">
              <div className="qr-title">扫码添加这台电脑</div>
              <div className="qr-sub">
                手机浏览器打开「{relayWeb}」，或直接扫描左边的二维码，
                扫码后输入设备号与访问令牌（或直接打开配对链接）。
              </div>
              <div className="pair-row">
                <span className="pair-label">设备号</span>
                <span className="mono pair-value">{local.deviceId}</span>
                <button className="mini-btn" onClick={() => copy(local.deviceId, '设备号')}>复制</button>
              </div>
              <div className="pair-row">
                <span className="pair-label">访问令牌</span>
                <span className="mono pair-value">••••••••••••</span>
                <button className="mini-btn" onClick={() => copy(local.accessToken, '访问令牌')}>复制</button>
              </div>
              <div className="pair-row">
                <span className="pair-label">短配对码</span>
                <span className="mono pair-value dim">RA-····-····</span>
                <span className="soon-pill">即将支持</span>
              </div>
              {copied && <div className="relay-hint accent">{copied}</div>}
            </div>
          </div>
        ) : tab === 'code' ? (
          <div className="wizard-body">
            <div className="qr-title">把配对信息发给手机</div>
            <div className="qr-sub">在手机浏览器打开下面的链接，或粘贴到任意设备的 RemoteAgent 连接页：</div>
            <pre className="code-block">{pairUrl}</pre>
            <div style={{ display: 'flex', gap: 9, marginTop: 10 }}>
              <button className="primary-btn" onClick={() => pairUrl && copy(pairUrl, '配对链接')}>
                复制配对链接
              </button>
              <button className="ghost-btn" onClick={() => copy(local.accessToken, '访问令牌')}>
                只复制令牌
              </button>
            </div>
            {copied && <div className="relay-hint accent">{copied}</div>}
          </div>
        ) : (
          <div className="wizard-body">
            <div className="qr-title">在被控电脑上安装 daemon</div>
            <div className="qr-sub">对家里的另一台机器，用命令行接入同一个中继：</div>
            <pre className="code-block">{`# 1) 下载 remoteagent-daemon（GitHub Releases 或自托管）
# 2) 启动并连接到你的中继
remoteagent-daemon --relay ${local.relayUrl}
# 3) 在该机器的 127.0.0.1:9800 面板拿到设备 ID 与访问令牌
# 4) 回到本页「设备 → 添加新设备」完成接入`}</pre>
            <div className="relay-hint">
              首次运行会自动生成设备身份（~/.remoteagent/identity.json）。
            </div>
          </div>
        )}

        <div className="wizard-other">
          <div className="wizard-other-title">其他添加方式</div>
          <div className="other-grid">
            <button className="other-card" onClick={() => setTab('ssh')}>
              <span className="oc-ico">⌨️</span>
              <div>
                <div className="oc-title">SSH 命令行</div>
                <div className="oc-sub">在服务器 / 家里电脑上执行</div>
              </div>
            </button>
            <button className="other-card" onClick={() => setTab('code')}>
              <span className="oc-ico">🔗</span>
              <div>
                <div className="oc-title">粘贴配对码</div>
                <div className="oc-sub">跨设备发送完整配对链接</div>
              </div>
            </button>
            <button className="other-card" onClick={() => setTab('qr')}>
              <span className="oc-ico">📷</span>
              <div>
                <div className="oc-title">二维码</div>
                <div className="oc-sub">手机扫码直接进入</div>
              </div>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
