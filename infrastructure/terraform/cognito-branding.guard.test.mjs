import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const configuration = new URL('./cognito-branding.tf', import.meta.url);
const source = existsSync(configuration) ? readFileSync(configuration, 'utf8') : '';

test('Cognito branding is opt-in and targets only the existing browser client', () => {
  assert.match(source, /variable "enable_cognito_classic_branding"\s*\{[^}]*default\s*=\s*false/s);
  assert.match(source, /count\s*=\s*var.enable_cognito_classic_branding\s*\?\s*1\s*:\s*0/);
  assert.match(source, /client_id\s*=\s*aws_cognito_user_pool_client.spa.id/);
  assert.match(source, /user_pool_id\s*=\s*aws_cognito_user_pool.main.id/);
});

test('branding refuses managed-login domains without migrating them', () => {
  assert.match(source, /cognito_branding_observed_login_version\s*==\s*1/);
  assert.match(source, /aws_cognito_user_pool_domain\.main\.managed_login_version\s*==\s*1/);
  assert.match(source, /depends_on\s*=\s*\[aws_cognito_user_pool_domain.main\]/);
  assert.doesNotMatch(source, /resource "aws_cognito_user_pool(?:_domain|_client)?"/);
});

test('external Cognito CSS tracks the canonical app palette', async () => {
  const { classicBranding } = await import('../../scripts/cognito/classic-branding.mjs');
  const tokens = readFileSync(new URL('../../apps/frontend/src/styles/tokens.css', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./cognito/hosted-ui.css', import.meta.url), 'utf8');
  assert.equal(css, classicBranding(tokens));
  const policy = JSON.parse(readFileSync(new URL('../../apps/frontend/scripts/branding-policy.json', import.meta.url), 'utf8'));
  for (const value of css.match(/#[a-f0-9]{6}/gi)) assert.ok(Object.values(policy.tokens).includes(value), `Unapproved color: ${value}`);
});

test('classic CSS uses only documented Cognito selectors and template properties', () => {
  const css = readFileSync(new URL('./cognito/hosted-ui.css', import.meta.url), 'utf8');
  const allowed = {
    logo: ['max-width', 'max-height', 'background-color'],
    banner: ['padding', 'background-color'],
    label: ['font-weight', 'color'],
    textDescription: ['padding-top', 'padding-bottom', 'display', 'font-size', 'color'],
    idpDescription: ['padding-top', 'padding-bottom', 'display', 'font-size', 'color'],
    legalText: ['color', 'font-size'],
    submitButton: ['font-size', 'font-weight', 'margin', 'height', 'width', 'color', 'background-color', 'text-align'],
    errorMessage: ['padding', 'font-size', 'width', 'background', 'border', 'color'],
    inputField: ['width', 'height', 'color', 'background-color', 'border', 'border-radius'],
    idpButton: ['height', 'width', 'text-align', 'margin-bottom', 'color', 'background-color', 'border-color'],
    socialButton: ['height', 'margin-bottom', 'text-align', 'width'],
    redirect: ['text-align'],
    'passwordCheck-notValid': ['color'],
    'passwordCheck-valid': ['color'],
    background: ['background-color'],
  };
  assert.doesNotMatch(css, /@|url\(|var\(|javascript|<|font-family/i);
  const blocks = [...css.matchAll(/([^{}]+)\{([^{}]+)\}/g)];
  assert.equal(blocks.length, 18);
  for (const [, rawSelector, body] of blocks) {
    const selector = rawSelector.trim();
    const match = selector.match(/^\.([a-zA-Z-]+)-customizable(?::(hover|focus))?$/);
    assert.ok(match, `Unsupported selector: ${selector}`);
    const properties = match[2] === 'focus' ? ['border-color', 'outline'] : match[2] === 'hover' ? ['color', 'background-color'] : allowed[match[1]];
    assert.ok(properties, `Unsupported Cognito class: ${selector}`);
    for (const declaration of body
      .split(';')
      .map((value) => value.trim())
      .filter(Boolean)) {
      assert.ok(properties.includes(declaration.split(':')[0].trim()), `Unsupported declaration: ${declaration}`);
    }
  }
});

test('branding fits Cognito request limits and reuses the approved product logo', () => {
  const css = readFileSync(new URL('./cognito/hosted-ui.css', import.meta.url));
  const logo = readFileSync(new URL('../../apps/frontend/src/assets/telesphoros-shield-rx.png', import.meta.url));
  assert.ok(css.length < 3 * 1024);
  assert.ok(logo.length < 100 * 1024);
  assert.ok(Buffer.byteLength(logo.toString('base64')) + css.length < 135 * 1024);
  assert.match(source, /image_file\s*=\s*filebase64\("\$\{path.module\}\/\.\.\/\.\.\/apps\/frontend\/src\/assets\/telesphoros-shield-rx.png"\)/);
});

test('form controls retain accessible touch sizes and a visible brand focus outline', () => {
  const css = readFileSync(new URL('./cognito/hosted-ui.css', import.meta.url), 'utf8');
  for (const name of ['inputField', 'submitButton', 'idpButton', 'socialButton']) {
    const body = css.match(new RegExp(`\\.${name}-customizable \\{([^}]+)\\}`))[1];
    assert.ok(Number(body.match(/height: (\d+)px/)[1]) >= 44);
    assert.match(body, /width: 100%/);
  }
  assert.match(css, /outline: 2px solid #1F5A64/);
});
