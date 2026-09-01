import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export function loadOrCreateRuntimeSecret(
  filename: string,
  environmentVariable: string,
  bytes = 32
): string {
  const configured = process.env[environmentVariable];
  if (configured) return configured;

  const secretPath = path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    'storage',
    filename
  );
  fs.mkdirSync(path.dirname(secretPath), { recursive: true, mode: 0o700 });
  try {
    const existing = fs.readFileSync(secretPath, 'utf8').trim();
    if (!existing) throw new Error(`Runtime secret ${filename} is empty`);
    return existing;
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const generated = randomBytes(bytes).toString('base64url');
  try {
    fs.writeFileSync(secretPath, generated, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    });
    return generated;
  } catch (error: any) {
    if (error?.code !== 'EEXIST') throw error;
    const raced = fs.readFileSync(secretPath, 'utf8').trim();
    if (!raced) throw new Error(`Runtime secret ${filename} is empty`);
    return raced;
  }
}
