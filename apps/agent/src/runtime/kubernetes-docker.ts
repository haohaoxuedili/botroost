import { CoreV1Api, Exec, KubeConfig, KubernetesObjectApi, Metrics, type V1Status } from '@kubernetes/client-node';
import { PassThrough } from 'node:stream';
import type { DockerClient, DockerCreateInput, DockerInspectResult } from '../index.js';
import type { DockerResourceSample } from '../resource-usage.js';
import type { RuntimeDriver, RuntimeSpec, RuntimeVolume } from './types.js';
import { type KubernetesProfile } from './kubernetes-resources.js';

/**
 * Kubernetes-backed DockerClient.
 *
 * SnowLuma and LLBot are written against the Docker API surface rather than the
 * RuntimeDriver boundary NapCat was migrated to. This adapter presents that same surface
 * on top of Kubernetes primitives, so both providers run unchanged on
 * AGENT_RUNTIME=kubernetes without a Docker daemon and without host networking:
 *
 *   docker.create(host bind + published port) -> StatefulSet + PVC subPath + Service ports
 *   docker.exec                              -> pods/exec on the protocol container
 *   inspect().ipAddress                      -> <name>.<namespace>.svc (Service DNS)
 *   docker.removeHostEndpoint                -> PVC retained, host state untouched
 *
 * It composes an existing RuntimeDriver for lifecycle work (inspect/start/stop/restart/
 * logs/stats) so the ownership checks, convergence waits and template-marker idempotency
 * that NapCat already relies on are shared instead of duplicated.
 */
export class KubernetesDockerClient implements DockerClient {
  private core: CoreV1Api;
  private execClient: Exec;
  private objects: KubernetesObjectApi;
  private metricsApi?: Metrics;
  private volumes = new Map<string, RuntimeVolume[]>();
  private kc: KubeConfig;
  constructor(private driver: RuntimeDriver, private profile: KubernetesProfile, private signal?: AbortSignal, config?: KubeConfig) {
    const kc = config ?? new KubeConfig();
    if (!config) kc.loadFromCluster();
    this.kc = kc;
    this.core = kc.makeApiClient(CoreV1Api);
    this.execClient = new Exec(kc);
    this.objects = KubernetesObjectApi.makeApiClient(kc);
    this.metricsApi = new Metrics(kc);
  }
  // ---- registry of a created workload's volumes -------------------------------------
  // Docker's exec/logs only need a name, but Kubernetes needs to know which subPath each
  // mount came from to keep the same layout across restarts. The bind source is the
  // per-endpoint directory, and its basename is the subPath the claim stores it under.
  private remember(name: string, mounts: DockerCreateInput['mounts']) {
    this.volumes.set(name, mounts.map(mount => ({ name: this.subPathFor(mount.source), target: mount.target })));
  }
  private subPathFor(source: string) {
    const base = source.replace(/\/+$/, '').split('/').pop() ?? '';
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(base)) throw new Error(`Invalid volume source directory: ${source}`);
    return base as RuntimeVolume['name'];
  }
  // Previous runs of this adapter (and the provider's own mount list) agree on these
  // targets; recovering the mapping from the live StatefulSet keeps restarts working even
  // when the process that created the workload is gone.
  private async volumesFor(name: string): Promise<RuntimeVolume[]> {
    const remembered = this.volumes.get(name);
    if (remembered) return remembered;
    const workload = await this.readWorkload(name);
    const mounts: { mountPath: string; subPath?: string }[] = workload?.spec?.template?.spec?.containers?.[0]?.volumeMounts ?? [];
    const discovered = mounts.filter(mount => mount.subPath).map(mount => ({ name: mount.subPath as RuntimeVolume['name'], target: mount.mountPath }));
    if (discovered.length) { this.volumes.set(name, discovered); return discovered; }
    return [];
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async readWorkload(name: string): Promise<any | null> {
    this.signal?.throwIfAborted();
    try {
      return await this.objects.read({ apiVersion: 'apps/v1', kind: 'StatefulSet', metadata: { name, namespace: this.profile.namespace } });
    } catch (error) { if ((error as { code?: number }).code === 404) return null; throw error; }
  }
  // ---- DockerClient surface ---------------------------------------------------------
  async create(input: DockerCreateInput): Promise<{ id: string }> {
    this.signal?.throwIfAborted();
    this.remember(input.name, input.mounts);
    // Docker publishes host ports; Kubernetes routes the same container ports through the
    // Service, which is why the provider can reach them at the inspect() address.
    const ports = (input.publishedPorts ?? []).map(port => ({ name: `port-${port.containerPort}`, port: Number(port.containerPort) }));
    const spec: RuntimeSpec = {
      name: input.name,
      image: input.image,
      labels: input.labels,
      environment: Object.fromEntries(Object.entries(input.environment ?? {}).filter(([, value]) => typeof value === 'string')),
      volumes: this.volumes.get(input.name)!,
      resources: { cpuMillis: input.resources.cpuMillis, memoryMiB: input.resources.memoryMiB },
      ...(ports.length ? { ports } : {}),
      ...(input.capAdd ? { capAdd: input.capAdd } : {}),
      ...(input.securityOpt ? { securityOpt: input.securityOpt } : {}),
      ...(input.shmBytes ? { shmBytes: input.shmBytes } : {}),
    };
    await this.driver.ensure(spec);
    const inspected = await this.driver.inspect(input.name);
    return { id: inspected?.id ?? input.name };
  }
  inspect(name: string): Promise<DockerInspectResult | null> { return this.driver.inspect(name); }
  // Providers legitimately call lifecycle methods with either the container name or the id
  // returned by create()/inspect(). Docker accepts both; Kubernetes only knows names, so
  // resolve a pod UID back to the workload that owns it.
  private async resolveName(reference: string): Promise<string> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reference)) return reference;
    // UID, not a name: find the owning Pod. A direct read covers the case where a provider
    // passed a pod name; the label scan covers ids handed back by inspect().
    const read = await this.core.readNamespacedPod({ name: reference, namespace: this.profile.namespace }).then(pod => pod.metadata).catch(() => null);
    const metadata = read ?? await this.core.listNamespacedPod({ namespace: this.profile.namespace })
      .then(list => list.items.find(item => item.metadata?.uid === reference)?.metadata)
      .catch(() => undefined);
    const owner = metadata?.ownerReferences?.find(entry => entry.kind === 'StatefulSet')?.name;
    // Only resolve when a StatefulSet really owns the pod; otherwise the reference is not ours.
    if (!owner) throw new Error(`No Kubernetes workload owns container ${reference}`);
    return owner;
  }
  async start(name: string): Promise<void> { return this.driver.start(await this.resolveName(name)); }
  async stop(name: string): Promise<void> { return this.driver.stop(await this.resolveName(name)); }
  async restart(name: string): Promise<void> { return this.driver.restart(await this.resolveName(name), `docker-restart-${Date.now()}`); }
  async kill(name: string): Promise<void> { return this.driver.forceRestart(await this.resolveName(name), `docker-kill-${Date.now()}`); }
  async remove(name: string): Promise<void> { return this.driver.delete(await this.resolveName(name)); }
  // Docker deletes the endpoint's host directory. Kubernetes claims are retained by
  // policy (whenDeleted/whenScaled=Retain) so a delete command can never destroy the
  // QQ login state; ownership removal is the explicit delete above.
  async removeHostEndpoint(): Promise<void> { /* intentionally retained on Kubernetes */ }
  logs(name: string, options: { tail: number; sinceSeconds: number; timestamps?: boolean; maxBytes?: number }) { return this.driver.logs(name, options); }
  async exec(name: string, args: string[], stdin?: string): Promise<{ stdout: string; stderr: string }> {
    this.signal?.throwIfAborted();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let out = '', err = '';
    stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
    stderr.on('data', (chunk: Buffer) => { err += chunk.toString('utf8'); });
    // File content travels over the exec stream, never the command line: PVC writes would
    // otherwise have to survive shell quoting for arbitrary JSON.
    let input: PassThrough | null = null;
    if (stdin !== undefined) { input = new PassThrough(); input.end(stdin); }
    let exitCode: number | null = null;
    const socket = await this.execClient.exec(
      this.profile.namespace, `${name}-0`, 'protocol',
      Array.isArray(args) && args.length ? args : ['/bin/sh'],
      stdout, stderr, input, false,
      (status: V1Status) => {
        // A non-zero exit arrives as a Status object; the code lives in `reason`/`details`.
        const details = status.details as { causes?: { reason?: string; message?: string }[] } | undefined;
        const cause = details?.causes?.find(entry => entry.reason === 'ExitCode');
        if (cause?.message) exitCode = Number(cause.message);
      },
    );
    await new Promise<void>((resolve, reject) => {
      socket.on('close', () => resolve());
      socket.on('error', reject);
    });
    if (exitCode !== null && Number.isFinite(exitCode) && exitCode !== 0) throw new Error(`exec failed (exit ${exitCode}): ${(err || out).trim()}`);
    return { stdout: out, stderr: err };
  }
  // Resource telemetry via metrics.k8s.io, keyed by pod UID to match inspect().id.
  async stats(podUids: string[]): Promise<Map<string, DockerResourceSample>> {
    const ids = [...new Set(podUids)];
    if (!ids.length || !this.metricsApi) return new Map();
    const wanted = new Set(ids);
    const list = await this.metricsApi.getPodMetrics(this.profile.namespace);
    const result = new Map<string, DockerResourceSample>();
    for (const pod of list.items) {
      const uid = (pod.metadata as { uid?: string } | undefined)?.uid;
      if (!uid || !wanted.has(uid)) continue;
      let nanoCpus = 0, memoryBytes = 0;
      for (const container of pod.containers) {
        nanoCpus += parseQuantity(container.usage?.cpu);
        memoryBytes += parseQuantity(container.usage?.memory);
      }
      if (nanoCpus > 0 || memoryBytes > 0) result.set(uid, { cpuPercent: nanoCpus / 10_000_000, memoryBytes: Math.round(memoryBytes) });
    }
    return result;
  }
  /** Prime the volume map for a workload that already exists (agent restart). */
  async adopt(name: string) { await this.volumesFor(name); }
}
// Parses Kubernetes resource quantities ("8073539n", "258980Ki", "2G") into base units.
function parseQuantity(value: string | undefined): number {
  if (!value) return 0;
  const match = /^(\d+(?:\.\d+)?)(m|u|n|k|M|G|T|P|E|Ki|Mi|Gi|Ti|Pi|Ei)?$/.exec(value.trim());
  if (!match) return 0;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return 0;
  switch (match[2]) {
    case undefined: case 'n': return base;
    case 'u': return base * 1_000;
    case 'm': return base * 1_000_000;
    case 'k': return base * 1e3;
    case 'M': return base * 1e6;
    case 'G': return base * 1e9;
    case 'T': return base * 1e12;
    case 'P': return base * 1e15;
    case 'E': return base * 1e18;
    case 'Ki': return base * 1024;
    case 'Mi': return base * 1024 ** 2;
    case 'Gi': return base * 1024 ** 3;
    case 'Ti': return base * 1024 ** 4;
    case 'Pi': return base * 1024 ** 5;
    case 'Ei': return base * 1024 ** 6;
    default: return 0;
  }
}
