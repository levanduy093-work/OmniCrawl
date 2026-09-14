const path = require('node:path');
const { spawnSync } = require('node:child_process');
const dotenv = require('dotenv');

const workspaceRoot = path.resolve(__dirname, '..', '..', '..');
const envPath = path.join(workspaceRoot, '.env');

dotenv.config({ path: envPath, quiet: true });

const prismaCli = require.resolve('prisma/build/index.js');
const result = spawnSync(process.execPath, [prismaCli, ...process.argv.slice(2)], {
  cwd: path.resolve(__dirname, '..'),
  env: process.env,
  stdio: 'inherit'
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
