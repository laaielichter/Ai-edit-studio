// "Was this file started directly?" — compared on real paths, because macOS reaches /var and /tmp through
// symlinks (/private/var…) and a plain string compare then silently skipped main() for `node /var/…/cli.mjs`.
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const real = file => { try { return realpathSync(file); } catch { return path.resolve(file); } };
export const isMainModule = (metaUrl, argv1 = process.argv[1]) => Boolean(argv1) && real(argv1) === real(fileURLToPath(metaUrl));
