import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pruneTestRuns } from './lib/testRunStorage.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = await pruneTestRuns(path.join(repoRoot, 'test-artifacts', 'runs'));
process.stdout.write(`${JSON.stringify({ status: 'pruned', ...result }, null, 2)}\n`);
