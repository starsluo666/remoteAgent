// Tauri 桌面壳适配：壳的源是 tauri.localhost / tauri: 自定义协议，
// 相对路径打不到本机 daemon（127.0.0.1:9800），需改走绝对地址（daemon 侧已对该源开 CORS）。
// Android 端例外：手机是纯控制端，本机没有 daemon —— 必须按"远程站点"语义走相对路径。

const isAndroid = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
const inTauri =
  !isAndroid && (/^tauri:/i.test(location.protocol) || location.hostname === 'tauri.localhost');

/** 本机 daemon HTTP 基址：浏览器部署为同源 ''，桌面壳为绝对地址 */
export const LOCAL_BASE = inTauri ? 'http://127.0.0.1:9800' : '';

/** 本机 daemon WS 地址：桌面壳下不能用 location.host（tauri.localhost 不承载 WS） */
export const LOCAL_WS = inTauri ? 'ws://127.0.0.1:9800/ws' : '';

/** 本机 API 路径拼接 */
export const localApi = (path: string) => `${LOCAL_BASE}${path}`;
