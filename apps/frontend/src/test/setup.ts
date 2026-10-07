import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, expect } from 'vitest';
import * as axeMatchers from 'vitest-axe/matchers';

expect.extend(axeMatchers);
afterEach(() => cleanup());

// axe-core probes <canvas> for colour-contrast checks; jsdom has no canvas and logs noise.
// Contrast is verified in the real browser by the Playwright suite instead.
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
