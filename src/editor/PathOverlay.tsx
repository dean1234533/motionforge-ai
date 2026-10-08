import { useRef } from 'react';
import type { Keyframe, SceneObject } from '../scene/schema';

interface Props {
  obj: SceneObject;
  selected: number;
  onSelect: (i: number) => void;
  onChange: (path: Keyframe[], key: string) => void;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const r1 = (n: number) => Math.round(n * 10) / 10;

/** Draggable motion-path handles drawn over the preview. Positions are % of the stage. */
export function PathOverlay({ obj, selected, onSelect, onChange }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const path = obj.path;
  const first = path[0].progress;
  const last = path[path.length - 1].progress;

  const pts: string[] = [];
  for (let i = 0; i <= 60; i++) {
    const p = window.MotionForge.samplePath(path, first + ((last - first) * i) / 60);
    pts.push(`${p.x},${p.y}`);
  }

  const move = (i: number, x: number, y: number, key: string) => {
    onChange(path.map((k, j) => (j === i ? { ...k, x: r1(clamp(x, -40, 140)), y: r1(clamp(y, -40, 140)) } : k)), key);
  };

  const onPointerMove = (i: number) => (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId) || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    move(i, ((e.clientX - r.left) / r.width) * 100, ((e.clientY - r.top) / r.height) * 100, `path-${i}`);
  };

  const onKeyDown = (i: number) => (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const step = e.shiftKey ? 5 : 1;
    const k = path[i];
    if (e.key === 'ArrowLeft') move(i, k.x - step, k.y, `path-${i}`);
    else if (e.key === 'ArrowRight') move(i, k.x + step, k.y, `path-${i}`);
    else if (e.key === 'ArrowUp') move(i, k.x, k.y - step, `path-${i}`);
    else if (e.key === 'ArrowDown') move(i, k.x, k.y + step, `path-${i}`);
    else return;
    e.preventDefault();
  };

  return (
    <div className="overlay" ref={ref}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="overlay-svg" aria-hidden="true">
        <polyline points={pts.join(' ')} fill="none" className="overlay-line" vectorEffect="non-scaling-stroke" />
      </svg>
      {path.map((k, i) => (
        <button
          key={i}
          type="button"
          className={`handle${i === selected ? ' is-selected' : ''}`}
          style={{ left: `${k.x}%`, top: `${k.y}%` }}
          aria-label={`Path point ${i + 1} of ${path.length}. Use arrow keys to move.`}
          onFocus={() => onSelect(i)}
          onPointerDown={(e) => {
            onSelect(i);
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={onPointerMove(i)}
          onKeyDown={onKeyDown(i)}
        >
          {i + 1}
        </button>
      ))}
    </div>
  );
}
