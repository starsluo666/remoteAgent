// 快速启动卡片：一键拉起常用 Agent 会话（?new=<cmd> 由 TerminalApp 消费，
// daemon 侧会注入 settings.env 代理等环境变量）。

const CARDS = [
  { cmd: 'codex', ico: '⚡', name: 'Codex', desc: 'OpenAI 编码代理 · 状态实时识别', cls: 'ql-codex' },
  { cmd: 'claude', ico: '🤖', name: 'Claude Code', desc: 'Anthropic 编码代理', cls: 'ql-claude' },
  { cmd: null, ico: '💻', name: '终端', desc: 'PowerShell 普通会话', cls: 'ql-term' },
];

export default function QuickLaunch({ hint }: { hint?: string }) {
  return (
    <div className="quick-launch">
      {CARDS.map((c) => (
        <button
          key={c.name}
          className={`ql-card ${c.cls}`}
          onClick={() => location.assign(`?local=1${c.cmd ? `&new=${c.cmd}` : ''}`)}
        >
          <span className="ql-ico">{c.ico}</span>
          <span className="ql-name">{c.name}</span>
          <span className="ql-desc">{c.desc}</span>
        </button>
      ))}
      {hint && <div className="ql-hint">{hint}</div>}
    </div>
  );
}
