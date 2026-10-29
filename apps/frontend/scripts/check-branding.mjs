// Build guard for the reviewed brand contract. Human/browser review remains required for visual quality.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const tokenPath = 'apps/frontend/src/styles/tokens.css';
const policyPath = 'apps/frontend/scripts/branding-policy.json';
const rawColor = /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\s*\(/i;
const namedColor = /\b(?:white|black|red|orange|yellow|green|blue|purple|pink|teal|cyan|gray|grey|beige|navy|gold)\b/i;
const foreignUtility = /(?:^|\s|:)(?:text|bg|border|ring|fill|stroke|from|via|to)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black)(?:-\d+)?\b/;
const arbitraryUtility = /(?:^|\s)(?:[a-z0-9:!&>_*-]+-)?\[[^\]\s]+\]/i;
const commentsRemoved = text => text.replace(/\/\*[\s\S]*?\*\//g, '');
// Blur exists only as the progressive scroll edge (specs/005-progressive-blur-edge); everything else is rejected.
const blurAllowed = new Set(['apps/frontend/src/components/motion-primitives/ProgressiveBlur.tsx', 'apps/frontend/src/styles/progressive-blur.css']);
const blurError = path => `${path}: blur is only allowed as the progressive scroll edge (components/motion-primitives/ProgressiveBlur)`;
const cssBlur = /backdrop-filter|\bblur\s*\(|@apply[^;]*\bblur\b/i;
const blurValue = /\bblur\s*\(/i;
const blurClass = /^(?:[\w-]+:)*!?(?:backdrop-blur|blur-)/;
const bareBlurClass = /^(?:[\w-]+:)*!?blur$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);
}
export function loadBrandInputs(root = repoRoot) {
  const policy = JSON.parse(readFileSync(join(root, policyPath), 'utf8'));
  const sources = ['apps/frontend/src', 'packages/smart-pilot/ui'].flatMap(dir => walk(join(root, dir)))
    .filter(path => /\.(css|tsx?|jsx?)$/.test(path) && !/\/test\/|\.test\./.test(path));
  const configs = ['apps/frontend/vite.config.ts', 'packages/smart-pilot/vite.config.ts'];
  const textFiles = Object.fromEntries([...sources, ...configs.map(path => join(root, path))].map(path => [relative(root, path), readFileSync(path, 'utf8')]));
  const assetHashes = Object.fromEntries(Object.keys(policy.assets).map(path => [path, hash(readFileSync(join(root, path)))]));
  // Every shipped file of any type, so retired artwork is caught under any filename.
  const fileHashes = Object.fromEntries(['apps/frontend/src', 'apps/frontend/public', 'packages/smart-pilot/ui']
    .filter(dir => existsSync(join(root, dir))).flatMap(dir => walk(join(root, dir)))
    .map(path => [relative(root, path), hash(readFileSync(path))]));
  return { policy, textFiles, assetHashes, fileHashes };
}
function luminance(hex) {
  const values = hex.replace('#', '').match(/../g).map(channel => parseInt(channel, 16) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return values[0] * .2126 + values[1] * .7152 + values[2] * .0722;
}
export function findBrandViolations({ policy, textFiles, assetHashes, fileHashes = {} }) {
  const errors = [];
  const tokens = commentsRemoved(textFiles[tokenPath] ?? '');
  const parse = css => Object.fromEntries([...css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(match => [match[1].slice(2), match[2].trim()]));
  // The dark block is read on its own; read with the rest, its values would silently replace the light ones.
  const darkBlocks = [...tokens.matchAll(/:root\[data-theme=(['"])dark\1\]\s*\{([^}]*)\}/g)];
  const definitions = parse(darkBlocks.reduce((css, match) => css.replace(match[0], ''), tokens));
  for (const [name, expected] of Object.entries(policy.tokens)) {
    if (definitions[name] !== expected) errors.push(`${tokenPath}: --${name} must be ${expected}`);
  }
  if (darkBlocks.length !== 1) errors.push(`${tokenPath}: exactly one :root[data-theme='dark'] block is required`);
  const dark = parse(darkBlocks[0]?.[2] ?? '');
  for (const [name, expected] of Object.entries(policy.darkTokens)) {
    if (!Object.hasOwn(policy.tokens, name)) errors.push(`${policyPath}: dark --${name} has no light token`);
    if (dark[name] !== expected) errors.push(`${tokenPath}: dark --${name} must be ${expected}`);
  }
  for (const name of Object.keys(dark)) {
    if (!Object.hasOwn(policy.darkTokens, name)) errors.push(`${tokenPath}: dark theme may not set --${name}`);
  }
  // The Appearance setting's fixed preview colors must be copies of the real tokens, never their own palette.
  for (const [name, value] of Object.entries(definitions)) {
    const preview = name.match(/^theme-preview-(light|dark)-(.+)$/);
    if (!preview) continue;
    const source = preview[1] === 'light' ? policy.tokens : policy.darkTokens;
    if (source[preview[2]]?.toLowerCase() !== value.toLowerCase()) errors.push(`${tokenPath}: --${name} must equal the ${preview[1]} --${preview[2]}`);
  }
  for (const literal of tokens.match(/#[\da-f]{3,8}\b/gi) ?? []) {
    if (!policy.allowedColorLiterals.includes(literal.toLowerCase())) errors.push(`${tokenPath}: unapproved color ${literal}`);
  }
  for (const [name, value] of Object.entries(definitions)) {
    if (namedColor.test(value) || /\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\s*\(/i.test(value)) errors.push(`${tokenPath}: --${name} introduces an unapproved color spelling`);
  }
  for (const [path, expected] of Object.entries(policy.assets)) {
    if (assetHashes[path] !== expected) errors.push(`${path}: approved artwork/font bytes changed or are missing`);
  }
  const retired = new Map(Object.entries(policy.retiredAssets ?? {}).map(([name, sha]) => [sha, name]));
  for (const [path, sha] of Object.entries(fileHashes)) {
    if (retired.has(sha)) errors.push(`${path}: retired artwork (${retired.get(sha)}) must not ship, under any filename`);
  }
  for (const [path, expected] of Object.entries(policy.references)) {
    const ast = ts.createSourceFile(path, textFiles[path] ?? '', ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    if (!ast.statements.some(node => ts.isImportDeclaration(node) && node.moduleSpecifier.text === expected)) errors.push(`${path}: must reference approved brand reference ${expected}`);
  }
  const allFaces = [...tokens.matchAll(/@font-face\s*\{([^}]+)\}/g)].map(match => match[1]);
  if (allFaces.length !== 3) errors.push(`${tokenPath}: only the three approved shared font faces are allowed`);
  for (const [family, weight, asset] of [['Inter', '100 900', 'InterVariable.woff2'], ['Poppins', '600', 'Poppins-SemiBold.ttf'], ['Poppins', '400', 'Poppins-Regular.ttf']]) {
    if (!allFaces.some(face => face.includes(`'${family}'`) && face.includes(`url('../assets/fonts/${asset}')`) && face.includes(`font-weight: ${weight};`))) errors.push(`${tokenPath}: missing shared ${family} ${weight} font face`);
  }
  for (const [theme, values] of [['light', definitions], ['dark', { ...definitions, ...dark }]]) {
    const label = theme === 'light' ? 'contrast' : 'contrast (dark)';
    for (const pair of policy.contrast) {
      const foreground = values[pair.foreground], background = values[pair.background];
      if (!/^#[\da-f]{6}$/i.test(foreground ?? '') || !/^#[\da-f]{6}$/i.test(background ?? '')) { errors.push(`${label}: ${pair.foreground}/${pair.background} must be opaque hex tokens`); continue; }
      const a = luminance(foreground), b = luminance(background);
      const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
      if (ratio < pair.minimum) errors.push(`${label}: ${pair.foreground}/${pair.background} is ${ratio.toFixed(2)}:1; requires ${pair.minimum}:1`);
    }
  }
  for (const [path, text] of Object.entries(textFiles)) {
    if (path.endsWith('vite.config.ts')) continue;
    const blurOk = blurAllowed.has(path);
    if (path.endsWith('.css')) {
      const css = commentsRemoved(text);
      if (/@import\s+(?:url\s*\()?['"]?(?:https?:|\/\/)/i.test(css)) errors.push(`${path}: external styles/fonts are not allowed`);
      if (!blurOk && cssBlur.test(css)) errors.push(blurError(path));
      if (path !== tokenPath) {
        if (rawColor.test(css)) errors.push(`${path}: literal colors must live in tokens.css`);
        for (const match of css.matchAll(/--([\w-]+)\s*:\s*([^;{}]+);/g)) {
          const approvedLandingAlias = path === 'apps/frontend/src/styles/landing.css' && match[1] === 'font-family-heading' && match[2].trim() === 'var(--font-family-landing)';
          if (Object.hasOwn(policy.tokens, match[1]) && !approvedLandingAlias) errors.push(`${path}: cannot override locked --${match[1]} outside tokens.css`);
        }
        if (/@font-face\b/.test(css)) errors.push(`${path}: font faces must live in tokens.css`);
        for (const match of css.matchAll(/(?<=[;{])\s*([\w-]+)\s*:\s*([^;{}]+)(?=[;}])/g)) {
          const [, property, value] = match;
          if (/font-family|^font$/.test(property) && !/^(?:var\(--[\w-]+\)|inherit|initial|unset)\s*$/.test(value.trim())) errors.push(`${path}: ${property} must inherit or use a font token`);
          if (/color|background|border|shadow|fill|stroke/.test(property) && namedColor.test(value)) errors.push(`${path}: named colors must use tokens`);
        }
      }
      for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (/\.mascot-welcome-image/.test(match[1]) && /(?:animation(?:-name)?|filter)\s*:\s*(?!none\b)[^;]+/.test(match[2])) errors.push(`${path}: original mascot cannot acquire animation or filters`);
      }
    } else {
      const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      // Resolve local style objects and inline JSX styles, not unrelated variant/data objects.
      const styleIdentifiers = new Set();
      function collectStyles(node) {
        if (ts.isJsxAttribute(node) && node.name.getText(ast) === 'style') {
          function identifiers(child) { if (ts.isIdentifier(child)) styleIdentifiers.add(child.text); ts.forEachChild(child, identifiers); }
          ts.forEachChild(node, identifiers);
        }
        ts.forEachChild(node, collectStyles);
      }
      collectStyles(ast);
      function isStyle(node) {
        for (let parent = node.parent; parent; parent = parent.parent) {
          if (ts.isJsxAttribute(parent)) return parent.name.getText(ast) === 'style';
          if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) && styleIdentifiers.has(parent.name.text)) return true;
        }
        return false;
      }
      // A bare `blur` is a class only where class names are written; elsewhere it is an event name.
      function inClassContext(node) {
        for (let parent = node.parent; parent; parent = parent.parent) {
          if (ts.isJsxAttribute(parent)) return parent.name.getText(ast) === 'className';
          if (ts.isCallExpression(parent) && /^(?:cn|cva|clsx|twMerge)$/.test(parent.expression.getText(ast))) return true;
        }
        return false;
      }
      function visit(node) {
        if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
          if (foreignUtility.test(node.text) || arbitraryUtility.test(node.text)) errors.push(`${path}: unapproved utility ${node.text}`);
          if (rawColor.test(node.text)) errors.push(`${path}: literal colors must use tokens`);
          const classes = node.text.split(/\s+/).filter(Boolean);
          const blurUtility = classes.some(name => blurClass.test(name) || (bareBlurClass.test(name) && (classes.length > 1 || inClassContext(node))));
          if (!blurOk && (blurValue.test(node.text) || blurUtility)) errors.push(blurError(path));
        }
        if (!blurOk && ts.isPropertyAssignment(node) && /^(?:webkit)?backdrop-?filter$/i.test(node.name.getText(ast).replace(/['"]/g, ''))) errors.push(blurError(path));
        if (ts.isPropertyAssignment(node) && isStyle(node)) {
          const name = node.name.getText(ast).replace(/['"]/g, '');
          if (name.startsWith('--') && Object.hasOwn(policy.tokens, name.slice(2))) errors.push(`${path}: cannot override locked ${name} inline`);
          if (/^(?:fontFamily|font|color|background(?:Color)?|border(?:Top|Right|Bottom|Left)?(?:Color)?|outline(?:Color)?|fill|stroke)$/.test(name) && ts.isStringLiteralLike(node.initializer)) {
            const value = node.initializer.text;
            const tokenOrKeyword = /^(?:var\(--[\w-]+\)|inherit|currentColor|transparent|none)$/.test(value);
            const compoundToken = !/^font/.test(name) && value.includes('var(--') && !rawColor.test(value) && !namedColor.test(value.replace(/var\([^)]*\)/g, ''));
            if (!tokenOrKeyword && !compoundToken) errors.push(`${path}: inline ${name} must use a brand token`);
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(ast);
    }
  }
  for (const path of ['apps/frontend/vite.config.ts', 'packages/smart-pilot/vite.config.ts']) {
    if (!/plugins\s*:\s*\[[^\]]*\bbrandingPlugin\b/.test(textFiles[path] ?? '')) errors.push(`${path}: brandingPlugin must gate every Vite build`);
  }
  if (!/font-family:\s*var\(--font-family-ui-heading\)/.test(textFiles['apps/frontend/src/styles/workspace.css'] ?? '')) errors.push('workspace.css: dashboard headings must use the shared UI font');
  return [...new Set(errors)];
}
export function checkBranding(root = repoRoot) {
  const errors = findBrandViolations(loadBrandInputs(root));
  if (errors.length) throw new Error(`Branding check failed:\n${errors.map(error => `- ${error}`).join('\n')}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { checkBranding(); console.log('Branding passed: tokens, fonts, original artwork, contrast, CSS/utilities and both build gates.'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
