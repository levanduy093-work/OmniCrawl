import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { loadOrCreateRuntimeSecret } from './runtime-secret';

const ENCRYPTED_PREFIX = 'enc:v1:';

function credentialKey(): Buffer {
  // Keep an env override for deployments that already inject secrets, but do
  // not require it for the local-first app. The generated key lives in ignored
  // runtime storage and is readable only by the current OS user.
  return createHash('sha256')
    .update(loadOrCreateRuntimeSecret('.proxy-credential-key', 'PROXY_CREDENTIAL_KEY'))
    .digest();
}

export function encryptProxySecret(value: unknown): string | null {
  const plaintext = String(value || '');
  if (!plaintext) return null;
  if (plaintext.startsWith(ENCRYPTED_PREFIX)) return plaintext;

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', credentialKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  return `${ENCRYPTED_PREFIX}${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

export function decryptProxySecret(value: string | null): string | null {
  if (!value) return null;
  if (!value.startsWith(ENCRYPTED_PREFIX)) {
    // Backward compatibility for pre-encryption rows. New writes are encrypted.
    return value;
  }

  const encoded = value.slice(ENCRYPTED_PREFIX.length);
  const [ivPart, tagPart, ciphertextPart] = encoded.split('.');
  if (!ivPart || !tagPart || !ciphertextPart) {
    throw new Error('Stored proxy credential is malformed');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    credentialKey(),
    Buffer.from(ivPart, 'base64url')
  );
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextPart, 'base64url')),
    decipher.final()
  ]).toString('utf8');
}

export function redactProxy<T extends { password?: string | null }>(proxy: T) {
  const { password, ...safe } = proxy;
  return { ...safe, hasPassword: Boolean(password) };
}
