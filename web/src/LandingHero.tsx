// 中继站点首页（对齐设计稿落地页）：Hero + 功能卡 + CTA 进入连接页。

export default function LandingHero({ onEnter }: { onEnter: () => void }) {
  return (
    <div className="hero-page">
      <div className="hero-frame">
        <nav className="hero-nav">
          <div className="hero-brand">
            <div className="logo">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 7.5l4 4.5-4 4.5M12 16.5h7" />
              </svg>
            </div>
            <span className="hero-brand-name">RemoteAgent</span>
            <span className="hero-ver">v0.1</span>
          </div>
          <button className="hero-cta" onClick={onEnter}>
            连接到设备 →
          </button>
        </nav>

        <div className="hero-main">
          <div className="hero-copy">
            <div className="hero-badge">开源 · 自托管 · 零信任</div>
            <h1 className="hero-title">
              让 AI Agent
              <br />
              成为你的随身副驾
            </h1>
            <p className="hero-sub">
              家里电脑跑着 Claude Code / Aider？RemoteAgent 把终端装进手机浏览器 ——
              自建中继转发、端到端加密，中继也读不到你的会话。
            </p>
            <div className="hero-actions">
              <button className="hero-cta big" onClick={onEnter}>
                连接到设备
              </button>
              <span className="hero-hint">需要设备 ID + 访问令牌（在本机 127.0.0.1:9800 查看）</span>
            </div>
          </div>
          <div className="hero-art">
            <div className="hero-term">
              <div className="ht-bar">
                <span className="ht-dot r" />
                <span className="ht-dot y" />
                <span className="ht-dot g" />
                <span className="ht-title">claude · 家里电脑</span>
              </div>
              <pre className="ht-body">{`$ claude "重构支付模块"

⏺ Reading src/pay/…
⏺ Edits: 4 files (+82 −31)

⏺ Ready to commit
  ● run tests  ● explain  ● keep going`}</pre>
              <div className="ht-chip">📱 手机上看着，随时接管</div>
            </div>
          </div>
        </div>

        <div className="hero-cards">
          <div className="hero-card">
            <div className="hc-ico">🔒</div>
            <div className="hc-title">端到端加密</div>
            <div className="hc-sub">X25519 + AES-256-GCM，令牌不落链路，中继零知识转发</div>
          </div>
          <div className="hero-card">
            <div className="hc-ico">🌐</div>
            <div className="hc-title">自建中继</div>
            <div className="hc-sub">单文件 Go 程序，无数据库；家里无需公网 IP</div>
          </div>
          <div className="hero-card">
            <div className="hc-ico">🤖</div>
            <div className="hc-title">AI 会话感知</div>
            <div className="hc-sub">识别 Agent 状态、Token 消耗与快捷接管（即将支持）</div>
          </div>
        </div>

        <footer className="hero-foot">
          RemoteAgent v0.1 · 自托管远程终端 · 会话数据端到端加密
        </footer>
      </div>
    </div>
  );
}
