import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

type RGB = readonly [number, number, number];
type Pt = readonly [number, number];

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

interface GlyphSpec {
  readonly adv: number;
  readonly strokes: readonly (readonly Pt[])[];
  readonly serifs?: readonly (readonly [number, number, number])[]; // [x0, x1, y]
}

interface StoryCard {
  readonly id: string;
  readonly kicker: string;
  readonly accent: RGB;
  readonly headline: readonly [string, string];
  readonly subline: string;
  readonly drawIllustration: (cv: Surface, box: Rect) => void;
}

const IMG_W = 1024;
const IMG_H = 1024;

// Broadsheet palette
const PAPER_TOP: RGB = [245, 239, 226];
const PAPER_BOT: RGB = [235, 227, 210];
const CARD_BG: RGB = [252, 249, 242];
const INK_DARK: RGB = [20, 22, 28];
const INK_BODY: RGB = [56, 60, 70];
const RULE_DARK: RGB = [42, 38, 34];
const RULE_SOFT: RGB = [194, 184, 164];
const RIBBON_TOP: RGB = [152, 22, 26];
const RIBBON_BOT: RGB = [112, 14, 18];
const GOLD_TRIM: RGB = [226, 186, 98];
const WHITE: RGB = [255, 255, 255];

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function mixRGB(a: RGB, b: RGB, t: number): RGB {
  const k = clamp(t, 0, 1);
  return [
    Math.round(lerp(a[0], b[0], k)),
    Math.round(lerp(a[1], b[1], k)),
    Math.round(lerp(a[2], b[2], k)),
  ];
}

class Surface {
  readonly w: number;
  readonly h: number;
  readonly buf: Uint8Array;
  private clipX0 = 0;
  private clipY0 = 0;
  private clipX1: number;
  private clipY1: number;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.buf = new Uint8Array(w * h * 3);
    this.clipX1 = w;
    this.clipY1 = h;
  }

  setClip(r: Rect): void {
    this.clipX0 = Math.max(0, Math.floor(r.x));
    this.clipY0 = Math.max(0, Math.floor(r.y));
    this.clipX1 = Math.min(this.w, Math.ceil(r.x + r.w));
    this.clipY1 = Math.min(this.h, Math.ceil(r.y + r.h));
  }

  clearClip(): void {
    this.clipX0 = 0;
    this.clipY0 = 0;
    this.clipX1 = this.w;
    this.clipY1 = this.h;
  }

  blend(x: number, y: number, col: RGB, alpha = 1): void {
    if (x < this.clipX0 || x >= this.clipX1 || y < this.clipY0 || y >= this.clipY1) return;
    if (alpha <= 0) return;
    const idx = (y * this.w + x) * 3;
    if (alpha >= 0.999) {
      this.buf[idx] = col[0];
      this.buf[idx + 1] = col[1];
      this.buf[idx + 2] = col[2];
      return;
    }
    const inv = 1 - alpha;
    this.buf[idx] = Math.round(this.buf[idx] * inv + col[0] * alpha);
    this.buf[idx + 1] = Math.round(this.buf[idx + 1] * inv + col[1] * alpha);
    this.buf[idx + 2] = Math.round(this.buf[idx + 2] * inv + col[2] * alpha);
  }

  fillRect(x: number, y: number, w: number, h: number, col: RGB, alpha = 1): void {
    const x0 = Math.max(this.clipX0, Math.floor(x));
    const y0 = Math.max(this.clipY0, Math.floor(y));
    const x1 = Math.min(this.clipX1, Math.ceil(x + w));
    const y1 = Math.min(this.clipY1, Math.ceil(y + h));
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        this.blend(px, py, col, alpha);
      }
    }
  }

  fillGradV(x: number, y: number, w: number, h: number, topCol: RGB, botCol: RGB, alpha = 1): void {
    const x0 = Math.max(this.clipX0, Math.floor(x));
    const y0 = Math.max(this.clipY0, Math.floor(y));
    const x1 = Math.min(this.clipX1, Math.ceil(x + w));
    const y1 = Math.min(this.clipY1, Math.ceil(y + h));
    const denom = Math.max(1, h - 1);
    for (let py = y0; py < y1; py++) {
      const t = clamp((py - y) / denom, 0, 1);
      const col = mixRGB(topCol, botCol, t);
      for (let px = x0; px < x1; px++) {
        this.blend(px, py, col, alpha);
      }
    }
  }

  fillGradH(x: number, y: number, w: number, h: number, leftCol: RGB, rightCol: RGB, alpha = 1): void {
    const x0 = Math.max(this.clipX0, Math.floor(x));
    const y0 = Math.max(this.clipY0, Math.floor(y));
    const x1 = Math.min(this.clipX1, Math.ceil(x + w));
    const y1 = Math.min(this.clipY1, Math.ceil(y + h));
    const denom = Math.max(1, w - 1);
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const t = clamp((px - x) / denom, 0, 1);
        this.blend(px, py, mixRGB(leftCol, rightCol, t), alpha);
      }
    }
  }

  strokeRect(x: number, y: number, w: number, h: number, thickness: number, col: RGB, alpha = 1): void {
    this.fillRect(x, y, w, thickness, col, alpha);
    this.fillRect(x, y + h - thickness, w, thickness, col, alpha);
    this.fillRect(x, y, thickness, h, col, alpha);
    this.fillRect(x + w - thickness, y, thickness, h, col, alpha);
  }

  fillRoundedRect(x: number, y: number, w: number, h: number, r: number, col: RGB, alpha = 1): void {
    const rad = Math.min(r, w * 0.5, h * 0.5);
    const x0 = Math.max(this.clipX0, Math.floor(x - 1));
    const y0 = Math.max(this.clipY0, Math.floor(y - 1));
    const x1 = Math.min(this.clipX1, Math.ceil(x + w + 1));
    const y1 = Math.min(this.clipY1, Math.ceil(y + h + 1));
    const cx0 = x + rad;
    const cx1 = x + w - rad;
    const cy0 = y + rad;
    const cy1 = y + h - rad;
    for (let py = y0; py < y1; py++) {
      const sy = py + 0.5;
      const dy = sy < cy0 ? cy0 - sy : sy > cy1 ? sy - cy1 : 0;
      for (let px = x0; px < x1; px++) {
        const sx = px + 0.5;
        const dx = sx < cx0 ? cx0 - sx : sx > cx1 ? sx - cx1 : 0;
        let dist: number;
        if (dx > 0 && dy > 0) {
          dist = Math.hypot(dx, dy) - rad;
        } else {
          const ox = Math.max(x - sx, sx - (x + w));
          const oy = Math.max(y - sy, sy - (y + h));
          dist = Math.max(ox, oy);
        }
        const cov = clamp(0.5 - dist, 0, 1);
        if (cov > 0) this.blend(px, py, col, alpha * cov);
      }
    }
  }

  fillCircle(cx: number, cy: number, r: number, col: RGB, alpha = 1): void {
    const x0 = Math.max(this.clipX0, Math.floor(cx - r - 1));
    const y0 = Math.max(this.clipY0, Math.floor(cy - r - 1));
    const x1 = Math.min(this.clipX1, Math.ceil(cx + r + 1));
    const y1 = Math.min(this.clipY1, Math.ceil(cy + r + 1));
    for (let py = y0; py < y1; py++) {
      const dy = py + 0.5 - cy;
      for (let px = x0; px < x1; px++) {
        const dx = px + 0.5 - cx;
        const d = Math.hypot(dx, dy);
        const cov = clamp(r + 0.5 - d, 0, 1);
        if (cov > 0) this.blend(px, py, col, alpha * cov);
      }
    }
  }

  fillEllipse(cx: number, cy: number, rx: number, ry: number, col: RGB, alpha = 1): void {
    const x0 = Math.max(this.clipX0, Math.floor(cx - rx - 1));
    const y0 = Math.max(this.clipY0, Math.floor(cy - ry - 1));
    const x1 = Math.min(this.clipX1, Math.ceil(cx + rx + 1));
    const y1 = Math.min(this.clipY1, Math.ceil(cy + ry + 1));
    const invRx = 1 / Math.max(0.5, rx);
    const invRy = 1 / Math.max(0.5, ry);
    const edge = 1 / Math.min(rx, ry);
    for (let py = y0; py < y1; py++) {
      const ny = (py + 0.5 - cy) * invRy;
      for (let px = x0; px < x1; px++) {
        const nx = (px + 0.5 - cx) * invRx;
        const d = Math.hypot(nx, ny);
        const cov = clamp((1 - d) / Math.max(0.01, edge) + 0.5, 0, 1);
        if (cov > 0) this.blend(px, py, col, alpha * cov);
      }
    }
  }

  strokeCircle(cx: number, cy: number, r: number, thickness: number, col: RGB, alpha = 1): void {
    const half = thickness * 0.5;
    const x0 = Math.max(this.clipX0, Math.floor(cx - r - half - 1));
    const y0 = Math.max(this.clipY0, Math.floor(cy - r - half - 1));
    const x1 = Math.min(this.clipX1, Math.ceil(cx + r + half + 1));
    const y1 = Math.min(this.clipY1, Math.ceil(cy + r + half + 1));
    for (let py = y0; py < y1; py++) {
      const dy = py + 0.5 - cy;
      for (let px = x0; px < x1; px++) {
        const dx = px + 0.5 - cx;
        const dist = Math.abs(Math.hypot(dx, dy) - r);
        const cov = clamp(half + 0.5 - dist, 0, 1);
        if (cov > 0) this.blend(px, py, col, alpha * cov);
      }
    }
  }

  fillRadialGlow(cx: number, cy: number, r: number, col: RGB, maxAlpha = 0.8): void {
    const x0 = Math.max(this.clipX0, Math.floor(cx - r));
    const y0 = Math.max(this.clipY0, Math.floor(cy - r));
    const x1 = Math.min(this.clipX1, Math.ceil(cx + r));
    const y1 = Math.min(this.clipY1, Math.ceil(cy + r));
    const invR = 1 / Math.max(1, r);
    for (let py = y0; py < y1; py++) {
      const dy = py + 0.5 - cy;
      for (let px = x0; px < x1; px++) {
        const dx = px + 0.5 - cx;
        const t = Math.hypot(dx, dy) * invR;
        if (t < 1) {
          const falloff = (1 - t) * (1 - t);
          this.blend(px, py, col, maxAlpha * falloff);
        }
      }
    }
  }

  drawCapsule(x0: number, y0: number, x1: number, y1: number, radius: number, col: RGB, alpha = 1): void {
    const bx0 = Math.max(this.clipX0, Math.floor(Math.min(x0, x1) - radius - 1));
    const by0 = Math.max(this.clipY0, Math.floor(Math.min(y0, y1) - radius - 1));
    const bx1 = Math.min(this.clipX1, Math.ceil(Math.max(x0, x1) + radius + 1));
    const by1 = Math.min(this.clipY1, Math.ceil(Math.max(y0, y1) + radius + 1));
    const vx = x1 - x0;
    const vy = y1 - y0;
    const lenSq = vx * vx + vy * vy;
    for (let py = by0; py < by1; py++) {
      const sy = py + 0.5 - y0;
      for (let px = bx0; px < bx1; px++) {
        const sx = px + 0.5 - x0;
        const proj = lenSq > 1e-6 ? clamp((sx * vx + sy * vy) / lenSq, 0, 1) : 0;
        const dx = sx - vx * proj;
        const dy = sy - vy * proj;
        const dist = Math.hypot(dx, dy);
        const cov = clamp(radius + 0.5 - dist, 0, 1);
        if (cov > 0) this.blend(px, py, col, alpha * cov);
      }
    }
  }

  strokePolyline(pts: readonly Pt[], width: number, col: RGB, alpha = 1): void {
    const rad = width * 0.5;
    if (pts.length === 1) {
      this.fillCircle(pts[0][0], pts[0][1], rad, col, alpha);
      return;
    }
    for (let i = 0; i < pts.length - 1; i++) {
      this.drawCapsule(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], rad, col, alpha);
    }
  }

  fillPolygon(pts: readonly Pt[], col: RGB, alpha = 1): void {
    if (pts.length < 3) return;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [, py] of pts) {
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
    const y0 = Math.max(this.clipY0, Math.floor(minY));
    const y1 = Math.min(this.clipY1, Math.ceil(maxY));
    const subN = 3; // 3x3 supersampled scanlines for crisp anti-aliased edges
    const invSub = 1 / (subN * subN);
    const n = pts.length;

    for (let py = y0; py < y1; py++) {
      const rowCounts = new Map<number, number>();
      for (let sy = 0; sy < subN; sy++) {
        const sampleY = py + (sy + 0.5) / subN;
        const xs: number[] = [];
        for (let i = 0, j = n - 1; i < n; j = i++) {
          const xi = pts[i][0];
          const yi = pts[i][1];
          const xj = pts[j][0];
          const yj = pts[j][1];
          if ((yi > sampleY) !== (yj > sampleY)) {
            xs.push(xi + ((sampleY - yi) * (xj - xi)) / (yj - yi));
          }
        }
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const sx0 = xs[k];
          const sx1 = xs[k + 1];
          const px0 = Math.max(this.clipX0, Math.floor(sx0));
          const px1 = Math.min(this.clipX1, Math.ceil(sx1));
          for (let px = px0; px < px1; px++) {
            let hits = 0;
            for (let sx = 0; sx < subN; sx++) {
              const sampleX = px + (sx + 0.5) / subN;
              if (sampleX >= sx0 && sampleX <= sx1) hits++;
            }
            if (hits > 0) {
              rowCounts.set(px, (rowCounts.get(px) ?? 0) + hits);
            }
          }
        }
      }
      for (const [px, hits] of rowCounts) {
        this.blend(px, py, col, alpha * hits * invSub);
      }
    }
  }

  fillStar(cx: number, cy: number, outerR: number, innerR: number, points: number, col: RGB, alpha = 1, rotDeg = -90): void {
    const pts: Pt[] = [];
    const base = (rotDeg * Math.PI) / 180;
    for (let i = 0; i < points * 2; i++) {
      const r = i % 2 === 0 ? outerR : innerR;
      const a = base + (i * Math.PI) / points;
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
    this.fillPolygon(pts, col, alpha);
  }
}

// ---------- Vector Typography Engine ----------

function arcPts(cx: number, cy: number, rx: number, ry: number, deg0: number, deg1: number, steps = 12): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = ((deg0 + ((deg1 - deg0) * i) / steps) * Math.PI) / 180;
    out.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return out;
}

const GLYPHS: Record<string, GlyphSpec> = {
  ' ': { adv: 0.36, strokes: [] },
  A: {
    adv: 0.72,
    strokes: [
      [[0.06, 1.0], [0.36, 0.0], [0.66, 1.0]],
      [[0.17, 0.67], [0.55, 0.67]],
    ],
    serifs: [[0.0, 0.16, 1.0], [0.56, 0.72, 1.0]],
  },
  B: {
    adv: 0.68,
    strokes: [
      [[0.09, 0.0], [0.09, 1.0]],
      [[0.09, 0.0], [0.40, 0.0], ...arcPts(0.40, 0.24, 0.21, 0.24, -90, 90, 10), [0.09, 0.48]],
      [[0.09, 0.48], [0.42, 0.48], ...arcPts(0.42, 0.74, 0.22, 0.26, -90, 90, 10), [0.09, 1.0]],
    ],
    serifs: [[0.02, 0.18, 0.0], [0.02, 0.18, 1.0]],
  },
  C: {
    adv: 0.68,
    strokes: [arcPts(0.38, 0.5, 0.29, 0.5, -40, -320, 16)],
  },
  D: {
    adv: 0.70,
    strokes: [
      [[0.09, 0.0], [0.09, 1.0]],
      [[0.09, 0.0], [0.32, 0.0], ...arcPts(0.32, 0.5, 0.31, 0.5, -90, 90, 14), [0.09, 1.0]],
    ],
    serifs: [[0.02, 0.18, 0.0], [0.02, 0.18, 1.0]],
  },
  E: {
    adv: 0.62,
    strokes: [
      [[0.56, 0.0], [0.10, 0.0], [0.10, 1.0], [0.57, 1.0]],
      [[0.10, 0.49], [0.49, 0.49]],
    ],
    serifs: [[0.03, 0.18, 0.0], [0.03, 0.18, 1.0]],
  },
  F: {
    adv: 0.58,
    strokes: [
      [[0.53, 0.0], [0.10, 0.0], [0.10, 1.0]],
      [[0.10, 0.50], [0.46, 0.50]],
    ],
    serifs: [[0.03, 0.19, 1.0]],
  },
  G: {
    adv: 0.72,
    strokes: [
      [...arcPts(0.39, 0.5, 0.30, 0.5, -42, -360, 16), [0.69, 0.54], [0.41, 0.54]],
    ],
  },
  H: {
    adv: 0.70,
    strokes: [
      [[0.10, 0.0], [0.10, 1.0]],
      [[0.60, 0.0], [0.60, 1.0]],
      [[0.10, 0.49], [0.60, 0.49]],
    ],
    serifs: [[0.03, 0.18, 0.0], [0.52, 0.67, 0.0], [0.03, 0.18, 1.0], [0.52, 0.67, 1.0]],
  },
  I: {
    adv: 0.32,
    strokes: [
      [[0.16, 0.0], [0.16, 1.0]],
      [[0.05, 0.0], [0.27, 0.0]],
      [[0.05, 1.0], [0.27, 1.0]],
    ],
  },
  J: {
    adv: 0.56,
    strokes: [
      [[0.46, 0.0], [0.46, 0.72], ...arcPts(0.26, 0.72, 0.20, 0.28, 0, 165, 10)],
      [[0.30, 0.0], [0.54, 0.0]],
    ],
  },
  K: {
    adv: 0.68,
    strokes: [
      [[0.10, 0.0], [0.10, 1.0]],
      [[0.61, 0.0], [0.12, 0.54]],
      [[0.27, 0.39], [0.63, 1.0]],
    ],
    serifs: [[0.03, 0.18, 0.0], [0.03, 0.18, 1.0]],
  },
  L: {
    adv: 0.58,
    strokes: [[[0.10, 0.0], [0.10, 1.0], [0.54, 1.0]]],
    serifs: [[0.03, 0.18, 0.0]],
  },
  M: {
    adv: 0.84,
    strokes: [[[0.09, 1.0], [0.09, 0.0], [0.42, 0.68], [0.75, 0.0], [0.75, 1.0]]],
    serifs: [[0.02, 0.17, 1.0], [0.67, 0.82, 1.0]],
  },
  N: {
    adv: 0.72,
    strokes: [[[0.10, 1.0], [0.10, 0.0], [0.62, 1.0], [0.62, 0.0]]],
    serifs: [[0.03, 0.18, 1.0], [0.54, 0.69, 0.0]],
  },
  O: {
    adv: 0.74,
    strokes: [arcPts(0.37, 0.5, 0.29, 0.5, 0, 360, 20)],
  },
  P: {
    adv: 0.65,
    strokes: [
      [[0.10, 1.0], [0.10, 0.0], [0.38, 0.0], ...arcPts(0.38, 0.27, 0.22, 0.27, -90, 90, 12), [0.10, 0.54]],
    ],
    serifs: [[0.03, 0.19, 1.0]],
  },
  Q: {
    adv: 0.74,
    strokes: [
      arcPts(0.37, 0.5, 0.29, 0.5, 0, 360, 20),
      [[0.44, 0.74], [0.69, 1.05]],
    ],
  },
  R: {
    adv: 0.68,
    strokes: [
      [[0.10, 1.0], [0.10, 0.0], [0.38, 0.0], ...arcPts(0.38, 0.26, 0.22, 0.26, -90, 90, 12), [0.10, 0.52]],
      [[0.36, 0.52], [0.62, 1.0]],
    ],
    serifs: [[0.03, 0.18, 1.0], [0.55, 0.69, 1.0]],
  },
  S: {
    adv: 0.64,
    strokes: [
      [
        ...arcPts(0.32, 0.24, 0.23, 0.24, -22, -262, 12),
        ...arcPts(0.33, 0.75, 0.24, 0.25, -88, 162, 12),
      ],
    ],
  },
  T: {
    adv: 0.64,
    strokes: [
      [[0.04, 0.0], [0.60, 0.0]],
      [[0.32, 0.0], [0.32, 1.0]],
    ],
    serifs: [[0.23, 0.41, 1.0]],
  },
  U: {
    adv: 0.70,
    strokes: [
      [[0.10, 0.0], [0.10, 0.68], ...arcPts(0.35, 0.68, 0.25, 0.32, 180, 0, 12), [0.60, 0.0]],
    ],
    serifs: [[0.03, 0.18, 0.0], [0.52, 0.67, 0.0]],
  },
  V: {
    adv: 0.70,
    strokes: [[[0.06, 0.0], [0.35, 1.0], [0.64, 0.0]]],
  },
  W: {
    adv: 0.92,
    strokes: [[[0.05, 0.0], [0.24, 1.0], [0.46, 0.28], [0.68, 1.0], [0.87, 0.0]]],
  },
  X: {
    adv: 0.66,
    strokes: [
      [[0.08, 0.0], [0.58, 1.0]],
      [[0.58, 0.0], [0.08, 1.0]],
    ],
  },
  Y: {
    adv: 0.66,
    strokes: [
      [[0.06, 0.0], [0.33, 0.50], [0.60, 0.0]],
      [[0.33, 0.50], [0.33, 1.0]],
    ],
  },
  Z: {
    adv: 0.64,
    strokes: [[[0.08, 0.0], [0.56, 0.0], [0.08, 1.0], [0.57, 1.0]]],
  },

  // Lowercase (for crisp sublines)
  a: {
    adv: 0.56,
    strokes: [
      [...arcPts(0.28, 0.48, 0.18, 0.16, -155, 0, 8), [0.46, 1.0]],
      [...arcPts(0.27, 0.80, 0.19, 0.20, 0, 360, 14)],
    ],
  },
  b: {
    adv: 0.58,
    strokes: [
      [[0.10, 0.0], [0.10, 1.0]],
      arcPts(0.30, 0.67, 0.20, 0.33, -150, 150, 14),
    ],
  },
  c: {
    adv: 0.52,
    strokes: [arcPts(0.30, 0.67, 0.21, 0.33, -40, -320, 14)],
  },
  d: {
    adv: 0.58,
    strokes: [
      [[0.48, 0.0], [0.48, 1.0]],
      arcPts(0.28, 0.67, 0.20, 0.33, 30, 330, 14),
    ],
  },
  e: {
    adv: 0.56,
    strokes: [
      [[0.09, 0.66], [0.48, 0.66], ...arcPts(0.29, 0.67, 0.20, 0.33, 0, -315, 16)],
    ],
  },
  f: {
    adv: 0.38,
    strokes: [
      [...arcPts(0.28, 0.16, 0.13, 0.16, -35, -180, 8), [0.15, 1.0]],
      [[0.04, 0.38], [0.34, 0.38]],
    ],
  },
  g: {
    adv: 0.58,
    strokes: [
      arcPts(0.28, 0.65, 0.20, 0.31, 0, 360, 16),
      [[0.48, 0.36], [0.48, 1.06], ...arcPts(0.28, 1.06, 0.20, 0.18, 0, 160, 10)],
    ],
  },
  h: {
    adv: 0.58,
    strokes: [
      [[0.10, 0.0], [0.10, 1.0]],
      [[0.10, 0.54], ...arcPts(0.29, 0.54, 0.19, 0.19, 180, 360, 10), [0.48, 1.0]],
    ],
  },
  i: {
    adv: 0.26,
    strokes: [
      [[0.13, 0.36], [0.13, 1.0]],
      [[0.13, 0.10], [0.13, 0.12]],
    ],
  },
  j: {
    adv: 0.30,
    strokes: [
      [[0.18, 0.36], [0.18, 1.06], ...arcPts(0.08, 1.06, 0.10, 0.16, 0, 140, 8)],
      [[0.18, 0.10], [0.18, 0.12]],
    ],
  },
  k: {
    adv: 0.54,
    strokes: [
      [[0.10, 0.0], [0.10, 1.0]],
      [[0.46, 0.35], [0.12, 0.70]],
      [[0.22, 0.60], [0.48, 1.0]],
    ],
  },
  l: {
    adv: 0.26,
    strokes: [[[0.13, 0.0], [0.13, 1.0]]],
  },
  m: {
    adv: 0.84,
    strokes: [
      [[0.09, 0.35], [0.09, 1.0]],
      [[0.09, 0.53], ...arcPts(0.25, 0.53, 0.16, 0.18, 180, 360, 8), [0.41, 1.0]],
      [[0.41, 0.53], ...arcPts(0.58, 0.53, 0.17, 0.18, 180, 360, 8), [0.75, 1.0]],
    ],
  },
  n: {
    adv: 0.58,
    strokes: [
      [[0.10, 0.35], [0.10, 1.0]],
      [[0.10, 0.54], ...arcPts(0.29, 0.54, 0.19, 0.19, 180, 360, 10), [0.48, 1.0]],
    ],
  },
  o: {
    adv: 0.58,
    strokes: [arcPts(0.29, 0.67, 0.21, 0.33, 0, 360, 16)],
  },
  p: {
    adv: 0.58,
    strokes: [
      [[0.10, 0.35], [0.10, 1.22]],
      arcPts(0.30, 0.67, 0.20, 0.33, -150, 150, 14),
    ],
  },
  q: {
    adv: 0.58,
    strokes: [
      [[0.48, 0.35], [0.48, 1.22]],
      arcPts(0.28, 0.67, 0.20, 0.33, 30, 330, 14),
    ],
  },
  r: {
    adv: 0.40,
    strokes: [
      [[0.10, 0.35], [0.10, 1.0]],
      [[0.10, 0.54], ...arcPts(0.26, 0.54, 0.16, 0.19, 180, 320, 8)],
    ],
  },
  s: {
    adv: 0.50,
    strokes: [
      [
        ...arcPts(0.25, 0.51, 0.17, 0.17, -25, -260, 10),
        ...arcPts(0.26, 0.84, 0.18, 0.17, -85, 165, 10),
      ],
    ],
  },
  t: {
    adv: 0.38,
    strokes: [
      [[0.17, 0.08], [0.17, 0.86], ...arcPts(0.27, 0.86, 0.10, 0.14, 180, 65, 6)],
      [[0.04, 0.36], [0.33, 0.36]],
    ],
  },
  u: {
    adv: 0.58,
    strokes: [
      [[0.10, 0.35], [0.10, 0.78], ...arcPts(0.29, 0.78, 0.19, 0.22, 180, 0, 10), [0.48, 0.35]],
      [[0.48, 0.35], [0.48, 1.0]],
    ],
  },
  v: {
    adv: 0.54,
    strokes: [[[0.06, 0.35], [0.27, 1.0], [0.48, 0.35]]],
  },
  w: {
    adv: 0.78,
    strokes: [[[0.06, 0.35], [0.21, 1.0], [0.39, 0.46], [0.57, 1.0], [0.72, 0.35]]],
  },
  x: {
    adv: 0.52,
    strokes: [
      [[0.08, 0.35], [0.44, 1.0]],
      [[0.44, 0.35], [0.08, 1.0]],
    ],
  },
  y: {
    adv: 0.54,
    strokes: [
      [[0.06, 0.35], [0.27, 0.96]],
      [[0.48, 0.35], [0.16, 1.22]],
    ],
  },
  z: {
    adv: 0.50,
    strokes: [[[0.08, 0.35], [0.42, 0.35], [0.08, 1.0], [0.43, 1.0]]],
  },

  // Digits
  '0': {
    adv: 0.64,
    strokes: [arcPts(0.32, 0.5, 0.24, 0.5, 0, 360, 18)],
  },
  '1': {
    adv: 0.48,
    strokes: [
      [[0.11, 0.20], [0.27, 0.0], [0.27, 1.0]],
      [[0.10, 1.0], [0.43, 1.0]],
    ],
  },
  '2': {
    adv: 0.62,
    strokes: [
      [...arcPts(0.31, 0.27, 0.22, 0.27, -165, 35, 12), [0.08, 1.0], [0.56, 1.0]],
    ],
  },
  '3': {
    adv: 0.62,
    strokes: [
      arcPts(0.30, 0.25, 0.22, 0.25, -155, 95, 12),
      arcPts(0.31, 0.74, 0.23, 0.26, -95, 160, 12),
    ],
  },
  '4': {
    adv: 0.64,
    strokes: [
      [[0.44, 1.0], [0.44, 0.0], [0.07, 0.68], [0.58, 0.68]],
    ],
  },
  '5': {
    adv: 0.62,
    strokes: [
      [[0.52, 0.0], [0.12, 0.0], [0.10, 0.45], ...arcPts(0.31, 0.72, 0.23, 0.28, -110, 160, 12)],
    ],
  },
  '6': {
    adv: 0.62,
    strokes: [
      [...arcPts(0.33, 0.50, 0.24, 0.50, -50, -180, 10), [0.09, 0.70]],
      arcPts(0.32, 0.72, 0.23, 0.28, 0, 360, 16),
    ],
  },
  '7': {
    adv: 0.60,
    strokes: [[[0.07, 0.0], [0.54, 0.0], [0.21, 1.0]]],
  },
  '8': {
    adv: 0.64,
    strokes: [
      arcPts(0.32, 0.25, 0.21, 0.25, 0, 360, 16),
      arcPts(0.32, 0.74, 0.24, 0.26, 0, 360, 16),
    ],
  },
  '9': {
    adv: 0.62,
    strokes: [
      arcPts(0.30, 0.28, 0.22, 0.28, 0, 360, 16),
      [[0.52, 0.28], ...arcPts(0.29, 0.50, 0.23, 0.50, 0, 130, 10)],
    ],
  },

  // Punctuation & symbols
  '-': { adv: 0.42, strokes: [[[0.08, 0.56], [0.34, 0.56]]] },
  ':': { adv: 0.28, strokes: [[[0.14, 0.35], [0.14, 0.37]], [[0.14, 0.82], [0.14, 0.84]]] },
  ';': { adv: 0.28, strokes: [[[0.14, 0.35], [0.14, 0.37]], [[0.15, 0.84], [0.10, 1.05]]] },
  '.': { adv: 0.26, strokes: [[[0.13, 0.92], [0.13, 0.94]]] },
  ',': { adv: 0.28, strokes: [[[0.15, 0.88], [0.09, 1.08]]] },
  "'": { adv: 0.24, strokes: [[[0.12, 0.02], [0.10, 0.24]]] },
  '!': { adv: 0.28, strokes: [[[0.14, 0.0], [0.14, 0.68]], [[0.14, 0.92], [0.14, 0.94]]] },
  '/': { adv: 0.46, strokes: [[[0.39, 0.0], [0.07, 1.0]]] },
  '+': { adv: 0.58, strokes: [[[0.29, 0.24], [0.29, 0.82]], [[0.06, 0.53], [0.52, 0.53]]] },
  '%': {
    adv: 0.78,
    strokes: [
      [[0.64, 0.04], [0.14, 0.96]],
      arcPts(0.20, 0.22, 0.12, 0.16, 0, 360, 12),
      arcPts(0.58, 0.78, 0.12, 0.16, 0, 360, 12),
    ],
  },
  '$': {
    adv: 0.64,
    strokes: [
      [
        ...arcPts(0.32, 0.28, 0.21, 0.20, -25, -260, 10),
        ...arcPts(0.32, 0.71, 0.22, 0.21, -85, 162, 10),
      ],
      [[0.32, -0.05], [0.32, 1.05]],
    ],
  },
  '&': {
    adv: 0.74,
    strokes: [
      [
        [0.64, 0.98],
        [0.18, 0.36],
        ...arcPts(0.31, 0.22, 0.16, 0.20, 155, -35, 10),
        [0.14, 0.62],
        ...arcPts(0.31, 0.74, 0.22, 0.26, 150, 10, 10),
        [0.64, 0.56],
      ],
    ],
  },
};

interface TextOpts {
  readonly strokeW?: number;
  readonly track?: number;
  readonly scaleX?: number;
  readonly align?: 'left' | 'center' | 'right';
  readonly serif?: boolean;
  readonly alpha?: number;
  readonly maxWidth?: number;
}

function measureText(text: string, height: number, track = 0.06, scaleX = 1): number {
  let w = 0;
  for (let i = 0; i < text.length; i++) {
    const g = GLYPHS[text[i]] ?? GLYPHS[' '];
    w += g.adv * height * scaleX;
    if (i + 1 < text.length) w += track * height * scaleX;
  }
  return w;
}

function drawText(
  cv: Surface,
  text: string,
  x: number,
  y: number,
  height: number,
  col: RGB,
  opts: TextOpts = {},
): void {
  const track = opts.track ?? 0.06;
  let scaleX = opts.scaleX ?? 1;
  const rawW = measureText(text, height, track, scaleX);
  if (opts.maxWidth && rawW > opts.maxWidth && rawW > 0) {
    scaleX *= opts.maxWidth / rawW;
  }
  const totalW = measureText(text, height, track, scaleX);
  let curX = x;
  if (opts.align === 'center') curX = x - totalW * 0.5;
  else if (opts.align === 'right') curX = x - totalW;

  const strokeW = opts.strokeW ?? Math.max(1.3, height * 0.13);
  const alpha = opts.alpha ?? 1;

  for (let i = 0; i < text.length; i++) {
    const g = GLYPHS[text[i]] ?? GLYPHS[' '];
    for (const stroke of g.strokes) {
      const pts: Pt[] = stroke.map(([gx, gy]) => [curX + gx * height * scaleX, y + gy * height]);
      cv.strokePolyline(pts, strokeW, col, alpha);
    }
    if (opts.serif && g.serifs) {
      for (const [sx0, sx1, sy] of g.serifs) {
        cv.drawCapsule(
          curX + sx0 * height * scaleX,
          y + sy * height,
          curX + sx1 * height * scaleX,
          y + sy * height,
          strokeW * 0.36,
          col,
          alpha,
        );
      }
    }
    curX += (g.adv + track) * height * scaleX;
  }
}

// ---------- Scene Helpers ----------

function drawCloud(cv: Surface, cx: number, cy: number, s: number, col: RGB, alpha = 0.85): void {
  cv.fillCircle(cx, cy, s * 0.55, col, alpha);
  cv.fillCircle(cx - s * 0.48, cy + s * 0.14, s * 0.42, col, alpha);
  cv.fillCircle(cx + s * 0.52, cy + s * 0.12, s * 0.44, col, alpha);
  cv.fillCircle(cx + s * 0.15, cy - s * 0.24, s * 0.38, col, alpha);
}

function drawSmokePlume(cv: Surface, x: number, y: number, scale: number): void {
  const puffs: readonly [number, number, number, RGB, number][] = [
    [0, 0, 12, [42, 42, 48], 0.85],
    [8, -11, 15, [54, 54, 62], 0.82],
    [20, -22, 18, [72, 72, 80], 0.72],
    [34, -30, 20, [94, 94, 102], 0.55],
    [50, -35, 22, [118, 118, 126], 0.38],
  ];
  for (const [dx, dy, r, col, a] of puffs) {
    cv.fillCircle(x + dx * scale, y + dy * scale, r * scale, col, a);
  }
}

function drawBlast(cv: Surface, cx: number, cy: number, r: number): void {
  cv.fillRadialGlow(cx, cy, r * 2.2, [255, 120, 20], 0.72);
  cv.fillStar(cx, cy, r * 1.15, r * 0.55, 9, [238, 72, 22], 0.95);
  cv.fillStar(cx, cy, r * 0.78, r * 0.36, 7, [255, 192, 42], 0.96, 15);
  cv.fillCircle(cx, cy, r * 0.32, [255, 248, 208], 0.98);
}

function drawScalesOfJustice(cv: Surface, cx: number, cy: number, s: number, col: RGB): void {
  // Base and pillar
  cv.fillRect(cx - 18 * s, cy + 28 * s, 36 * s, 5 * s, col);
  cv.fillRect(cx - 10 * s, cy + 23 * s, 20 * s, 5 * s, col);
  cv.drawCapsule(cx, cy - 26 * s, cx, cy + 24 * s, 2.2 * s, col);
  cv.fillCircle(cx, cy - 28 * s, 3.8 * s, col);
  // Crossbeam
  cv.drawCapsule(cx - 32 * s, cy - 18 * s, cx + 32 * s, cy - 18 * s, 2.0 * s, col);
  // Left pan
  const lx = cx - 28 * s;
  const rx = cx + 28 * s;
  const py = cy + 6 * s;
  cv.drawCapsule(lx, cy - 18 * s, lx - 10 * s, py, 1.0 * s, col);
  cv.drawCapsule(lx, cy - 18 * s, lx + 10 * s, py, 1.0 * s, col);
  cv.fillPolygon(
    [[lx - 13 * s, py], [lx + 13 * s, py], [lx + 8 * s, py + 7 * s], [lx - 8 * s, py + 7 * s]],
    col,
  );
  // Right pan
  cv.drawCapsule(rx, cy - 18 * s, rx - 10 * s, py, 1.0 * s, col);
  cv.drawCapsule(rx, cy - 18 * s, rx + 10 * s, py, 1.0 * s, col);
  cv.fillPolygon(
    [[rx - 13 * s, py], [rx + 13 * s, py], [rx + 8 * s, py + 7 * s], [rx - 8 * s, py + 7 * s]],
    col,
  );
}

// ---------- 12 Editorial Scene Illustrators ----------

function drawUkraineShipStrike(cv: Surface, b: Rect): void {
  // Baltic dusk sky
  cv.fillGradV(b.x, b.y, b.w, b.h * 0.62, [28, 46, 74], [92, 118, 146]);
  // Distant cold coastline
  cv.fillPolygon(
    [
      [b.x, b.y + b.h * 0.62],
      [b.x + 48, b.y + b.h * 0.54],
      [b.x + 112, b.y + b.h * 0.58],
      [b.x + 180, b.y + b.h * 0.55],
      [b.x + b.w, b.y + b.h * 0.62],
    ],
    [48, 66, 88],
    0.85,
  );
  // Dark Gulf of Finland water
  cv.fillGradV(b.x, b.y + b.h * 0.62, b.w, b.h * 0.38, [18, 42, 70], [10, 22, 42]);

  // Cargo ship hull and deck containers
  const sx = b.x + 90;
  const sy = b.y + b.h * 0.62;
  // Smoke & fire from strike
  drawSmokePlume(cv, sx + 74, sy - 20, 1.0);
  // Hull (dark iron upper, rust-red waterline)
  cv.fillPolygon(
    [
      [sx - 18, sy - 16],
      [sx + 168, sy - 16],
      [sx + 150, sy + 12],
      [sx - 6, sy + 12],
    ],
    [34, 42, 54],
  );
  cv.fillPolygon(
    [
      [sx - 12, sy + 2],
      [sx + 157, sy + 2],
      [sx + 150, sy + 12],
      [sx - 6, sy + 12],
    ],
    [152, 42, 36],
  );
  // Superstructure bridge at stern (left)
  cv.fillRect(sx - 4, sy - 42, 34, 26, [232, 236, 240]);
  cv.fillRect(sx + 2, sy - 37, 22, 6, [34, 52, 74]);
  cv.fillRect(sx + 4, sy - 54, 10, 12, [180, 42, 38]);
  // Cargo containers along deck
  cv.fillRect(sx + 38, sy - 29, 26, 13, [46, 98, 146]);
  cv.fillRect(sx + 66, sy - 32, 24, 16, [176, 88, 38]);
  cv.fillRect(sx + 94, sy - 27, 28, 11, [54, 122, 86]);
  cv.fillRect(sx + 124, sy - 25, 22, 9, [130, 62, 62]);

  // Explosion on midship
  drawBlast(cv, sx + 72, sy - 20, 16);

  // Incoming delta-wing drone upper right
  const dx = b.x + b.w - 58;
  const dy = b.y + 34;
  cv.strokePolyline([[dx + 22, dy - 12], [dx - 8, dy + 6]], 1.4, [255, 220, 140], 0.5);
  cv.fillPolygon(
    [
      [dx - 16, dy + 5],
      [dx + 10, dy - 7],
      [dx + 6, dy + 4],
      [dx + 14, dy + 11],
    ],
    [22, 26, 32],
  );

  // Rolling sea wave highlights
  for (let i = 0; i < 6; i++) {
    const wx = b.x + 22 + i * 52;
    const wy = b.y + b.h - 24 + (i % 2) * 10;
    cv.drawCapsule(wx, wy, wx + 28, wy, 1.3, [120, 162, 198], 0.45);
  }
  // Fire reflection on water
  cv.fillRadialGlow(sx + 72, sy + 20, 34, [255, 130, 32], 0.35);
}

function drawRiyadhPifTower(cv: Surface, b: Rect): void {
  // Warm Saudi desert sunset sky
  cv.fillGradV(b.x, b.y, b.w, b.h, [42, 34, 72], [228, 134, 74]);
  // Horizon desert haze & city silhouette
  cv.fillRect(b.x, b.y + b.h - 28, b.w, 28, [34, 28, 44]);

  // Surrounding KAFD skyline towers
  const towers: readonly [number, number, number][] = [
    [18, 46, 28], [52, 64, 24], [82, 52, 30], [198, 56, 26], [232, 72, 28], [268, 48, 32],
  ];
  for (const [ox, th, tw] of towers) {
    cv.fillRect(b.x + ox, b.y + b.h - 22 - th, tw, th + 22, [46, 40, 62]);
    // Lit window strips
    for (let wy = b.y + b.h - 16 - th; wy < b.y + b.h - 24; wy += 8) {
      cv.fillRect(b.x + ox + 4, wy, tw - 8, 2, [242, 204, 130], 0.45);
    }
  }

  // Iconic Riyadh PIF Tower (crystalline faceted skyscraper)
  const cx = b.x + 154;
  const topY = b.y + 10;
  const botY = b.y + b.h;
  // Left sunlit facet
  cv.fillPolygon(
    [[cx, topY], [cx - 26, topY + 26], [cx - 30, botY], [cx, botY]],
    [116, 168, 206],
  );
  // Right shaded crystalline facet
  cv.fillPolygon(
    [[cx, topY], [cx + 26, topY + 26], [cx + 30, botY], [cx, botY]],
    [54, 88, 126],
  );
  // Diagonal glass mullions
  for (let i = 1; i <= 7; i++) {
    const yy = topY + 18 + i * 14;
    cv.drawCapsule(cx - 27, yy, cx, yy - 6, 0.8, [206, 232, 248], 0.55);
    cv.drawCapsule(cx, yy - 6, cx + 27, yy, 0.8, [26, 48, 76], 0.65);
  }
  cv.drawCapsule(cx, topY, cx, botY, 1.1, [230, 244, 255], 0.7);

  // Impact smoke & blast on upper-right side of PIF Tower
  drawSmokePlume(cv, cx + 18, topY + 34, 0.95);
  drawBlast(cv, cx + 16, topY + 36, 17);

  // Incoming drone from right
  const dx = b.x + b.w - 46;
  const dy = b.y + 34;
  cv.fillPolygon([[dx - 14, dy + 4], [dx + 12, dy - 6], [dx + 10, dy + 8]], [24, 22, 30]);
}

function drawHuaweiVerdict(cv: Surface, b: Rect): void {
  // Rich wood-paneled Brooklyn federal courtroom
  cv.fillGradV(b.x, b.y, b.w, b.h, [44, 26, 22], [88, 52, 36]);
  // Subtle wood wall panels
  for (let px = b.x + 16; px < b.x + b.w - 16; px += 48) {
    cv.strokeRect(px, b.y + 8, 38, b.h - 26, 1.5, [118, 74, 48], 0.5);
  }
  // Bench tabletop
  cv.fillGradV(b.x, b.y + b.h - 26, b.w, 26, [62, 36, 24], [36, 20, 14]);

  // Stylized microchip + red fan emblem on left (clear of kicker pill)
  const mx = b.x + 82;
  const my = b.y + 68;
  cv.fillRoundedRect(mx - 31, my - 26, 62, 52, 5, [22, 32, 44]);
  cv.strokeRect(mx - 31, my - 26, 62, 52, 2, [196, 162, 88]);
  // Circuit pins
  for (let i = -2; i <= 2; i++) {
    cv.fillRect(mx - 38, my + i * 10 - 1.5, 7, 3, [206, 172, 92]);
    cv.fillRect(mx + 31, my + i * 10 - 1.5, 7, 3, [206, 172, 92]);
    cv.fillRect(mx + i * 11 - 1.5, my - 33, 3, 7, [206, 172, 92]);
    cv.fillRect(mx + i * 11 - 1.5, my + 26, 3, 7, [206, 172, 92]);
  }
  // Crisp radiating crimson fan petals inside chip
  for (let k = -2; k <= 2; k++) {
    const a = (-90 + k * 30) * (Math.PI / 180);
    const bx0 = mx + Math.cos(a) * 4;
    const by0 = my + 12 + Math.sin(a) * 4;
    const tipX = mx + Math.cos(a) * 21;
    const tipY = my + 12 + Math.sin(a) * 21;
    const perpX = -Math.sin(a) * 3.8;
    const perpY = Math.cos(a) * 3.8;
    const midX = (bx0 + tipX) * 0.5;
    const midY = (by0 + tipY) * 0.5;
    cv.fillPolygon(
      [[bx0, by0], [midX + perpX, midY + perpY], [tipX, tipY], [midX - perpX, midY - perpY]],
      [214, 34, 38],
    );
  }

  // Judge's gavel striking center-right
  const gx = b.x + 174;
  const gy = b.y + 72;
  // Sound block
  cv.fillRoundedRect(gx - 22, gy + 16, 44, 12, 3, [152, 92, 46]);
  // Handle
  cv.drawCapsule(gx + 10, gy - 12, gx + 54, gy + 16, 4.5, [196, 130, 70]);
  // Gavel head
  cv.fillPolygon(
    [[gx - 18, gy - 20], [gx + 10, gy - 32], [gx + 22, gy - 6], [gx - 6, gy + 6]],
    [176, 108, 52],
  );
  cv.drawCapsule(gx - 13, gy - 14, gx + 14, gy - 26, 2.2, [238, 194, 108]);

  // Bold Crimson Verdict Seal ("10/12")
  const vx = b.x + b.w - 64;
  const vy = b.y + 38;
  cv.fillRoundedRect(vx - 44, vy - 22, 88, 44, 5, [174, 24, 28]);
  cv.strokeRect(vx - 41, vy - 19, 82, 38, 1.5, [252, 224, 186]);
  drawText(cv, 'GUILTY', vx, vy - 14, 12, WHITE, { align: 'center', strokeW: 1.8 });
  drawText(cv, '10 / 12', vx, vy + 2, 13, [255, 228, 142], { align: 'center', strokeW: 2.0 });
}

function drawShenzhouSpace(cv: Surface, b: Rect): void {
  // Deep orbital night sky
  cv.fillGradV(b.x, b.y, b.w, b.h, [8, 14, 36], [24, 46, 86]);
  // Deterministic starfield
  const stars: readonly [number, number, number][] = [
    [22, 18, 1.3], [54, 32, 1.0], [92, 14, 1.5], [134, 26, 1.1], [176, 16, 1.4],
    [224, 22, 1.0], [278, 18, 1.6], [296, 46, 1.2], [116, 52, 1.1], [42, 68, 1.2],
  ];
  for (const [sx, sy, sr] of stars) {
    cv.fillCircle(b.x + sx, b.y + sy, sr, [236, 242, 255], 0.9);
  }
  // Curved glowing Earth limb at bottom
  cv.fillCircle(b.x + b.w * 0.56, b.y + b.h + 150, 188, [34, 110, 182]);
  cv.strokeCircle(b.x + b.w * 0.56, b.y + b.h + 150, 188, 4, [132, 212, 255], 0.75);

  // Long March 2F / Shenzhou-24 rocket launching left-center
  const rx = b.x + 68;
  const ry = b.y + 52;
  // Roaring exhaust plume
  cv.fillRadialGlow(rx, ry + 48, 34, [255, 134, 32], 0.75);
  cv.fillPolygon([[rx - 8, ry + 34], [rx + 8, ry + 34], [rx + 2, ry + 66], [rx - 2, ry + 66]], [255, 186, 62]);
  cv.fillPolygon([[rx - 4, ry + 34], [rx + 4, ry + 34], [rx, ry + 56]], [255, 250, 218]);
  // Rocket core & side boosters
  cv.fillRect(rx - 6, ry - 18, 12, 52, [242, 244, 248]);
  cv.fillPolygon([[rx - 6, ry - 18], [rx, ry - 34], [rx + 6, ry - 18]], [222, 226, 234]);
  cv.fillRect(rx - 12, ry + 8, 5, 26, [224, 228, 236]);
  cv.fillRect(rx + 7, ry + 8, 5, 26, [224, 228, 236]);
  cv.fillRect(rx - 6, ry - 4, 12, 5, [196, 36, 36]);

  // Tiangong Space Station upper right
  const tx = b.x + 216;
  const ty = b.y + 50;
  // Blue solar array wings
  cv.fillRect(tx - 58, ty - 8, 34, 14, [38, 108, 198]);
  cv.fillRect(tx + 24, ty - 8, 34, 14, [38, 108, 198]);
  cv.fillRect(tx - 16, ty - 34, 32, 11, [48, 126, 216]);
  cv.strokeRect(tx - 58, ty - 8, 34, 14, 1, [164, 214, 255]);
  cv.strokeRect(tx + 24, ty - 8, 34, 14, 1, [164, 214, 255]);
  // T-shaped white station modules
  cv.fillRoundedRect(tx - 26, ty - 6, 52, 12, 3, [238, 242, 248]);
  cv.fillRoundedRect(tx - 6, ty - 24, 12, 42, 3, [218, 226, 236]);
  // Docked Shenzhou capsule nose
  cv.fillCircle(tx, ty + 20, 6, [186, 198, 214]);

  // Subtle dashed rendezvous trajectory arc from rocket toward Tiangong
  for (let s = 0; s < 7; s++) {
    const t0 = s / 7;
    const t1 = (s + 0.55) / 7;
    const x0 = lerp(rx + 10, tx - 30, t0);
    const y0 = lerp(ry - 16, ty + 14, t0) - Math.sin(t0 * Math.PI) * 18;
    const x1 = lerp(rx + 10, tx - 30, t1);
    const y1 = lerp(ry - 16, ty + 14, t1) - Math.sin(t1 * Math.PI) * 18;
    cv.drawCapsule(x0, y0, x1, y1, 1.0, [168, 220, 255], 0.55);
  }

  // Mini China & Pakistan flag emblems bottom-right
  const fx = b.x + b.w - 86;
  const fy = b.y + b.h - 26;
  // China flag
  cv.fillRect(fx, fy, 34, 20, [206, 28, 32]);
  cv.strokeRect(fx, fy, 34, 20, 0.8, WHITE, 0.4);
  cv.fillStar(fx + 8, fy + 8, 5, 2.2, 5, [252, 218, 62]);
  // Pakistan flag
  const px = fx + 42;
  cv.fillRect(px, fy, 34, 20, [14, 104, 56]);
  cv.fillRect(px, fy, 9, 20, WHITE);
  cv.strokeRect(px, fy, 34, 20, 0.8, WHITE, 0.4);
  cv.fillCircle(px + 21.5, fy + 10, 6.2, WHITE);
  cv.fillCircle(px + 23.8, fy + 8.5, 5.2, [14, 104, 56]);
  cv.fillStar(px + 26.2, fy + 7.2, 2.7, 1.1, 5, WHITE);
}

function drawMedalOfFreedom(cv: Surface, b: Rect): void {
  // Ceremonial White House navy backdrop
  cv.fillGradV(b.x, b.y, b.w, b.h, [20, 36, 68], [38, 62, 104]);
  // Classical white columns left & right
  for (const cx of [b.x + 24, b.x + 56, b.x + b.w - 56, b.x + b.w - 24]) {
    cv.fillRect(cx - 8, b.y + 8, 16, b.h - 16, [232, 228, 218], 0.25);
    cv.fillRect(cx - 11, b.y + 8, 22, 6, [242, 238, 228], 0.35);
  }
  // Subtle US crimson & cream drapery stripes at bottom corners
  cv.fillRect(b.x, b.y + b.h - 14, b.w, 6, [176, 32, 38], 0.8);
  cv.fillRect(b.x, b.y + b.h - 8, b.w, 8, [236, 232, 222], 0.8);

  // Presidential Medal of Freedom ribbon (royal blue with white outer stripes)
  const mx = b.x + b.w * 0.5;
  const my = b.y + 72;
  cv.fillPolygon(
    [[mx - 46, b.y], [mx - 14, b.y], [mx + 4, my - 18], [mx - 16, my - 18]],
    [22, 82, 168],
  );
  cv.fillPolygon(
    [[mx + 14, b.y], [mx + 46, b.y], [mx + 16, my - 18], [mx - 4, my - 18]],
    [18, 68, 146],
  );
  // Crisp white ribbon borders
  cv.drawCapsule(mx - 43, b.y, mx - 14, my - 18, 2.2, WHITE, 0.9);
  cv.drawCapsule(mx + 43, b.y, mx + 14, my - 18, 2.2, WHITE, 0.9);

  // Golden radiant glow behind medal
  cv.fillRadialGlow(mx, my, 48, [255, 214, 96], 0.45);
  // Gold eagle/ray backing pentagon
  cv.fillStar(mx, my, 36, 20, 5, [214, 166, 48], 1, -54);
  // White enamel 5-pointed star with gold outline
  cv.fillStar(mx, my, 34, 14, 5, [234, 186, 62], 1, -90);
  cv.fillStar(mx, my, 29, 11.5, 5, [252, 250, 244], 1, -90);
  // Royal blue center disc with golden stars
  cv.fillCircle(mx, my, 12.5, [20, 62, 138]);
  cv.strokeCircle(mx, my, 12.5, 2, [236, 188, 64]);
  cv.fillStar(mx, my, 5.5, 2.3, 5, [252, 216, 86]);
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3;
    cv.fillCircle(mx + Math.cos(a) * 8.2, my + Math.sin(a) * 8.2, 1.3, [255, 232, 134]);
  }
}

function drawIraqOilfields(cv: Surface, b: Rect): void {
  // Amber Mesopotamian dusk sky
  cv.fillGradV(b.x, b.y, b.w, b.h * 0.72, [68, 38, 46], [234, 144, 62]);
  // Setting sun glow
  cv.fillRadialGlow(b.x + 112, b.y + 66, 56, [255, 196, 88], 0.65);
  // Distant hills
  cv.fillPolygon(
    [
      [b.x, b.y + b.h * 0.72],
      [b.x + 70, b.y + b.h * 0.58],
      [b.x + 165, b.y + b.h * 0.66],
      [b.x + 255, b.y + b.h * 0.56],
      [b.x + b.w, b.y + b.h * 0.68],
      [b.x + b.w, b.y + b.h],
      [b.x, b.y + b.h],
    ],
    [66, 44, 34],
  );
  // Foreground arid ground
  cv.fillRect(b.x, b.y + b.h * 0.74, b.w, b.h * 0.26, [34, 24, 22]);

  // Oil derrick tower left-center
  const dx = b.x + 86;
  const base = b.y + b.h * 0.76;
  cv.drawCapsule(dx - 16, base, dx - 3, base - 64, 2.0, [22, 18, 20]);
  cv.drawCapsule(dx + 16, base, dx + 3, base - 64, 2.0, [22, 18, 20]);
  cv.drawCapsule(dx - 11, base - 20, dx + 11, base - 20, 1.5, [22, 18, 20]);
  cv.drawCapsule(dx - 8, base - 42, dx + 8, base - 42, 1.5, [22, 18, 20]);
  cv.drawCapsule(dx - 11, base - 20, dx + 8, base - 42, 1.1, [22, 18, 20]);
  cv.drawCapsule(dx + 11, base - 20, dx - 8, base - 42, 1.1, [22, 18, 20]);

  // Pumpjack silhouette middle
  const px = b.x + 174;
  cv.fillPolygon([[px - 10, base], [px, base - 34], [px + 10, base]], [20, 16, 18]);
  cv.drawCapsule(px - 24, base - 26, px + 26, base - 40, 3.2, [20, 16, 18]);
  // Horsehead curve
  cv.fillPolygon([[px + 22, base - 48], [px + 32, base - 42], [px + 28, base - 26], [px + 20, base - 32]], [20, 16, 18]);
  cv.drawCapsule(px + 28, base - 32, px + 28, base, 1.2, [20, 16, 18]);

  // Gas flare stack right
  const fx = b.x + 256;
  cv.drawCapsule(fx, base, fx, base - 52, 2.2, [24, 20, 22]);
  cv.fillRadialGlow(fx, base - 58, 24, [255, 148, 36], 0.8);
  cv.fillPolygon([[fx - 6, base - 52], [fx + 6, base - 52], [fx + 3, base - 72], [fx - 2, base - 64]], [255, 208, 66]);

  // Federal armored convoy silhouettes along pipeline road with headlights
  cv.drawCapsule(b.x, base + 4, b.x + b.w, base + 4, 2.4, [82, 70, 60]);
  for (const vx of [b.x + 36, b.x + 128, b.x + 214]) {
    cv.fillRoundedRect(vx, base + 6, 32, 11, 2, [74, 84, 66]);
    cv.fillRect(vx + 7, base + 2, 15, 5, [62, 72, 56]);
    cv.drawCapsule(vx + 22, base + 4, vx + 34, base + 3, 1.1, [88, 96, 78]);
    cv.fillCircle(vx + 32, base + 10, 2.2, [255, 234, 150], 0.9);
    cv.fillCircle(vx + 7, base + 17, 3.5, [18, 18, 20]);
    cv.fillCircle(vx + 25, base + 17, 3.5, [18, 18, 20]);
  }
}

function drawNatoAwacs(cv: Surface, b: Rect): void {
  // NATO tactical blue radar sky
  cv.fillGradV(b.x, b.y, b.w, b.h, [14, 38, 76], [28, 72, 128]);

  // Sweeping green radar rings centered near AWACS
  const rcx = b.x + 168;
  const rcy = b.y + 56;
  for (const r of [24, 48, 74, 102]) {
    cv.strokeCircle(rcx, rcy, r, 1.3, [76, 232, 152], 0.42);
  }
  cv.drawCapsule(rcx - 108, rcy, rcx + 108, rcy, 0.7, [76, 232, 152], 0.3);
  cv.drawCapsule(rcx, rcy - 54, rcx, rcy + 54, 0.7, [76, 232, 152], 0.3);
  // Radar sweep wedge
  cv.fillPolygon([[rcx, rcy], [rcx + 92, rcy - 36], [rcx + 98, rcy + 6]], [76, 238, 156], 0.16);

  // Poland border strip along bottom (white over crimson)
  cv.fillRect(b.x, b.y + b.h - 20, b.w, 10, [242, 244, 248], 0.92);
  cv.fillRect(b.x, b.y + b.h - 10, b.w, 10, [206, 28, 44], 0.95);

  // NATO E-3 AWACS aircraft silhouette (flying left-to-right slightly banking)
  const ax = b.x + 160;
  const ay = b.y + 62;
  // Fuselage
  cv.fillPolygon(
    [
      [ax - 74, ay + 4],
      [ax + 58, ay - 6],
      [ax + 78, ay - 2],
      [ax + 56, ay + 6],
      [ax - 72, ay + 10],
    ],
    [224, 232, 242],
  );
  // Swept wings
  cv.fillPolygon([[ax - 8, ay + 2], [ax + 24, ay - 1], [ax - 18, ay + 28], [ax - 36, ay + 26]], [190, 204, 222]);
  cv.fillPolygon([[ax - 6, ay - 1], [ax + 16, ay - 3], [ax - 24, ay - 24], [ax - 38, ay - 22]], [164, 182, 204]);
  // Tail fin
  cv.fillPolygon([[ax - 66, ay + 4], [ax - 82, ay - 22], [ax - 66, ay - 22], [ax - 48, ay + 3]], [204, 216, 232]);
  // Iconic dorsal radar rotodome & struts!
  cv.drawCapsule(ax - 26, ay + 2, ax - 24, ay - 14, 2.2, [146, 160, 178]);
  cv.drawCapsule(ax - 14, ay + 1, ax - 14, ay - 14, 2.2, [146, 160, 178]);
  cv.fillEllipse(ax - 18, ay - 16, 28, 7.5, [244, 248, 252]);
  cv.fillRect(ax - 34, ay - 18, 32, 4, [24, 52, 98]);

  // NATO compass emblem upper-right + tracked radar warning blip
  const nx = b.x + b.w - 34;
  const ny = b.y + 28;
  cv.strokeCircle(nx, ny, 14, 1.6, WHITE, 0.85);
  cv.fillStar(nx, ny, 15, 3.5, 4, WHITE, 0.92, 0);
  // Tracked border alert blip on right radar arc
  const bx = b.x + b.w - 52;
  const by = b.y + 72;
  cv.strokeCircle(bx, by, 9, 1.2, [255, 92, 76], 0.75);
  cv.fillCircle(bx, by, 3.5, [255, 110, 86], 0.95);
}

function drawSarkozyTrial(cv: Surface, b: Rect): void {
  // Parisian dusk slate-blue sky
  cv.fillGradV(b.x, b.y, b.w, b.h, [42, 54, 78], [94, 112, 138]);

  // Neoclassical Palais de Justice facade
  const cx = b.x + b.w * 0.5;
  const base = b.y + b.h - 14;
  // Pediment roof
  cv.fillPolygon([[cx - 98, b.y + 38], [cx, b.y + 12], [cx + 98, b.y + 38]], [226, 218, 200]);
  cv.fillRect(cx - 94, b.y + 38, 188, 7, [202, 192, 172]);
  // Recess behind columns
  cv.fillRect(cx - 86, b.y + 45, 172, base - (b.y + 45), [58, 54, 52]);
  // Limestone columns
  for (let i = -3; i <= 3; i++) {
    const colX = cx + i * 24;
    cv.fillRect(colX - 5, b.y + 45, 10, base - (b.y + 45), [232, 224, 208]);
    cv.fillRect(colX + 2, b.y + 45, 3, base - (b.y + 45), [194, 184, 166]);
  }
  // Courthouse steps
  cv.fillRect(cx - 108, base - 8, 216, 8, [218, 210, 192]);

  // Golden scales of justice emblem centered prominently
  cv.fillCircle(cx, b.y + 72, 34, [24, 34, 58], 0.88);
  cv.strokeCircle(cx, b.y + 72, 34, 2.2, [226, 184, 82]);
  drawScalesOfJustice(cv, cx, b.y + 74, 0.72, [242, 202, 96]);

  // French tricolor bar along bottom
  const third = b.w / 3;
  cv.fillRect(b.x, b.y + b.h - 12, third, 12, [18, 52, 146]);
  cv.fillRect(b.x + third, b.y + b.h - 12, third, 12, [246, 246, 246]);
  cv.fillRect(b.x + third * 2, b.y + b.h - 12, third + 1, 12, [208, 34, 44]);
}

function drawBangladeshWage(cv: Surface, b: Rect): void {
  // Deep Bangladesh emerald green backdrop with subtle vertical shading
  cv.fillGradV(b.x, b.y, b.w, b.h, [10, 82, 58], [16, 114, 78]);
  // Iconic crimson sun disc offset left-center
  cv.fillCircle(b.x + 128, b.y + 62, 38, [208, 36, 52], 0.9);

  // Stylized garment sewing machine silhouette on left
  const sx = b.x + 34;
  const sy = b.y + 92;
  cv.fillRoundedRect(sx, sy, 86, 14, 3, [240, 242, 244]);
  cv.fillRoundedRect(sx + 58, sy - 40, 24, 42, 4, [240, 242, 244]);
  cv.fillRoundedRect(sx + 8, sy - 42, 70, 15, 4, [240, 242, 244]);
  cv.fillRect(sx + 14, sy - 27, 8, 12, [202, 210, 218]);
  // Needle
  cv.drawCapsule(sx + 18, sy - 15, sx + 18, sy - 2, 1.2, [24, 30, 36]);
  // Thread spool on top
  cv.fillRect(sx + 52, sy - 54, 12, 12, [248, 206, 78]);
  // Fabric strip flowing out
  cv.fillPolygon([[sx - 12, sy + 2], [sx + 34, sy - 2], [sx + 34, sy + 6], [sx - 12, sy + 12]], [244, 224, 156]);

  // Bold rising wage chart & badge on right (separated cleanly from badge)
  const cx = b.x + 184;
  const base = b.y + b.h - 12;
  cv.fillRect(cx, base - 20, 20, 20, [186, 232, 204], 0.78);
  cv.fillRect(cx + 26, base - 34, 20, 34, [212, 244, 220], 0.88);
  cv.fillRect(cx + 52, base - 52, 24, 52, [248, 208, 76], 0.96);
  // Upward bold arrow cleanly below badge
  cv.drawCapsule(cx - 4, base - 26, cx + 62, base - 58, 3.0, WHITE);
  cv.fillPolygon(
    [[cx + 68, base - 61], [cx + 51, base - 60], [cx + 61, base - 46]],
    WHITE,
  );
  // Crisp "+36%" and "$139/MO" callout badge upper-right
  cv.fillRoundedRect(b.x + b.w - 94, b.y + 8, 84, 44, 5, [14, 38, 30], 0.94);
  cv.strokeRect(b.x + b.w - 94, b.y + 8, 84, 44, 1.5, [248, 208, 76]);
  drawText(cv, '+36%', b.x + b.w - 52, b.y + 13, 15.5, [248, 214, 88], { align: 'center', strokeW: 2.3 });
  drawText(cv, '$139/MO', b.x + b.w - 52, b.y + 33, 11.5, WHITE, { align: 'center', strokeW: 1.7 });
}

function drawChemicalWarning(cv: Surface, b: Rect): void {
  // Diplomatic slate-navy backdrop
  cv.fillGradV(b.x, b.y, b.w, b.h, [24, 34, 52], [44, 58, 82]);

  // Left side: 30+ coalition arc of mini flags + "30+" emblem (clear of kicker pill)
  const lx = b.x + 88;
  const ly = b.y + 82;
  const flagCols: readonly RGB[] = [
    [32, 86, 178], [210, 42, 48], [238, 190, 44], [32, 138, 74],
    [232, 108, 36], [24, 122, 184], [186, 34, 54], [240, 242, 246], [42, 92, 168],
  ];
  for (let i = 0; i < flagCols.length; i++) {
    const a = (-168 + i * 19.5) * (Math.PI / 180);
    const fx = lx + Math.cos(a) * 52;
    const fy = ly + Math.sin(a) * 40;
    cv.fillRoundedRect(fx - 8, fy - 5, 16, 10, 2, flagCols[i]);
    cv.strokeRect(fx - 8, fy - 5, 16, 10, 0.8, WHITE, 0.6);
  }
  cv.fillCircle(lx, ly, 27, [20, 48, 92]);
  cv.strokeCircle(lx, ly, 27, 2.2, [132, 186, 242]);
  drawText(cv, '30+', lx, ly - 14, 20, WHITE, { align: 'center', strokeW: 2.7 });
  drawText(cv, 'STATES', lx, ly + 8, 9, [196, 222, 250], { align: 'center', strokeW: 1.4 });

  // Right side: Yellow hazard chemical flask / gas emblem with crimson prohibition slash
  const rx = b.x + 228;
  const ry = b.y + 64;
  // Yellow caution triangle behind
  cv.fillPolygon([[rx, ry - 44], [rx - 46, ry + 34], [rx + 46, ry + 34]], [242, 198, 42]);
  cv.fillPolygon([[rx, ry - 34], [rx - 36, ry + 27], [rx + 36, ry + 27]], [32, 34, 40]);
  // Toxic green-yellow flask & fumes inside
  cv.fillPolygon([[rx - 6, ry - 12], [rx + 6, ry - 12], [rx + 18, ry + 20], [rx - 18, ry + 20]], [168, 226, 62]);
  cv.fillRect(rx - 5, ry - 20, 10, 10, [168, 226, 62]);
  cv.fillCircle(rx - 6, ry - 26, 4, [196, 242, 92], 0.85);
  cv.fillCircle(rx + 6, ry - 30, 3.2, [196, 242, 92], 0.8);
  // Crisp crimson prohibition circle + diagonal slash
  cv.strokeCircle(rx, ry + 2, 38, 6, [212, 34, 38]);
  cv.drawCapsule(rx - 26, ry - 24, rx + 26, ry + 28, 3.2, [212, 34, 38]);
}

function drawSpainElection(cv: Surface, b: Rect): void {
  // Bold Spanish flag background bands (red - gold - red)
  const h1 = b.h * 0.27;
  const h2 = b.h * 0.46;
  cv.fillGradV(b.x, b.y, b.w, h1, [178, 22, 32], [198, 28, 38]);
  cv.fillGradV(b.x, b.y + h1, b.w, h2, [246, 198, 38], [236, 182, 26]);
  cv.fillGradV(b.x, b.y + h1 + h2, b.w, b.h - h1 - h2, [192, 26, 36], [164, 18, 28]);

  // Subtle flanking polling bars (PSOE red left, conservative blue right)
  cv.fillRect(b.x + 28, b.y + 62, 22, 42, [186, 28, 36], 0.55);
  cv.strokeRect(b.x + 28, b.y + 62, 22, 42, 1, [96, 20, 24], 0.5);
  cv.fillRect(b.x + b.w - 50, b.y + 42, 22, 62, [24, 78, 158], 0.65);
  cv.strokeRect(b.x + b.w - 50, b.y + 42, 22, 62, 1, [16, 48, 98], 0.55);

  // Subtle dark center band vignette for ballot box pop
  cv.fillRadialGlow(b.x + b.w * 0.5, b.y + b.h * 0.58, 95, [28, 22, 18], 0.28);

  // Clean ballot box centered
  const cx = b.x + b.w * 0.5;
  const bx = cx - 54;
  const by = b.y + 48;
  // Drop shadow
  cv.fillRect(bx + 5, by + 5, 108, 64, [30, 20, 14], 0.3);
  // Box front & top lid
  cv.fillPolygon([[bx - 6, by], [bx + 114, by], [bx + 104, by - 14], [bx + 4, by - 14]], [244, 242, 236]);
  cv.fillRect(bx, by, 108, 64, [252, 250, 246]);
  cv.fillRect(bx + 84, by, 24, 64, [224, 220, 212]);
  cv.strokeRect(bx, by, 108, 64, 2, [42, 38, 36]);
  // Dark ballot slot on lid
  cv.fillRect(cx - 26, by - 9, 52, 5, [24, 24, 28]);

  // Ballot paper dropping into slot
  cv.fillPolygon(
    [[cx - 20, by - 36], [cx + 22, by - 32], [cx + 18, by - 7], [cx - 18, by - 7]],
    WHITE,
  );
  cv.strokePolyline([[cx - 20, by - 36], [cx + 22, by - 32], [cx + 18, by - 7]], 1.4, [60, 64, 72]);
  // Checkmark on ballot
  cv.strokePolyline([[cx - 6, by - 22], [cx, by - 16], [cx + 10, by - 28]], 2.4, [186, 26, 36]);

  // Text on ballot box front
  drawText(cv, '29 NOV', cx - 10, by + 15, 15, [26, 32, 46], { align: 'center', strokeW: 2.2 });
  drawText(cv, 'VOTE', cx - 10, by + 37, 16, [186, 24, 34], { align: 'center', strokeW: 2.4 });
}

function drawRealMadridPsv(cv: Surface, b: Rect): void {
  // Champions League floodlit midnight stadium sky
  cv.fillGradV(b.x, b.y, b.w, b.h * 0.62, [10, 20, 48], [24, 48, 96]);
  // Stadium upper tier silhouette
  cv.fillRect(b.x, b.y + b.h * 0.50, b.w, b.h * 0.12, [18, 28, 54], 0.85);
  // Stadium floodlight beams from top corners
  cv.fillRadialGlow(b.x + 26, b.y + 14, 72, [210, 232, 255], 0.48);
  cv.fillRadialGlow(b.x + b.w - 26, b.y + 14, 72, [210, 232, 255], 0.48);

  // Lush striped emerald pitch at bottom
  const py = b.y + b.h * 0.62;
  const ph = b.h - (py - b.y);
  cv.fillGradV(b.x, py, b.w, ph, [28, 128, 58], [20, 96, 44]);
  for (let i = 0; i < 6; i += 2) {
    cv.fillRect(b.x + i * 54, py, 54, ph, [42, 152, 72], 0.42);
  }
  // White pitch line, center arc & right-side goal net
  cv.fillRect(b.x, py + 4, b.w, 2, WHITE, 0.7);
  cv.strokeCircle(b.x + b.w * 0.44, py + 26, 24, 1.8, WHITE, 0.55);
  const gx = b.x + b.w - 46;
  cv.strokeRect(gx, py - 14, 42, 34, 2, WHITE, 0.8);
  for (let nx = gx + 7; nx < gx + 40; nx += 7) {
    cv.drawCapsule(nx, py - 13, nx, py + 19, 0.5, WHITE, 0.35);
  }
  for (let ny = py - 7; ny < py + 18; ny += 7) {
    cv.drawCapsule(gx + 1, ny, gx + 41, ny, 0.5, WHITE, 0.35);
  }

  // Crisp Stadium Scoreboard centered cleanly below kicker
  const sx = b.x + 56;
  const sy = b.y + 24;
  const sw = b.w - 112;
  const sh = 42;
  cv.fillRoundedRect(sx, sy, sw, sh, 6, [12, 16, 28], 0.95);
  cv.strokeRect(sx, sy, sw, sh, 2, [226, 186, 84]);
  // Team color tabs
  cv.fillRect(sx + 6, sy + 7, 7, sh - 14, WHITE);
  cv.fillRect(sx + sw - 13, sy + 7, 7, sh - 14, [214, 34, 42]);
  drawText(cv, 'RMA  5 - 1  PSV', b.x + b.w * 0.5, sy + 12.5, 17, WHITE, {
    align: 'center',
    strokeW: 2.5,
  });

  // Dynamic soaring soccer ball heading toward goal with golden shot arc
  const bx = b.x + b.w - 64;
  const by = b.y + b.h - 24;
  cv.strokePolyline(
    [[b.x + 76, b.y + b.h - 8], [b.x + 146, b.y + b.h - 32], [bx - 16, by - 2]],
    3.0,
    [252, 212, 82],
    0.76,
  );
  cv.fillCircle(bx, by, 14, WHITE);
  cv.strokeCircle(bx, by, 14, 1.5, [28, 32, 40]);
  cv.fillStar(bx, by, 6, 4.8, 5, [26, 30, 38]);
  for (let i = 0; i < 5; i++) {
    const a = (-90 + i * 72) * (Math.PI / 180);
    cv.drawCapsule(bx + Math.cos(a) * 5, by + Math.sin(a) * 5, bx + Math.cos(a) * 13, by + Math.sin(a) * 13, 1.1, [34, 38, 46]);
  }
}

// ---------- Data-Driven Story Roster (12 Verified Stories for Wed 25 Nov 2026) ----------

const STORIES: readonly StoryCard[] = [
  {
    id: 'ukraine-ship',
    kicker: 'UKRAINE',
    accent: [24, 92, 168],
    headline: ['ZELENSKIY CONFIRMS', 'GULF OF FINLAND STRIKE'],
    subline: 'Drone hit Russian cargo ship; Norway urges caution',
    drawIllustration: drawUkraineShipStrike,
  },
  {
    id: 'riyadh-pif',
    kicker: 'MIDDLE EAST',
    accent: [188, 64, 24],
    headline: ['HOUTHIS STRIKE RIYADH', 'PIF TOWER, 11 WOUNDED'],
    subline: '2nd drone hit in a week; coalition vows response',
    drawIllustration: drawRiyadhPifTower,
  },
  {
    id: 'huawei-verdict',
    kicker: 'US-CHINA',
    accent: [162, 26, 34],
    headline: ['HUAWEI CONVICTED ON', '10 OF 12 US COUNTS'],
    subline: 'Brooklyn jury: fraud & Iran sanctions violations',
    drawIllustration: drawHuaweiVerdict,
  },
  {
    id: 'shenzhou-24',
    kicker: 'SPACE',
    accent: [26, 86, 152],
    headline: ['SHENZHOU-24 LAUNCHES', "PAKISTAN'S ZEESHAN ALI"],
    subline: "1st foreign astronaut docks at China's Tiangong",
    drawIllustration: drawShenzhouSpace,
  },
  {
    id: 'giuliani-medal',
    kicker: 'US POLITICS',
    accent: [28, 62, 134],
    headline: ['TRUMP AWARDS GIULIANI', 'MEDAL OF FREEDOM'],
    subline: 'Presidential Medal of Freedom presented Wednesday',
    drawIllustration: drawMedalOfFreedom,
  },
  {
    id: 'iraq-oilfields',
    kicker: 'IRAQ',
    accent: [176, 94, 24],
    headline: ['IRAQ PM ORDERS SEIZURE', 'OF KURDISH OILFIELDS'],
    subline: 'Federal units told to take oil sites and crossings',
    drawIllustration: drawIraqOilfields,
  },
  {
    id: 'nato-poland',
    kicker: 'NATO / EUROPE',
    accent: [22, 82, 148],
    headline: ['NATO TO DEPLOY AWACS', 'AIRCRAFT IN POLAND'],
    subline: 'Early-warning jets sent after missile reports',
    drawIllustration: drawNatoAwacs,
  },
  {
    id: 'sarkozy-trial',
    kicker: 'FRANCE',
    accent: [44, 66, 138],
    headline: ['SARKOZY & CARLA BRUNI', 'ORDERED TO TRIAL'],
    subline: 'French corruption case; pre-trial April 2027',
    drawIllustration: drawSarkozyTrial,
  },
  {
    id: 'bangladesh-wage',
    kicker: 'ASIA / ECONOMY',
    accent: [16, 118, 76],
    headline: ['BANGLADESH RAISES', 'GARMENT WAGE 36%'],
    subline: 'Monthly minimum raised to $139 after protests',
    drawIllustration: drawBangladeshWage,
  },
  {
    id: 'russia-chemical',
    kicker: 'DIPLOMACY',
    accent: [172, 34, 42],
    headline: ['30+ NATIONS URGE RUSSIA:', 'HALT CHEMICAL AGENTS'],
    subline: 'Joint statement condemns toxic agents in Ukraine',
    drawIllustration: drawChemicalWarning,
  },
  {
    id: 'spain-election',
    kicker: 'SPAIN / EUROPE',
    accent: [188, 34, 38],
    headline: ['SPAIN HEADS TO SNAP', 'ELECTION ON SUNDAY'],
    subline: 'PSOE trails right bloc ahead of Nov 29 vote',
    drawIllustration: drawSpainElection,
  },
  {
    id: 'real-madrid-psv',
    kicker: 'SPORT',
    accent: [24, 116, 56],
    headline: ['REAL MADRID ROUTS', 'PSV 5-1 IN EUROPE'],
    subline: 'Bellingham stunner & Mbappe brace seal comeback',
    drawIllustration: drawRealMadridPsv,
  },
];

// ---------- Broadsheet Grid Renderer ----------

function drawPaperBackdrop(cv: Surface): void {
  cv.fillGradV(0, 0, IMG_W, IMG_H, PAPER_TOP, PAPER_BOT);
  // Subtle archival horizontal laid-paper lines (deterministic, highly compressible)
  for (let y = 0; y < IMG_H; y += 6) {
    cv.fillRect(0, y, IMG_W, 1, [224, 214, 196], 0.25);
  }
  // Classic double broadsheet border frame
  cv.strokeRect(8, 8, IMG_W - 16, IMG_H - 16, 2, RULE_DARK);
  cv.strokeRect(12, 12, IMG_W - 24, IMG_H - 24, 1, RULE_SOFT);
}

function drawMastheadAndRibbon(cv: Surface): void {
  // Left & right editorial ear boxes
  const earY = 20;
  const earH = 44;
  const earW = 158;
  cv.fillRect(18, earY, earW, earH, CARD_BG);
  cv.strokeRect(18, earY, earW, earH, 1.5, RULE_DARK);
  drawText(cv, 'WORLD EDITION', 97, earY + 10, 11, INK_DARK, { align: 'center', strokeW: 1.7 });
  drawText(cv, 'GLOBAL SUMMARY', 97, earY + 26, 9.5, INK_BODY, { align: 'center', strokeW: 1.3 });

  const rightX = IMG_W - 18 - earW;
  cv.fillRect(rightX, earY, earW, earH, CARD_BG);
  cv.strokeRect(rightX, earY, earW, earH, 1.5, RULE_DARK);
  drawText(cv, '12 KEY STORIES', rightX + earW * 0.5, earY + 10, 11, [148, 22, 26], { align: 'center', strokeW: 1.8 });
  drawText(cv, 'ALL REGIONS', rightX + earW * 0.5, earY + 26, 9.5, INK_BODY, { align: 'center', strokeW: 1.3 });

  // Prestige Broadsheet Masthead Title
  drawText(cv, 'THE WORLD CHRONICLE', IMG_W * 0.5 + 1.5, 25.5, 37, [186, 174, 152], {
    align: 'center',
    strokeW: 4.5,
    track: 0.08,
    serif: true,
    maxWidth: 626,
  });
  drawText(cv, 'THE WORLD CHRONICLE', IMG_W * 0.5, 24, 37, INK_DARK, {
    align: 'center',
    strokeW: 4.5,
    track: 0.08,
    serif: true,
    maxWidth: 626,
  });

  // High-Contrast Prominent Date Ribbon
  const ribX = 18;
  const ribY = 71;
  const ribW = IMG_W - 36;
  const ribH = 38;
  cv.fillGradV(ribX, ribY, ribW, ribH, RIBBON_TOP, RIBBON_BOT);
  cv.fillRect(ribX, ribY, ribW, 2, GOLD_TRIM);
  cv.fillRect(ribX, ribY + ribH - 2, ribW, 2, GOLD_TRIM);
  cv.strokeRect(ribX, ribY, ribW, ribH, 1, INK_DARK);

  // Flanking gold diamonds
  for (const dx of [ribX + 42, ribX + ribW - 42]) {
    const dy = ribY + ribH * 0.5;
    cv.fillPolygon([[dx, dy - 6], [dx + 6, dy], [dx, dy + 6], [dx - 6, dy]], GOLD_TRIM);
  }

  // Prominent Date Text
  drawText(cv, 'WEDNESDAY 25 NOVEMBER 2026', IMG_W * 0.5, ribY + 8.5, 21, WHITE, {
    align: 'center',
    strokeW: 3.3,
    track: 0.11,
    maxWidth: ribW - 120,
  });

  // Double broadsheet rule below ribbon
  cv.fillRect(18, 113, IMG_W - 36, 2, RULE_DARK);
  cv.fillRect(18, 116, IMG_W - 36, 1, RULE_SOFT);
}

function drawStoryCard(cv: Surface, story: StoryCard, rect: Rect): void {
  // Card paper surface and fine dark frame
  cv.fillRect(rect.x, rect.y, rect.w, rect.h, CARD_BG);
  cv.strokeRect(rect.x, rect.y, rect.w, rect.h, 1.5, [64, 58, 52]);

  // Clipped editorial illustration viewport
  const illusBox: Rect = {
    x: rect.x + 3,
    y: rect.y + 3,
    w: rect.w - 6,
    h: 120,
  };
  cv.setClip(illusBox);
  story.drawIllustration(cv, illusBox);
  cv.clearClip();
  cv.strokeRect(illusBox.x, illusBox.y, illusBox.w, illusBox.h, 1, [48, 44, 40]);

  // Crisp region/beat kicker pill at top-left of illustration
  const kickerH = 10;
  const kickerW = Math.ceil(measureText(story.kicker, kickerH, 0.08, 1) + 14);
  const kx = illusBox.x + 5;
  const ky = illusBox.y + 5;
  cv.fillRoundedRect(kx, ky, kickerW, 18, 3, story.accent, 0.94);
  cv.strokeRect(kx, ky, kickerW, 18, 1, WHITE, 0.45);
  drawText(cv, story.kicker, kx + 7, ky + 4, kickerH, WHITE, {
    strokeW: 1.75,
    track: 0.08,
  });

  // Colored section accent rule under illustration
  cv.fillRect(illusBox.x, illusBox.y + illusBox.h + 1, illusBox.w, 3, story.accent);

  // Bold, high-contrast 2-line headline + factual subline
  const textX = rect.x + 9;
  const textMaxW = rect.w - 18;
  const headY1 = illusBox.y + illusBox.h + 9.5;
  const headY2 = headY1 + 22.5;
  drawText(cv, story.headline[0], textX, headY1, 17.2, INK_DARK, {
    strokeW: 2.75,
    track: 0.05,
    maxWidth: textMaxW,
  });
  drawText(cv, story.headline[1], textX, headY2, 17.2, INK_DARK, {
    strokeW: 2.75,
    track: 0.05,
    maxWidth: textMaxW,
  });

  // Fine rule and legible factual subline
  const subRuleY = headY2 + 21.5;
  cv.fillRect(textX, subRuleY, textMaxW, 1, RULE_SOFT);
  drawText(cv, story.subline, textX, subRuleY + 5.5, 11.5, INK_BODY, {
    strokeW: 1.45,
    track: 0.04,
    maxWidth: textMaxW,
  });
}

function renderBroadsheet(): Surface {
  const cv = new Surface(IMG_W, IMG_H);
  drawPaperBackdrop(cv);
  drawMastheadAndRibbon(cv);

  // 3 columns x 4 rows grid
  const cols = 3;
  const rows = 4;
  const startX = 18;
  const startY = 122;
  const gridW = IMG_W - 36; // 988
  const gridH = IMG_H - startY - 18; // 884
  const colGap = 11;
  const rowGap = 10;
  const cardW = Math.floor((gridW - colGap * (cols - 1)) / cols); // 322
  const cardH = Math.floor((gridH - rowGap * (rows - 1)) / rows); // 213

  // Vertical column divider hairlines between columns
  for (let c = 1; c < cols; c++) {
    const gx = startX + c * cardW + (c - 1) * colGap + Math.floor(colGap * 0.5);
    cv.fillRect(gx, startY, 1, gridH, RULE_SOFT);
  }

  for (let idx = 0; idx < STORIES.length; idx++) {
    const r = Math.floor(idx / cols);
    const c = idx % cols;
    const rect: Rect = {
      x: startX + c * (cardW + colGap),
      y: startY + r * (cardH + rowGap),
      w: cardW,
      h: cardH,
    };
    drawStoryCard(cv, STORIES[idx], rect);
  }

  return cv;
}

// ---------- Deterministic Pure-Stdlib PNG Encoder ----------

const CRC_TABLE = (() => {
  const tbl = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    tbl[n] = c >>> 0;
  }
  return tbl;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type: string, payload: Uint8Array): Buffer {
  const chunk = Buffer.allocUnsafe(12 + payload.length);
  chunk.writeUInt32BE(payload.length, 0);
  chunk.write(type, 4, 4, 'ascii');
  chunk.set(payload, 8);
  const crc = crc32(chunk.subarray(4, 8 + payload.length));
  chunk.writeUInt32BE(crc, 8 + payload.length);
  return chunk;
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function encodePngRGB(cv: Surface): Buffer {
  const stride = cv.w * 3;
  const raw = Buffer.allocUnsafe(cv.h * (stride + 1));
  const candidates = [
    new Uint8Array(stride),
    new Uint8Array(stride),
    new Uint8Array(stride),
    new Uint8Array(stride),
    new Uint8Array(stride),
  ];

  for (let y = 0; y < cv.h; y++) {
    const rowOff = y * stride;
    const prevOff = (y - 1) * stride;
    const scores = [0, 0, 0, 0, 0];

    for (let x = 0; x < stride; x++) {
      const cur = cv.buf[rowOff + x];
      const left = x >= 3 ? cv.buf[rowOff + x - 3] : 0;
      const up = y > 0 ? cv.buf[prevOff + x] : 0;
      const upLeft = y > 0 && x >= 3 ? cv.buf[prevOff + x - 3] : 0;

      const f0 = cur;
      const f1 = (cur - left) & 0xff;
      const f2 = (cur - up) & 0xff;
      const f3 = (cur - ((left + up) >> 1)) & 0xff;
      const f4 = (cur - paethPredictor(left, up, upLeft)) & 0xff;

      candidates[0][x] = f0;
      candidates[1][x] = f1;
      candidates[2][x] = f2;
      candidates[3][x] = f3;
      candidates[4][x] = f4;

      scores[0] += f0 < 128 ? f0 : 256 - f0;
      scores[1] += f1 < 128 ? f1 : 256 - f1;
      scores[2] += f2 < 128 ? f2 : 256 - f2;
      scores[3] += f3 < 128 ? f3 : 256 - f3;
      scores[4] += f4 < 128 ? f4 : 256 - f4;
    }

    let bestFilter = 0;
    for (let f = 1; f < 5; f++) {
      if (scores[f] < scores[bestFilter]) bestFilter = f;
    }
    const outOff = y * (stride + 1);
    raw[outOff] = bestFilter;
    raw.set(candidates[bestFilter], outOff + 1);
  }

  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(cv.w, 0);
  ihdr.writeUInt32BE(cv.h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const compressed = deflateSync(raw, { level: 9 });
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

function resolveOutputDir(): string {
  if (process.env.MAKEFUN_OUTPUT_DIR) return process.env.MAKEFUN_OUTPUT_DIR;
  if (existsSync('/output')) return '/output';
  return './output';
}

function main(): void {
  const surface = renderBroadsheet();
  const png = encodePngRGB(surface);
  const outDir = resolveOutputDir();
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'entry.png');
  writeFileSync(outPath, png);
}

main();
