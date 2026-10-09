/** Generated poses can cross nominal cell boundaries; retain that overscan. */
export function flightFrameCrop(sheetWidth: number, sheetHeight: number, index: number) {
  const column = index % 4, row = Math.floor(index / 4);
  const x = Math.floor(column * sheetWidth / 4);
  const y = Math.floor(row * sheetHeight / 4);
  const cellWidth = Math.floor((column + 1) * sheetWidth / 4) - x;
  const cellHeight = Math.floor((row + 1) * sheetHeight / 4) - y;
  const margin = Math.ceil(Math.max(cellWidth, cellHeight) * 0.2);
  return { x: x - margin, y: y - margin, width: cellWidth + margin * 2, height: cellHeight + margin * 2, cellWidth, cellHeight };
}

/** Keep the main connected subject, excluding fragments from neighbouring sprites. */
export function cleanFlightFrame(data: Uint8ClampedArray, width: number, height: number): void {
  const count = width * height;
  const labels = new Int32Array(count);
  const queue = new Int32Array(count);
  let label = 0, largest = 0, largestSize = 0;
  for (let start = 0; start < count; start++) {
    if (labels[start] || data[start * 4 + 3] < 24) continue;
    label++;
    let head = 0, tail = 1;
    queue[0] = start;
    labels[start] = label;
    while (head < tail) {
      const p = queue[head++], x = p % width, y = Math.floor(p / width);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const next = ny * width + nx;
        if (labels[next] || data[next * 4 + 3] < 24) continue;
        labels[next] = label;
        queue[tail++] = next;
      }
    }
    if (tail > largestSize) { largest = label; largestSize = tail; }
  }
  if (!largest) return;
  for (let p = 0; p < count; p++) {
    if (labels[p] === largest) continue;
    // Retain soft antialiased pixels touching the main subject.
    let edge = false;
    if (!labels[p]) {
      const x = p % width, y = Math.floor(p / width);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < width && ny >= 0 && ny < height && labels[ny * width + nx] === largest) edge = true;
      }
    }
    if (!edge) data[p * 4 + 3] = 0;
  }
}
