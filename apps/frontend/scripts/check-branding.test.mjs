import test from 'node:test';
import assert from 'node:assert/strict';
import { findBrandViolations, loadBrandInputs } from './check-branding.mjs';

// Mutations are in-memory copies: never edit artwork, clinical data or the real worktree.
const approved = loadBrandInputs();
const copy = () => structuredClone(approved);
function rejects(change, expected) {
  const inputs = copy();
  change(inputs);
  assert.ok(findBrandViolations(inputs).some(error => expected.test(error)), `expected a ${expected} violation`);
}
const tokenPath = 'apps/frontend/src/styles/tokens.css';
test('reviewed repository satisfies the brand contract', () => assert.deepEqual(findBrandViolations(approved), []));
test('rejects lighter foreground text', () => rejects(input => {
  input.textFiles[tokenPath] = input.textFiles[tokenPath].replace('--foreground: #225560;', '--foreground: #368798;');
}, /--foreground/));
test('rejects silent button-fill and status changes', () => {
  for (const token of ['primary', 'success', 'warning', 'destructive']) rejects(input => {
    input.textFiles[tokenPath] = input.textFiles[tokenPath].replace(new RegExp(`--${token}: #[\\da-f]+;`, 'i'), `--${token}: #ffffff;`);
  }, new RegExp(`--${token}`));
});
test('rejects an unapproved color added to the token sheet', () => rejects(input => {
  input.textFiles[tokenPath] += '\n:root { --rogue: #ff00ff; }';
}, /unapproved color/));
test('rejects raw and named CSS colors outside tokens', () => {
  for (const value of ['#ff00ff', 'rgb(200, 20, 40)', 'teal']) rejects(input => {
    input.textFiles['apps/frontend/src/styles/new-panel.css'] = `.panel { color: ${value}; }`;
  }, /literal colors|named colors/);
});
test('rejects a font override even after another declaration', () => rejects(input => {
  input.textFiles['apps/frontend/src/styles/new-panel.css'] = '.panel { margin: 0; font-family: Georgia; }';
}, /font-family/));
test('rejects page-local font loading', () => rejects(input => {
  input.textFiles['apps/frontend/src/styles/new-panel.css'] = '@font-face { font-family: Inter; src: url(wrong.woff2); }';
}, /font faces/));
test('rejects foreign palette utilities and arbitrary Tailwind values', () => {
  for (const value of ['bg-blue-500', 'hover:text-red-600', 'text-[#225560]', 'w-[19px]']) rejects(input => {
    input.textFiles['apps/frontend/src/components/NewPanel.tsx'] = `export function NewPanel() { return <p className="${value}">Report</p>; }`;
  }, /unapproved utility/);
});
test('rejects inline colors and font overrides', () => {
  for (const [property, value] of [['color', 'teal'], ['fontFamily', 'system-ui']]) rejects(input => {
    input.textFiles['apps/frontend/src/components/NewPanel.tsx'] = `export function NewPanel() { return <p style={{ ${property}: '${value}' }}>Report</p>; }`;
  }, /inline/);
});
test('rejects changed or missing original artwork and fonts', () => {
  for (const path of Object.keys(approved.policy.assets)) rejects(input => { input.assetHashes[path] = 'changed'; }, /approved artwork\/font bytes/);
});
test('rejects poor text contrast independently of color pins', () => rejects(input => {
  input.policy.tokens.foreground = '#DCEBE7';
  input.textFiles[tokenPath] = input.textFiles[tokenPath].replace('--foreground: #225560;', '--foreground: #DCEBE7;');
}, /contrast: foreground\/background/));
test('rejects reduced control targets', () => rejects(input => {
  input.textFiles[tokenPath] = input.textFiles[tokenPath].replace('--size-control: 2.75rem;', '--size-control: 2rem;');
}, /--size-control/));
test('rejects loss of either UI build gate', () => {
  for (const path of ['apps/frontend/vite.config.ts', 'packages/smart-pilot/vite.config.ts']) rejects(input => {
    input.textFiles[path] = input.textFiles[path].replace('plugins: [brandingPlugin,', 'plugins: [');
  }, /must gate every Vite build/);
});
test('rejects motion/filter changes to original DNA or mascot', () => {
  for (const css of ['.landing-dna { animation: spin 3s infinite; }', '.mascot-welcome-image { filter: hue-rotate(60deg); }']) rejects(input => {
    input.textFiles['apps/frontend/src/styles/new-artwork.css'] = css;
  }, /cannot acquire animation or filters/);
});
test('rejects loss of the dashboard UI-font rule', () => rejects(input => {
  delete input.textFiles['apps/frontend/src/styles/workspace.css'];
}, /dashboard headings/));

test('rejects alternate color spellings in new tokens', () => {
  for (const color of ['red', 'rgb(230, 20, 40)']) rejects(input => {
    input.textFiles[tokenPath] += `:root { --rogue: ${color}; }`;
  }, /unapproved color spelling/);
});
test('rejects locally overriding locked colors even with another approved token', () => rejects(input => {
  input.textFiles['apps/frontend/src/styles/new-panel.css'] = '.panel { --foreground: var(--brand-accent); }';
}, /cannot override locked --foreground/));
test('rejects alternate font sources and additional faces', () => {
  rejects(input => { input.textFiles[tokenPath] = input.textFiles[tokenPath].replace("url('../assets/fonts/InterVariable.woff2')", "url('../wrong/InterVariable.woff2')"); }, /missing shared Inter/);
  rejects(input => { input.textFiles[tokenPath] += "@font-face { font-family: Georgia; src: url(wrong.woff2); }"; }, /three approved/);
});

test('rejects replacing an artwork import while leaving the approved file intact', () => {
  for (const [path, asset] of Object.entries(approved.policy.references)) rejects(input => {
    input.textFiles[path] = input.textFiles[path].replace(asset, '@/assets/unapproved-replacement.png');
  }, /must reference approved brand reference/);
});

test('rejects drift from the founder-approved darker dashboard text', () => {
  for (const name of ['dashboard-foreground', 'dashboard-muted-foreground']) rejects(input => {
    input.textFiles[tokenPath] = input.textFiles[tokenPath].replace(new RegExp(`--${name}: #[\\da-f]+;`, 'i'), `--${name}: #368798;`);
  }, /--dashboard-/);
});

test('rejects external stylesheet/font imports', () => rejects(input => {
  input.textFiles['apps/frontend/src/styles/new-font.css'] = '@import url("https://fonts.example.test/other.css");';
}, /external styles\/fonts/));

test('rejects shorthand inline background, border and font overrides', () => {
  for (const [property, value] of [['background', 'red'], ['border', '1px solid teal'], ['font', '16px Georgia']]) rejects(input => {
    input.textFiles['apps/frontend/src/components/NewPanel.tsx'] = `export function NewPanel() { return <p style={{ ${property}: '${value}' }}>Report</p>; }`;
  }, /inline/);
});

test('rejects an unapproved color in a local style object', () => rejects(input => {
  input.textFiles['apps/frontend/src/components/NewPanel.tsx'] = "const panelStyle = { background: 'red' }; export function NewPanel() { return <p style={panelStyle}>Report</p>; }";
}, /inline background/));
test('does not confuse a class variant named outline with an inline CSS declaration', () => {
  const input = copy();
  input.textFiles['apps/frontend/src/components/NewPanel.tsx'] = "const variants = { outline: 'border-border bg-panel text-primary' }; export function NewPanel() { return <p className={variants.outline}>Report</p>; }";
  assert.deepEqual(findBrandViolations(input), []);
});
