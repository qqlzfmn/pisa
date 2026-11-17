const W = 640;
const H = 180;
const PAD = { top: 10, right: 8, bottom: 24, left: 34 };

const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function frame(maxLabel: string, xLabels: string[]): string {
  // 两条参考线：0 与最大值，给图一个可读的刻度
  const xAxis = xLabels
    .map((label, i) => {
      const step = xLabels.length > 1 ? PLOT_W / (xLabels.length - 1) : 0;
      const x = PAD.left + step * i;
      return `<text x="${x.toFixed(1)}" y="${H - 6}" class="tick" text-anchor="middle">${escapeHtml(label)}</text>`;
    })
    .join("");
  return [
    `<line x1="${PAD.left}" y1="${PAD.top}" x2="${PAD.left}" y2="${PAD.top + PLOT_H}" class="axis"/>`,
    `<line x1="${PAD.left}" y1="${PAD.top + PLOT_H}" x2="${W - PAD.right}" y2="${PAD.top + PLOT_H}" class="axis"/>`,
    `<text x="${PAD.left - 6}" y="${PAD.top + 4}" class="tick" text-anchor="end">${escapeHtml(maxLabel)}</text>`,
    `<text x="${PAD.left - 6}" y="${PAD.top + PLOT_H}" class="tick" text-anchor="end">0</text>`,
    xAxis,
  ].join("");
}

export interface BarPoint {
  label: string;
  parts: Array<{ value: number; color: string }>;
}

/** 堆叠柱状图：每个标签一根柱，parts 自下而上堆叠 */
export function stackedBars(points: BarPoint[]): string {
  const max = Math.max(1, ...points.map((p) => p.parts.reduce((sum, part) => sum + part.value, 0)));
  const slot = PLOT_W / Math.max(1, points.length);
  const barW = Math.max(3, slot * 0.6);
  const bars = points
    .map((p, i) => {
      const cx = PAD.left + slot * i + slot / 2;
      let y = PAD.top + PLOT_H;
      const rects = p.parts
        .filter((part) => part.value > 0)
        .map((part) => {
          const h = (part.value / max) * PLOT_H;
          y -= h;
          return `<rect x="${(cx - barW / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${part.color}"/>`;
        })
        .join("");
      return `<g>${rects}<title>${escapeHtml(p.label)}: ${escapeHtml(p.parts.map((s) => s.value).join(" / "))}</title></g>`;
    })
    .join("");
  const labels = points.filter((_, i) => i % Math.max(1, Math.ceil(points.length / 8)) === 0).map((p) => p.label);
  return `<svg viewBox="0 0 ${W} ${H}" role="img">${frame(String(max), labels)}${bars}</svg>`;
}

/** 折线图：值域 0..1，null 断开；用于成功率 */
export function rateLine(points: Array<{ label: string; value: number | null }>): string {
  const slot = PLOT_W / Math.max(1, points.length - 1);
  const dots: string[] = [];
  const segments: string[][] = [[]];
  points.forEach((p, i) => {
    if (p.value === null) {
      if (segments[segments.length - 1]!.length > 0) segments.push([]);
      return;
    }
    const x = PAD.left + slot * i;
    const y = PAD.top + PLOT_H - Math.min(1, Math.max(0, p.value)) * PLOT_H;
    segments[segments.length - 1]!.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    dots.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.5" fill="#2563eb"><title>${escapeHtml(p.label)}: ${Math.round(p.value * 100)}%</title></circle>`);
  });
  const lines = segments
    .filter((s) => s.length > 1)
    .map((s) => `<polyline points="${s.join(" ")}" fill="none" stroke="#2563eb" stroke-width="2"/>`)
    .join("");
  return `<svg viewBox="0 0 ${W} ${H}" role="img">${frame("100%", points.map((p) => p.label))}${lines}${dots.join("")}</svg>`;
}
