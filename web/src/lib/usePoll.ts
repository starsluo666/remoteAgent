// 轮询数据 hook：页面级 REST 数据定期刷新（失败静默，保留下次结果）
// restartKey 变化时立即重跑一轮（例如 relayUrl 就位后马上拉设备列表）

import { useEffect, useRef, useState } from 'react';

export function usePoll<T>(
  fn: () => Promise<T>,
  ms: number,
  initial: T,
  restartKey?: unknown,
): [T, () => void] {
  const [data, setData] = useState<T>(initial);
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  }, [fn]);

  useEffect(() => {
    let alive = true;
    const run = () =>
      fnRef
        .current()
        .then((d) => {
          if (alive) setData(d);
        })
        .catch(() => {});
    run();
    const timer = window.setInterval(run, ms);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [ms, restartKey]);

  const refresh = () =>
    fnRef
      .current()
      .then(setData)
      .catch(() => {});
  return [data, refresh];
}
