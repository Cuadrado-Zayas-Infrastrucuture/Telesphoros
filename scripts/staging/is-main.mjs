// Whether this module was started as a command (`node path/to/it.mjs`), not imported by a test. Node resolves symlinks for import.meta.url
// but not for process.argv[1], so both sides are resolved here: compared as given, they differ through a symlink (macOS /tmp is one), and a
// gate script then skipped its whole body and exited 0. A first argument that is not a file (`node -e "import(...)" reason`, as image.sh
// does) is an import, not a run. Tests: is-main.test.mjs.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const real = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
};

export const isMain = (url) => process.argv[1] !== undefined && real(process.argv[1]) === realpathSync(fileURLToPath(url));
