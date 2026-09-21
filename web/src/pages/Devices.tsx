// 设备页：本机 + 中继上可见的其他设备

import { usePoll } from '../lib/usePoll';
import { fetchDevices } from '../lib/target';
import type { DeviceEntry, LocalInfo } from './types';

export default function DevicesPage({ local }: { local: LocalInfo }) {
  const [devices] = usePoll<DeviceEntry[]>(
    () => fetchDevices(local.relayUrl),
    5000,
    [],
    local.relayUrl,
  );

  const others = devices.filter((d) => d.deviceId !== local.deviceId);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-title">设备</div>
          <div className="page-sub">连接到中继的设备，可在任意浏览器远程其终端</div>
        </div>
      </div>

      <div className="ra-table">
        <div className="ra-row head">
          <div className="col-name">设备</div>
          <div className="col-state">状态</div>
          <div className="col-viewers">查看者</div>
          <div className="col-act">操作</div>
        </div>

        <div className="ra-row">
          <div className="col-name">
            <span className="row-ico">🖥️</span>
            <div>
              <div className="row-title">本机设备</div>
              <div className="row-sub mono">{local.deviceId || '—'}</div>
            </div>
          </div>
          <div className="col-state">
            <span className="pill on">运行中</span>
          </div>
          <div className="col-viewers mono">—</div>
          <div className="col-act">
            <button className="mini-btn accent" onClick={() => location.assign('?local=1')}>
              打开终端
            </button>
          </div>
        </div>

        {others.map((d) => (
          <div key={d.deviceId} className="ra-row">
            <div className="col-name">
              <span className="row-ico">🖥️</span>
              <div>
                <div className="row-title mono">{d.deviceId.slice(0, 8)}</div>
                <div className="row-sub mono">{d.deviceId}</div>
              </div>
            </div>
            <div className="col-state">
              <span className={`pill ${d.online ? 'on' : 'off'}`}>{d.online ? '在线' : '离线'}</span>
            </div>
            <div className="col-viewers mono">{d.viewers ?? 0}</div>
            <div className="col-act">
              <span className="row-hint">需该设备的访问令牌</span>
            </div>
          </div>
        ))}
      </div>

      {!local.relayUrl && (
        <div className="info-hint" style={{ marginTop: 14 }}>
          未连接中继 —— 连接后，其他设备会出现在这里。去{' '}
          <button className="linklike" onClick={() => (location.hash = '#/relay')}>
            中继服务
          </button>{' '}
          页配置。
        </div>
      )}
    </div>
  );
}
