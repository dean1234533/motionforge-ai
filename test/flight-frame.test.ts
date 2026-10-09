import { expect, it } from 'vitest';
import { cleanFlightFrame, flightFrameCrop } from '../src/ai/flightFrame';

it('includes raised wing tips above the last row without fractional pixel coordinates', () => {
  const crop = flightFrameCrop(1254, 1254, 12);
  // The actual sheet has last-row wing tips around y=915, above the cell at y=940.
  expect(crop.y).toBeLessThan(915);
  expect(crop.y + crop.height).toBeGreaterThan(1254);
  expect(crop.cellWidth).toBe(313);
  for (const value of Object.values(crop)) expect(Number.isInteger(value)).toBe(true);
});

it('removes detached wing fragments but preserves connected feathers and soft edges', () => {
  const w = 9, h = 9;
  const data = new Uint8ClampedArray(w * h * 4);
  const alpha = (x: number, y: number, value = 255) => { data[(y * w + x) * 4 + 3] = value; };
  // Torso and a diagonally attached feather.
  for (let y = 2; y <= 4; y++) for (let x = 3; x <= 5; x++) alpha(x, y);
  alpha(2, 1); alpha(1, 0); alpha(6, 3, 12);
  // A fragment below the bird from the next sprite row.
  alpha(3, 7); alpha(4, 7); alpha(5, 7); alpha(0, 8, 10);
  cleanFlightFrame(data, w, h);
  expect(data[(7 * w + 4) * 4 + 3]).toBe(0);
  expect(data[(8 * w) * 4 + 3]).toBe(0);
  expect(data[(0 * w + 1) * 4 + 3]).toBe(255);
  expect(data[(3 * w + 6) * 4 + 3]).toBe(12);
  expect(data[(3 * w + 4) * 4 + 3]).toBe(255);
});
