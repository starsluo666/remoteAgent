// 页面间共享类型

export interface RelayConfig {
  name: string;
  url: string;
}

export interface LocalInfo {
  deviceId: string;
  accessToken: string;
  relayUrl: string | null;
  relayName: string;
  relayOnline: boolean;
  relayNote: string;
  relayConnectedAt: number;
  relayViewers: number | null;
  relays: RelayConfig[];
  activeRelay: string | null;
  autostart?: boolean;
}

export interface DeviceEntry {
  deviceId: string;
  online: boolean;
  viewers?: number;
}

export interface SessionRow {
  id: string;
  cmd: string;
  startedAt: number;
  agent?: string;
  agentStatus?: string;
  agentDetail?: string;
}
