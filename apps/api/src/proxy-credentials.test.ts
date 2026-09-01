import assert from 'node:assert/strict';
import {
  decryptProxySecret,
  encryptProxySecret,
  redactProxy
} from './proxy-credentials';

process.env.PROXY_CREDENTIAL_KEY = 'proxy-security-test-key';

const first = encryptProxySecret('secret-value');
const second = encryptProxySecret('secret-value');
assert.ok(first?.startsWith('enc:v1:'));
assert.ok(second?.startsWith('enc:v1:'));
assert.notEqual(first, second, 'AES-GCM must use a fresh IV for every write');
assert.equal(decryptProxySecret(first), 'secret-value');
assert.equal(decryptProxySecret(second), 'secret-value');
assert.equal(decryptProxySecret('legacy-plaintext'), 'legacy-plaintext');
assert.deepEqual(
  redactProxy({ id: 'proxy-1', password: first }),
  { id: 'proxy-1', hasPassword: true }
);

console.log('Proxy credential security tests passed.');
