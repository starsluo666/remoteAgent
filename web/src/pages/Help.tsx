// 帮助页：快速上手 / 连接流程 / 排障

export default function HelpPage() {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-title">帮助</div>
          <div className="page-sub">快速上手与常见问题</div>
        </div>
      </div>

      <div className="panel-card">
        <div className="panel-title">三步开始远程</div>
        <ol className="steps">
          <li>在「中继服务」页连接你的中继（没有服务器？见页内自部署指引）</li>
          <li>手机浏览器打开中继网页 →「查看设备」→ 选择本机</li>
          <li>输入访问令牌（设置 → 关于）完成端到端加密握手，进入终端</li>
        </ol>
      </div>

      <div className="panel-card">
        <div className="panel-title">常用操作</div>
        <ul className="security-list">
          <li>📝 多会话：终端页顶部「+」可开多个会话，切换不丢历史</li>
          <li>🔄 断线自动重连（1→30 秒退避），会话画面自动恢复</li>
          <li>🔑 令牌轮换：命令行 <code className="mono">remoteagent-daemon --rotate-access-token</code></li>
          <li>💾 配对记录存在浏览器本地（最多 8 条），清浏览器数据后需重新输入令牌</li>
        </ul>
      </div>

      <div className="panel-card">
        <div className="panel-title">排障</div>
        <ul className="security-list">
          <li>终端空白：强制刷新（Ctrl+F5）清掉旧版前端缓存</li>
          <li>手机连不上：检查 daemon 是否在跑、中继是否在线（概览页状态卡）</li>
          <li>device_busy：v0.1 单观看者，关掉旧的浏览器标签再连</li>
          <li>更多：项目文档 <code className="mono">docs/protocol.md</code>（协议）与 <code className="mono">deploy/DEPLOY.md</code>（部署）</li>
        </ul>
      </div>
    </div>
  );
}
