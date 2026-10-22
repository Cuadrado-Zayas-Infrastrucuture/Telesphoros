import { listenerTls } from './listener-tls';

describe('listenerTls', () => {
  it('stays plain HTTP unless both the certificate and the key are configured', () => {
    expect(listenerTls({})).toBeUndefined();
    expect(listenerTls({ TLS_CERT_PEM: 'cert' })).toBeUndefined();
    expect(listenerTls({ TLS_KEY_PEM: 'key' })).toBeUndefined();
  });

  it('serves TLS with exactly the configured certificate and key', () => {
    expect(listenerTls({ TLS_CERT_PEM: 'synthetic-cert', TLS_KEY_PEM: 'synthetic-key' })).toEqual({ cert: 'synthetic-cert', key: 'synthetic-key' });
  });
});
