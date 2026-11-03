import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const tokens = new URL('../../apps/frontend/src/styles/tokens.css', import.meta.url);
const output = new URL('../../infrastructure/terraform/cognito/hosted-ui.css', import.meta.url);

export function classicBranding(source) {
  const color = (name) => {
    const value = source.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})\\b`, 'i'))?.[1];
    if (!value) throw new Error(`Missing canonical color: ${name}`);
    return value;
  };
  const styles = {
    '.logo-customizable': { 'max-width': '24%', 'max-height': '30%', 'background-color': color('background') },
    '.banner-customizable': { padding: '24px 0px 24px 0px', 'background-color': color('background') },
    '.label-customizable': { 'font-weight': '600', color: color('foreground') },
    '.textDescription-customizable': { 'padding-top': '12px', 'padding-bottom': '12px', display: 'block', 'font-size': '16px', color: color('foreground') },
    '.idpDescription-customizable': { 'padding-top': '12px', 'padding-bottom': '12px', display: 'block', 'font-size': '16px', color: color('foreground') },
    '.legalText-customizable': { color: color('muted-foreground'), 'font-size': '12px' },
    '.submitButton-customizable': {
      'font-size': '16px',
      'font-weight': 'bold',
      margin: '20px 0px 12px 0px',
      height: '48px',
      width: '100%',
      color: color('primary-foreground'),
      'background-color': color('primary'),
      'text-align': 'center',
    },
    '.submitButton-customizable:hover': { color: color('primary-foreground'), 'background-color': color('primary-hover') },
    '.errorMessage-customizable': {
      padding: '12px',
      'font-size': '14px',
      width: '100%',
      background: color('destructive-surface'),
      border: `1px solid ${color('destructive')}`,
      color: color('destructive'),
    },
    '.inputField-customizable': {
      width: '100%',
      height: '48px',
      color: color('foreground'),
      'background-color': color('panel'),
      border: `1px solid ${color('border')}`,
      'border-radius': '8px',
    },
    '.inputField-customizable:focus': { 'border-color': color('ring'), outline: `2px solid ${color('ring')}` },
    '.idpButton-customizable': {
      height: '48px',
      width: '100%',
      'text-align': 'center',
      'margin-bottom': '12px',
      color: color('foreground'),
      'background-color': color('surface'),
      'border-color': color('border'),
    },
    '.idpButton-customizable:hover': { color: color('foreground'), 'background-color': color('muted') },
    '.socialButton-customizable': { height: '48px', 'margin-bottom': '12px', 'text-align': 'left', width: '100%' },
    '.redirect-customizable': { 'text-align': 'center' },
    '.passwordCheck-notValid-customizable': { color: color('destructive') },
    '.passwordCheck-valid-customizable': { color: color('success') },
    '.background-customizable': { 'background-color': color('background') },
  };
  return (
    Object.entries(styles)
      .map(
        ([selector, properties]) =>
          `${selector} {\n${Object.entries(properties)
            .map(([name, value]) => `  ${name}: ${value};`)
            .join('\n')}\n}`,
      )
      .join('\n\n') + '\n'
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const css = classicBranding(readFileSync(tokens, 'utf8'));
  if (process.argv[2] === '--write') writeFileSync(output, css);
  else if (process.argv[2] === '--check') {
    if (readFileSync(output, 'utf8') !== css) throw new Error('Cognito CSS differs from canonical tokens. Run node scripts/cognito/classic-branding.mjs --write.');
    console.log('Cognito CSS matches canonical brand tokens.');
  } else throw new Error('Use --write or --check.');
}
