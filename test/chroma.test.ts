import { describe, expect, it } from 'vitest';
import { detectKey, keyImageData, pickKeyColor } from '../src/ai/chromaKey';

const px = (r: number, g: number, b: number, a = 255) => [r, g, b, a];
const buf = (...pixels: number[][]) => new Uint8ClampedArray(pixels.flat());

describe('chroma key', () => {
  it('removes the screen colour, keeps the subject and softens the edge', () => {
    const data = buf(px(0, 255, 0), px(200, 30, 30), px(60, 140, 60), px(0, 180, 0));
    keyImageData(data, 'green');
    expect(data[3]).toBe(0); // pure green: gone
    expect(Array.from(data.slice(4, 8))).toEqual([200, 30, 30, 255]); // red subject: untouched
    expect(data[11]).toBeGreaterThan(0); // greenish edge: partly kept
    expect(data[11]).toBeLessThan(255);
    expect(data[15]).toBe(0); // strong green: gone
  });

  it('removes green spill from edge pixels', () => {
    const data = buf(px(180, 200, 170));
    keyImageData(data, 'green');
    expect(data[3]).toBeGreaterThan(0);
    expect(data[1]).toBeLessThanOrEqual(180); // green capped at the strongest other channel
  });

  it('works with a blue screen', () => {
    const data = buf(px(0, 0, 255), px(30, 200, 30));
    keyImageData(data, 'blue');
    expect(data[3]).toBe(0);
    expect(Array.from(data.slice(4, 8))).toEqual([30, 200, 30, 255]); // a green subject survives a blue screen
  });

  it('never changes opaque non-key colours', () => {
    const data = buf(px(255, 255, 255), px(0, 0, 0), px(120, 80, 200), px(250, 220, 40));
    const before = Array.from(data);
    keyImageData(data, 'green');
    expect(Array.from(data)).toEqual(before);
  });

  it('detects which screen colour a frame was shot against', () => {
    const frame = (c: number[]) => buf(...Array.from({ length: 16 }, () => c));
    expect(detectKey(frame(px(0, 255, 0)), 4, 4)).toBe('green');
    expect(detectKey(frame(px(10, 20, 250)), 4, 4)).toBe('blue');
    expect(detectKey(frame(px(240, 240, 240)), 4, 4)).toBeNull();
  });

  it('picks a screen colour the subject does not use', () => {
    expect(pickKeyColor(200, 40, 40)).toBe('green');
    expect(pickKeyColor(40, 200, 40)).toBe('blue');
  });
});
