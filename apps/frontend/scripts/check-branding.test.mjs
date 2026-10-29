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
  input.textFiles[tokenPath] = input.textFiles[tokenPath].replace('--foreground: #2C3438;', '--foreground: #368798;');
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
  input.textFiles[tokenPath] = input.textFiles[tokenPath].replace('--foreground: #2C3438;', '--foreground: #DCEBE7;');
}, /contrast: foreground\/background/));
test('rejects reduced control targets', () => rejects(input => {
  input.textFiles[tokenPath] = input.textFiles[tokenPath].replace('--size-control: 2.75rem;', '--size-control: 2rem;');
}, /--size-control/));
test('rejects loss of either UI build gate', () => {
  for (const path of ['apps/frontend/vite.config.ts', 'packages/smart-pilot/vite.config.ts']) rejects(input => {
    input.textFiles[path] = input.textFiles[path].replace('plugins: [brandingPlugin,', 'plugins: [');
  }, /must gate every Vite build/);
});
test('rejects motion/filter changes to the original mascot', () => {
  for (const css of ['.mascot-welcome-image { animation: spin 3s infinite; }', '.mascot-welcome-image { filter: hue-rotate(60deg); }']) rejects(input => {
    input.textFiles['apps/frontend/src/styles/new-artwork.css'] = css;
  }, /cannot acquire animation or filters/);
});
test('rejects retired artwork returning under its old name or any other name', () => {
  const [[name, sha]] = Object.entries(approved.policy.retiredAssets);
  for (const path of [`apps/frontend/src/assets/${name}`, 'apps/frontend/src/assets/renamed-helix.png', 'apps/frontend/public/hero.bin', 'packages/smart-pilot/ui/background.png']) rejects(input => {
    input.fileHashes[path] = sha;
  }, /retired artwork .* must not ship/);
});
test('rejects retired artwork re-added as an approved asset', () => rejects(input => {
  const [sha] = Object.values(input.policy.retiredAssets);
  const path = 'apps/frontend/src/assets/reapproved.png';
  input.policy.assets[path] = sha;
  input.assetHashes[path] = sha;
  input.fileHashes[path] = sha;
}, /retired artwork/));
test('the retired list is present and scans real shipped files of every type', () => {
  assert.ok(Object.keys(approved.policy.retiredAssets ?? {}).length > 0, 'retiredAssets must not be empty');
  assert.ok(Object.keys(approved.fileHashes).some(path => path.endsWith('InterVariable.woff2')), 'binary fonts must be hashed');
  assert.ok(Object.keys(approved.fileHashes).some(path => path.endsWith('telesphoros-shield-rx.png')), 'binary images must be hashed');
  assert.ok(!Object.keys(approved.fileHashes).some(path => /particle-dna/.test(path)), 'the retired image must be gone');
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

// Blur is allowed only as the progressive scroll edge (specs/005-progressive-blur-edge).
const blurComponent = 'apps/frontend/src/components/motion-primitives/ProgressiveBlur.tsx';
const blurStyles = 'apps/frontend/src/styles/progressive-blur.css';
test('rejects blur in a stylesheet outside the scroll-edge component', () => {
  for (const css of ['.panel { backdrop-filter: blur(8px); }', '.panel { -webkit-backdrop-filter: blur(8px); }', '.panel { filter: blur(2px); }', '.panel { @apply backdrop-blur-md; }']) rejects(input => {
    input.textFiles['apps/frontend/src/styles/new-panel.css'] = css;
  }, /blur is only allowed/);
});
test('rejects Tailwind blur utilities outside the scroll-edge component', () => {
  for (const value of ['rounded-lg backdrop-blur-md', 'blur-sm', 'hover:backdrop-blur', 'blur']) rejects(input => {
    input.textFiles['apps/frontend/src/components/NewPanel.tsx'] = `export function NewPanel() { return <p className="${value}">Report</p>; }`;
  }, /blur is only allowed/);
});
test('rejects inline backdrop and blur filters outside the scroll-edge component', () => {
  for (const style of ["{ backdropFilter: 'blur(4px)' }", "{ WebkitBackdropFilter: 'blur(4px)' }", "{ filter: 'blur(1px)' }"]) rejects(input => {
    input.textFiles['apps/frontend/src/components/NewPanel.tsx'] = `export function NewPanel() { return <p style={${style}}>Report</p>; }`;
  }, /blur is only allowed/);
});
test('allows blur inside the scroll-edge component and its stylesheet', () => {
  const input = copy();
  input.textFiles[blurComponent] = "export function ProgressiveBlur() { return <div aria-hidden=\"true\" style={{ backdropFilter: 'blur(1px)' }} />; }";
  input.textFiles[blurStyles] = '@supports not (backdrop-filter: blur(1px)) { .progressive-blur-layer { display: none; } }';
  assert.deepEqual(findBrandViolations(input).filter(error => /blur/.test(error)), []);
});
test('does not mistake a blur event for a blur style', () => {
  const input = copy();
  input.textFiles['apps/frontend/src/components/NewPanel.tsx'] = "export function NewPanel({ onLeave }: { onLeave: () => void }) { window.addEventListener('blur', onLeave); return <input onBlur={onLeave} aria-label=\"Patient\" />; }";
  assert.deepEqual(findBrandViolations(input), []);
});
test('rejects a deeper or missing blur edge', () => {
  rejects(input => { input.textFiles[tokenPath] = input.textFiles[tokenPath].replace('--size-blur-edge: 3rem;', '--size-blur-edge: 12rem;'); }, /--size-blur-edge/);
  rejects(input => { input.textFiles[tokenPath] = input.textFiles[tokenPath].replace('--size-blur-edge: 3rem;', ''); }, /--size-blur-edge/);
});
test('rejects a changed dark color without touching the light one', () => rejects(input => {
  input.textFiles[tokenPath] = input.textFiles[tokenPath].replace('--panel: #222628;', '--panel: #1a2b2f;');
}, /dark --panel must be #222628/));
test('dark values never replace the light pins', () => {
  const input = copy();
  assert.equal(findBrandViolations(input).filter(error => /--background must be/.test(error)).length, 0);
  assert.match(input.textFiles[tokenPath], /--background: #1B1E20;/);
});
test('rejects a missing or duplicated dark block', () => {
  rejects(input => { input.textFiles[tokenPath] = input.textFiles[tokenPath].replace(":root[data-theme='dark']", ':root[data-theme="dim"]'); }, /exactly one :root\[data-theme='dark'\] block/);
  rejects(input => { input.textFiles[tokenPath] += "\n:root[data-theme='dark'] { --panel: #222628; }"; }, /exactly one/);
});
test('rejects a dark theme that changes anything but approved colors', () => rejects(input => {
  input.textFiles[tokenPath] = input.textFiles[tokenPath].replace('--mark-plate: #DCEBE7;', '--mark-plate: #DCEBE7;\n  --size-control: 2rem;');
}, /dark theme may not set --size-control/));
test('rejects poor contrast in the dark theme alone', () => rejects(input => {
  input.policy.darkTokens['muted-foreground'] = '#4a5f63';
  input.policy.allowedColorLiterals.push('#4a5f63');
  input.textFiles[tokenPath] = input.textFiles[tokenPath].replace('--muted-foreground: #9CA4A8;', '--muted-foreground: #4a5f63;');
}, /contrast \(dark\): muted-foreground\/panel/));
