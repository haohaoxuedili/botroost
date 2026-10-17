/** Browser-facing address for a runtime's UI port.
 *
 *  Docker publishes host ports, so the web console reaches the UI at `<hostname>:<port>` on
 *  its own. Kubernetes only exposes ClusterIP Services, which a browser cannot dial, so the
 *  operator supplies the cluster entry point (Ingress host, or a port-forward base) as a
 *  template. When no template is configured no URL is produced: the console must not invent a
 *  link that cannot be opened, and the endpoint is reported as reachable from inside the
 *  cluster only.
 *
 *  `{port}` in the template is replaced with the UI port, e.g.
 *  `RUNTIME_LOGIN_BASE_URL=https://{port}.runtime.example.com`.
 */
export function loginUrl(port: number): string | undefined {
  const template = process.env.RUNTIME_LOGIN_BASE_URL?.trim();
  if (!template) return undefined;
  const resolved = template.replace(/\{port\}/g, String(port)).replace(/\/+$/, '');
  return resolved ? `${resolved}/` : undefined;
}

/** Host the *console's API* should use to reach a runtime's UI ports.
 *
 *  Docker publishes host ports on the agent host, which is also where the console runs, so the
 *  backend reports no such host and the console falls back to its own hostname. Kubernetes
 *  reports the runtime Service's address: a browser cannot dial it, but the API can, so the
 *  console proxies every request through its own origin and the operator never needs a second
 *  hostname or a port-forward.
 */
export function runtimeHost(serviceHost: string | null | undefined): string | undefined {
  const value = serviceHost?.trim();
  return value ? value : undefined;
}
