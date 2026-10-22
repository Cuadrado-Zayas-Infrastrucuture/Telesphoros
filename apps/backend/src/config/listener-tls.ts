/**
 * The listener's TLS, when the API's own certificate and key are configured (audit FE-02: the load balancer reaches the task over TLS).
 * The load balancer does not check the task's certificate, so a self-signed one encrypts the hop; authenticating it is a separate decision.
 * Both values are required together and in production (env.ts); with neither, the listener stays plain HTTP, as in development and tests.
 */
export function listenerTls(env: { TLS_CERT_PEM?: string; TLS_KEY_PEM?: string }): { cert: string; key: string } | undefined {
  if (!env.TLS_CERT_PEM || !env.TLS_KEY_PEM) return undefined;
  return { cert: env.TLS_CERT_PEM, key: env.TLS_KEY_PEM };
}
