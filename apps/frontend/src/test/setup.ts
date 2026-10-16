import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, expect } from 'vitest';
import * as axeMatchers from 'vitest-axe/matchers';

expect.extend(axeMatchers);
afterEach(() => cleanup());

// The landing page imports a responsive image through vite-imagetools, which encodes AVIF/WebP/PNG variants on the
// first run with an empty cache (a fresh checkout, every CI run). That takes seconds, far over the 1 s default wait,
// so the first test to render it timed out on CI while passing on every warm developer machine.
configure({ asyncUtilTimeout: 20_000 });

// axe-core probes <canvas> for colour-contrast checks; jsdom has no canvas and logs noise.
// Contrast is verified in the real browser by the Playwright suite instead.
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;

// JSDOM has no viewport; landing navigation scroll is checked in Playwright.
window.scrollTo = () => {};

// jsdom has no native modal lifecycle; browser tests exercise real focus containment and Escape.
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); };
}
