import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Required by both UI builds, including direct `vite build --mode …` invocations. */
export const brandingPlugin = {
  name: 'telesphoros-branding',
  apply: 'build',
  buildStart() {
    execFileSync(process.execPath, [fileURLToPath(new URL('./check-branding.mjs', import.meta.url))], { stdio: 'inherit' });
  },
};
