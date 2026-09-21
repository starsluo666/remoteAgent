# RemoteAgent 桌面客户端（Tauri 2）

复用 `web/dist` 作前端；exe 打开即拉起同目录的 `remoteagent-daemon.exe`
（externalBin sidecar）——本机成为中继上的可被控设备，面板里「连接其他设备」
反向控制其他机器。9800 端口已被占用时自动复用现有 daemon；关窗不杀 daemon。

## 构建（Windows / MSVC）

```bash
# 1. 前端
cd web && npm run build
# 2. daemon（sidecar 需带目标三元组后缀）
cargo +stable-x86_64-pc-windows-msvc build --release --manifest-path daemon/Cargo.toml
mkdir -p desktop-tauri/src-tauri/binaries
cp daemon/target/release/remoteagent-daemon.exe \
   desktop-tauri/src-tauri/binaries/remoteagent-daemon-x86_64-pc-windows-msvc.exe
# 3. 桌面壳（用国内镜像时必须 unset 代理，二者冲突）
cd desktop-tauri && env -u HTTP_PROXY -u HTTPS_PROXY \
  RUSTUP_DIST_SERVER=https://rsproxy.cn RUSTUP_UPDATE_ROOT=https://rsproxy.cn/rustup \
  npx tauri build
```

产物：`src-tauri/target/release/remoteagent-desktop.exe`（独立）+
`target/release/bundle/nsis/RemoteAgent_0.1.0_x64-setup.exe`（安装包）。
daemon 日志：`%TEMP%\remoteagent-daemon.log`。
