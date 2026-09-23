// 底部弹层手势（移动端）：把手区（顶部 56px）按下拖拽，下滑超过阈值关闭。
// 全局委托实现 —— 所有 .connect-modal-stop 弹窗零侵入获得该能力。
// 仅把手区起始才进入拖拽，弹层内容区的滚动不受影响。

export function initSheetGestures(): void {
  if (matchMedia('(min-width: 761px)').matches) return;

  let sheet: HTMLElement | null = null;
  let startY = 0;
  let dy = 0;
  let dragging = false;

  document.addEventListener(
    'touchstart',
    (e) => {
      const s = (e.target as HTMLElement).closest('.connect-modal-stop') as HTMLElement | null;
      if (!s) return;
      const rect = s.getBoundingClientRect();
      const t = e.touches[0];
      if (t.clientY - rect.top > 56) return; // 把手区之外：正常滚动
      sheet = s;
      startY = t.clientY;
      dy = 0;
      dragging = true;
      s.classList.add('sheet-dragging');
    },
    { passive: true },
  );

  document.addEventListener(
    'touchmove',
    (e) => {
      if (!dragging || !sheet) return;
      dy = e.touches[0].clientY - startY;
      if (dy > 0) sheet.style.transform = `translateY(${dy}px)`;
    },
    { passive: true },
  );

  document.addEventListener('touchend', () => {
    if (!dragging || !sheet) return;
    sheet.classList.remove('sheet-dragging');
    if (dy > 90) {
      sheet.parentElement?.click(); // 触发 overlay 的 onClose
    } else {
      sheet.style.transform = '';
    }
    sheet = null;
    dragging = false;
    dy = 0;
  });
}
