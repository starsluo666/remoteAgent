// 页面间共享类型

export interface LocalInfo {
  deviceId: string;
  accessToken: string;
  relayUrl: string | null;
  relayOnline: boolean;
  relayNote: string;
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
}
