import { useCallback, useRef, useState } from 'react';

interface H<T> {
  past: T[];
  present: T;
  future: T[];
}

/** Undo/redo. Calls that share a `key` within 700 ms (slider drags) merge into one step. */
export function useHistory<T>(initial: T) {
  const [h, setH] = useState<H<T>>({ past: [], present: initial, future: [] });
  const last = useRef({ key: '', time: 0 });

  const set = useCallback((next: T, key = '') => {
    const now = Date.now();
    const merge = key !== '' && last.current.key === key && now - last.current.time < 700;
    last.current = { key, time: now };
    setH((cur) =>
      merge
        ? { ...cur, present: next, future: [] }
        : { past: [...cur.past.slice(-99), cur.present], present: next, future: [] },
    );
  }, []);

  const undo = useCallback(() => {
    last.current = { key: '', time: 0 };
    setH((cur) =>
      cur.past.length
        ? { past: cur.past.slice(0, -1), present: cur.past[cur.past.length - 1], future: [cur.present, ...cur.future] }
        : cur,
    );
  }, []);

  const redo = useCallback(() => {
    last.current = { key: '', time: 0 };
    setH((cur) =>
      cur.future.length
        ? { past: [...cur.past, cur.present], present: cur.future[0], future: cur.future.slice(1) }
        : cur,
    );
  }, []);

  const reset = useCallback((value: T) => setH({ past: [], present: value, future: [] }), []);

  return { state: h.present, set, undo, redo, reset, canUndo: h.past.length > 0, canRedo: h.future.length > 0 };
}
