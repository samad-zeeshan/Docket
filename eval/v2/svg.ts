/**
 * Minimal SVG charts for the results folder: line charts and reliability diagrams, no plotting library.
 */

export interface Series {
  name: string;
  points: [number, number][];
  color: string;
  dashed?: boolean;
}

const W = 560;
const H = 360;
const M = { l: 56, r: 150, t: 36, b: 48 };

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

function frame(title: string, xLabel: string, yLabel: string, xMax: number, yMax: number, body: string): string {
  const x = (v: number) => M.l + (v / xMax) * (W - M.l - M.r);
  const y = (v: number) => H - M.b - (v / yMax) * (H - M.t - M.b);
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const grid = ticks
    .map(
      (t) =>
        `<line x1="${x(0)}" x2="${x(xMax)}" y1="${y(t * yMax)}" y2="${y(t * yMax)}" stroke="#e5e7eb"/>` +
        `<text x="${x(0) - 6}" y="${y(t * yMax) + 4}" text-anchor="end">${+(t * yMax).toFixed(3)}</text>` +
        `<text x="${x(t * xMax)}" y="${H - M.b + 16}" text-anchor="middle">${+(t * xMax).toFixed(3)}</text>`,
    )
    .join('');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="system-ui, sans-serif" font-size="11" fill="#374151">`,
    `<rect width="${W}" height="${H}" fill="#ffffff"/>`,
    `<text x="${M.l}" y="20" font-size="13" font-weight="600">${esc(title)}</text>`,
    grid,
    `<text x="${(M.l + W - M.r) / 2}" y="${H - 12}" text-anchor="middle">${esc(xLabel)}</text>`,
    `<text transform="translate(14 ${(M.t + H - M.b) / 2}) rotate(-90)" text-anchor="middle">${esc(yLabel)}</text>`,
    body,
    '</svg>',
  ].join('\n');
}

export function lineChart(title: string, xLabel: string, yLabel: string, series: Series[], xMax = 1, yMax = 1): string {
  const x = (v: number) => M.l + (v / xMax) * (W - M.l - M.r);
  const y = (v: number) => H - M.b - (Math.min(v, yMax) / yMax) * (H - M.t - M.b);
  const body = series
    .map((s, i) => {
      const d = s.points.map(([a, b], j) => `${j ? 'L' : 'M'}${x(a).toFixed(1)},${y(b).toFixed(1)}`).join('');
      const ly = M.t + 14 + i * 18;
      return (
        `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2"${s.dashed ? ' stroke-dasharray="5 4"' : ''}/>` +
        `<line x1="${W - M.r + 12}" x2="${W - M.r + 32}" y1="${ly}" y2="${ly}" stroke="${s.color}" stroke-width="2"${s.dashed ? ' stroke-dasharray="5 4"' : ''}/>` +
        `<text x="${W - M.r + 38}" y="${ly + 4}">${esc(s.name)}</text>`
      );
    })
    .join('');
  return frame(title, xLabel, yLabel, xMax, yMax, body);
}

export interface Bin {
  lo: number;
  hi: number;
  n: number;
  accuracy: number;
}

// Bars at the observed accuracy of each confidence bin against the diagonal a
// calibrated score would sit on. Empty bins draw nothing rather than a zero bar.
export function reliabilityDiagram(title: string, bins: Bin[], color: string): string {
  const x = (v: number) => M.l + v * (W - M.l - M.r);
  const y = (v: number) => H - M.b - v * (H - M.t - M.b);
  const bars = bins
    .filter((b) => b.n > 0)
    .map((b) => `<rect x="${x(b.lo) + 1}" y="${y(b.accuracy)}" width="${x(b.hi) - x(b.lo) - 2}" height="${y(0) - y(b.accuracy)}" fill="${color}" fill-opacity="0.75"><title>n=${b.n}</title></rect>`)
    .join('');
  const diag = `<line x1="${x(0)}" y1="${y(0)}" x2="${x(1)}" y2="${y(1)}" stroke="#9ca3af" stroke-dasharray="4 4"/>`;
  const legend = `<text x="${W - M.r + 12}" y="${M.t + 18}">bar: accuracy in bin</text><text x="${W - M.r + 12}" y="${M.t + 36}">dashed: perfect</text>`;
  return frame(title, 'confidence', 'accuracy', 1, 1, bars + diag + legend);
}
