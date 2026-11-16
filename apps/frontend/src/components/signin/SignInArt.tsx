import { useEffect, useRef } from 'react';

/** A fixed pseudo-random number between 0 and 1 for a pair of whole numbers: the same pair always gives the same number. */
function hash(x: number, y: number): number {
  let n = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

const COLUMN = 8;
const ROW = 11;
/** Under five seconds, after which the drawing rests: no pause control is needed (WCAG 2.2.2). */
const SETTLE_MS = 4500;
const FRAME_MS = 80;

/**
 * Draws one frame. `progress` runs from 0 to 1 while the loose characters rise and come to rest.
 * Returns nothing; everything is derived from the cell's place, so the same progress always draws the same picture.
 */
function drawFrame(context: CanvasRenderingContext2D, width: number, height: number, progress: number, tones: readonly string[], family: string): void {
  context.clearRect(0, 0, width, height);
  context.font = `500 10px ${family}`;
  context.textBaseline = 'middle';
  context.textAlign = 'center';
  const columns = Math.ceil(width / COLUMN);
  const rows = Math.ceil(height / ROW);
  const radius = Math.min(width * 0.4, height * 0.32);
  const centreX = width / 2;
  const centreY = height - radius - ROW;
  // The loose characters rise fast at first and ease to a stop.
  const rise = (1 - (1 - progress) ** 3) * 14;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x = column * COLUMN + COLUMN / 2;
      const y = row * ROW + ROW / 2;
      const dx = (x - centreX) / radius;
      const dy = (y - centreY) / radius;
      const inside = dx * dx + dy * dy;
      let level = 0;
      let seed = row;
      if (inside < 1) {
        // The sphere: two rows of characters, then a gap, all the way down; brighter toward the middle, worn away toward the top.
        const band = Math.floor(((dy + 1) * radius) / ROW) % 3 !== 2;
        const worn = dy < 0.25 ? (0.25 - dy) * 0.8 : 0;
        if (band && hash(column, row) > worn) level = 0.25 + 0.75 * Math.sqrt(1 - inside) * (0.6 + 0.4 * hash(row, column));
      } else {
        // Above it: the characters that came loose, thinning out as they rise.
        const lift = (centreY - radius * 0.1 - y) / (radius * 2.1);
        if (lift > 0 && lift < 1) {
          const across = Math.abs(dx) / (1.2 - lift * 0.5);
          const chance = (1 - lift) ** 1.4 * Math.max(0, 1 - across * across) * 0.5;
          seed = row + Math.floor(rise * (0.5 + hash(column, 5)));
          if (hash(column, seed) < chance) level = 0.25 + 0.75 * hash(seed, column) * (1 - lift * 0.5);
        }
      }
      if (level <= 0) continue;
      context.globalAlpha = Math.min(1, 0.4 + level * 0.6);
      context.fillStyle = tones[level < 0.4 ? 0 : level < 0.75 ? 1 : 2];
      context.fillText(hash(column * 7, seed * 3) < 0.5 ? '0' : '1', x, y);
    }
  }
  context.globalAlpha = 1;
}

/**
 * The sign-in screen's drawing (founder request, 2026-11-16): a sphere made of characters whose top comes loose and
 * rises. It is drawn in code from the theme's own colours: no image or video file is loaded, and the characters are
 * zeros and ones placed by a fixed formula, so it holds no data. It moves for under five seconds and then rests;
 * people who ask their device for reduced motion get the resting picture at once. Decoration only.
 */
export function SignInArt() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const tokens = getComputedStyle(document.documentElement);
    const read = (name: string) => tokens.getPropertyValue(name).trim();
    // Dim to bright, all from the theme.
    const tones = [read('--brand-accent'), read('--muted-foreground'), read('--foreground')];
    const family = read('--font-family-mono');
    const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let width = 0;
    let height = 0;
    let progress = reduced ? 1 : 0;
    let frame = 0;
    let started = 0;
    let last = 0;

    const size = () => {
      const scale = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      context.setTransform(scale, 0, 0, scale, 0, 0);
      drawFrame(context, width, height, progress, tones, family);
    };
    const tick = (time: number) => {
      if (!started) started = time;
      if (time - last >= FRAME_MS) {
        last = time;
        progress = Math.min(1, (time - started) / SETTLE_MS);
        drawFrame(context, width, height, progress, tones, family);
      }
      if (progress < 1) frame = requestAnimationFrame(tick);
    };

    size();
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(size) : undefined;
    resize?.observe(canvas);
    if (!reduced) frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      resize?.disconnect();
    };
  }, []);

  return <canvas ref={ref} aria-hidden="true" className="block h-full w-full" />;
}
