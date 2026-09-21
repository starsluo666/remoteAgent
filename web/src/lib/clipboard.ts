// 剪贴板工具：优先 Async Clipboard API，退化到 execCommand（嵌入式 webview / 部分移动浏览器）。

export function copyText(text: string): Promise<boolean> {
  const legacy = (): boolean => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  };
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).then(
      () => true,
      () => legacy(),
    );
  }
  return Promise.resolve(legacy());
}
