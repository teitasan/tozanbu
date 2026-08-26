#!/usr/bin/env node
/* ===========================================================
   地形生成の決定論性と骨格メトリクスを検証する。
   開発依存に含めた vite-node で TypeScript ソースを直接実行する。

   使い方: npm run test:terrain
   =========================================================== */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const child = spawn(
  'vite-node',
  [join(root, 'scripts/terrain-test-runner.ts')],
  { cwd: root, stdio: 'inherit' },
);

child.on('exit', (code) => process.exit(code ?? 1));
