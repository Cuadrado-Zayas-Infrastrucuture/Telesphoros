// Structural guard only: does not replace browser accessibility or human naming/alt review.
import { readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import assert from 'node:assert/strict';
import ts from 'typescript';
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
  );
}
const source = files('src').filter(
  (p) =>
    p.endsWith('.tsx') && !p.includes('/test/') && !p.endsWith('.test.tsx'),
);
let components = 0;
for (const path of source) {
  const ast = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const names = [];
  function visit(node) {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name &&
      /^[A-Z]/.test(node.name.text)
    )
      names.push(node.name.text);
    if (
      ts.isJsxSelfClosingElement(node) &&
      node.tagName.getText(ast) === 'img'
    ) {
      const attrs = new Set(
        node.attributes.properties
          .filter(ts.isJsxAttribute)
          .map((a) => a.name.getText(ast)),
      );
      for (const key of ['alt', 'width', 'height', 'loading'])
        assert.ok(attrs.has(key), `${path}: image lacks ${key}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(names.length <= 1, `${path}: several components share a file`);
  if (names.length) {
    assert.equal(
      names[0],
      basename(path, '.tsx'),
      `${path}: component/file naming mismatch`,
    );
    components++;
  }
}
const manifest = JSON.parse(readFileSync('dist/.vite/manifest.json', 'utf8'));
const entry = Object.values(manifest).find((c) => c.isEntry);
const html = readFileSync('dist/index.html', 'utf8');
for (const path of files('src/pages').filter(
  (p) => p.endsWith('.tsx') && !p.endsWith('.test.tsx'),
)) {
  const key = Object.keys(manifest).find((k) => k.endsWith(path));
  if (basename(path).startsWith('Local')) {
    assert.equal(
      key,
      undefined,
      `${path}: development page leaked into production`,
    );
    continue;
  }
  assert.ok(key, `${path}: missing production route chunk`);
  const chunk = manifest[key];
  assert.ok(chunk.isDynamicEntry, `${path}: not lazy`);
  assert.ok(!entry.imports?.includes(key), `${path}: statically imported`);
  assert.ok(!html.includes(chunk.file), `${path}: preloaded unnecessarily`);
}
console.log(
  `foundation structure passed: ${components} components; all page chunks checked`,
);

const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
assert.ok(
  scripts.e2e.includes(
    '&& playwright test --config playwright.local.config.ts',
  ),
  'local browser suite is not required by e2e',
);
assert.ok(
  scripts.e2e.includes('&& playwright test --config playwright.owned-local.config.ts'),
  'owned-storage report/chat browser suite is not required by e2e',
);

// The synthetic AI preview and its fixtures must be absent, not merely hidden.
for (const path of files('dist/assets').filter(path => path.endsWith('.js'))) {
  const code = readFileSync(path, 'utf8');
  for (const marker of ['SYN-PGX-UI-01', 'Open PGx explanation preview', 'Prompt Kit preview', 'AI-assisted PGx preview', 'Explore AI preview', 'AI preview']) {
    assert.ok(!code.includes(marker), `${path}: development interpretation preview leaked into production`);
  }
}
console.log('interpretation preview excluded from production assets');

// Source maps prove SDK/transport modules were tree-shaken out, even if minified names change.
for (const path of files('dist/assets').filter(path => path.endsWith('.js.map'))) {
  const map = JSON.parse(readFileSync(path, 'utf8'));
  for (const source of map.sources) {
    assert.ok(!/(@ai-sdk|\/ai\/|syntheticChatTransport|useSyntheticChat|SyntheticAssistant\.tsx|AssistantPreviewCard\.tsx)/.test(source), `${path}: development assistant module leaked into production: ${source}`);
  }
}
console.log('AI SDK and synthetic transport excluded from production source maps');
