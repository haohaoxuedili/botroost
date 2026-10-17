import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KubeConfig } from '@kubernetes/client-node';
import { KubernetesDockerClient } from '../src/runtime/kubernetes-docker.js';
import { PodRuntimeStorage, LocalRuntimeStorage, StorageFileMissing } from '../src/runtime/storage.js';
import type { RuntimeDriver, RuntimeSpec } from '../src/runtime/types.js';

/** Minimal RuntimeDriver that records what the adapter asks it to do. */
function fakeDriver(overrides: Partial<RuntimeDriver> = {}) {
  const ensured: RuntimeSpec[] = [];
  const driver: RuntimeDriver = {
    backend: 'kubernetes',
    inspect: vi.fn(async () => ({ id: 'pod-uid-1', state: 'running' }) as never),
    ensure: vi.fn(async (spec: RuntimeSpec) => { ensured.push(spec); }),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
    forceRestart: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    logs: vi.fn(async () => 'log line') as never,
    ...overrides,
  };
  return { driver, ensured };
}

function kubeConfig() {
  const config = new KubeConfig();
  config.loadFromOptions({
    clusters: [{ name: 'test', server: 'https://example.invalid' }],
    users: [{ name: 'test' }],
    contexts: [{ name: 'test', cluster: 'test', user: 'test' }],
    currentContext: 'test',
  });
  return config;
}

describe('KubernetesDockerClient', () => {
  it('translates a Docker create into a StatefulSet spec: bind mounts become PVC subPaths', async () => {
    const { driver, ensured } = fakeDriver();
    const client = new KubernetesDockerClient(driver, { namespace: 'rt', volumeSize: '2Gi' }, undefined, kubeConfig());

    await client.create({
      name: 'snowluma-e1',
      image: 'example/snowluma:1',
      labels: { 'botroost.provider': 'snowluma' },
      environment: { TZ: 'Asia/Shanghai', DROPPED: 42 as never },
      // Provider passes host directories; the adapter keys the subPath off the last segment.
      mounts: [
        { type: 'bind', source: '/var/lib/agent/e1/qq', target: '/app/.config' },
        { type: 'bind', source: '/var/lib/agent/e1/config', target: '/app/snowluma-data' },
      ],
      hostConfig: { networkMode: 'bridge', portBindings: {} },
      resources: { cpuMillis: 1000, memoryMiB: 2048 },
      publishedPorts: [{ hostPort: '12345', containerPort: '6081' }],
      capAdd: ['SYS_PTRACE'],
      securityOpt: ['seccomp=unconfined'],
      shmBytes: 1024 ** 3,
    } as never);

    expect(ensured).toHaveLength(1);
    const spec = ensured[0]!;
    expect(spec.name).toBe('snowluma-e1');
    expect(spec.volumes).toEqual([
      { name: 'qq', target: '/app/.config' },
      { name: 'config', target: '/app/snowluma-data' },
    ]);
    // Host ports have no Kubernetes equivalent; the container port moves to the Service.
    expect(spec.ports).toEqual([{ name: 'port-6081', port: 6081 }]);
    expect(spec.capAdd).toEqual(['SYS_PTRACE']);
    expect(spec.securityOpt).toEqual(['seccomp=unconfined']);
    expect(spec.shmBytes).toBe(1024 ** 3);
    // Non-string environment values are dropped rather than stringified into nonsense.
    expect(spec.environment).toEqual({ TZ: 'Asia/Shanghai' });
  });

  it('returns the pod UID from inspect so providers can pass it back as a container id', async () => {
    const { driver } = fakeDriver();
    const client = new KubernetesDockerClient(driver, { namespace: 'rt', volumeSize: '2Gi' }, undefined, kubeConfig());
    const created = await client.create({
      name: 'llbot-e2', image: 'example/llbot:1', labels: {}, environment: {},
      mounts: [{ type: 'bind', source: '/var/lib/agent/e2/data', target: '/app/llbot/data' }],
      hostConfig: { networkMode: 'bridge', portBindings: {} },
      resources: { cpuMillis: 500, memoryMiB: 1024 },
    } as never);
    expect(created.id).toBe('pod-uid-1');
  });

  it('rejects a bind-mount source that cannot become a legal subPath', async () => {
    const { driver } = fakeDriver();
    const client = new KubernetesDockerClient(driver, { namespace: 'rt', volumeSize: '2Gi' }, undefined, kubeConfig());
    await expect(client.create({
      name: 'bad', image: 'x', labels: {}, environment: {},
      mounts: [{ type: 'bind', source: '/var/lib/agent/e3/Not_Valid', target: '/app/data' }],
      hostConfig: { networkMode: 'bridge', portBindings: {} },
      resources: { cpuMillis: 1, memoryMiB: 1 },
    } as never)).rejects.toThrow(/Invalid volume source directory/);
  });
});

describe('PodRuntimeStorage', () => {
  it('reads and writes endpoint files through the protocol container', async () => {
    const calls: { name: string; args: string[]; stdin?: string }[] = [];
    const runtime = {
      exec: vi.fn(async (name: string, args: string[], stdin?: string) => {
        calls.push({ name, args, ...(stdin === undefined ? {} : { stdin }) });
        // args is ['/bin/sh', '-c', <script>]
        const script = args[2] ?? '';
        if (script.startsWith('cat ')) return { stdout: '{"token":"secret"}\n', stderr: '' };
        if (script.startsWith('ls -1A ')) return { stdout: 'onebot11.json\nconfig\n', stderr: '' };
        return { stdout: '', stderr: '' };
      }),
    };
    const storage = new PodRuntimeStorage(runtime).for('snowluma-e1');

    expect(await storage.readdir('/app/snowluma-data/config')).toEqual(['onebot11.json', 'config']);
    expect(await storage.readFile('/app/snowluma-data/config/onebot11.json')).toBe('{"token":"secret"}\n');

    // Writes are base64-encoded so JSON containing quotes/newlines survives the shell hop.
    await storage.writeFile('/app/snowluma-data/config/onebot11.json', '{"a":"it\'s \"quoted\"\n"}');
    const write = calls.at(-1)!;
    const encoded = /printf %s '([A-Za-z0-9+/=]+)' \| base64 -d > '([^']+)'/.exec(write.args[2]!)!;
    expect(Buffer.from(encoded[1]!, 'base64').toString('utf8')).toBe('{"a":"it\'s \"quoted\"\n"}');
    expect(encoded[2]).toBe('/app/snowluma-data/config/onebot11.json');

    // Every call is addressed at the workload the scope was created for.
    expect(calls.every(call => call.name === 'snowluma-e1')).toBe(true);
  });

  it('reports a missing file as StorageFileMissing instead of an opaque exec failure', async () => {
    const runtime = { exec: vi.fn(async () => { throw new Error('command terminated with exit code 1: cat: /app/x.json: No such file or directory'); }) };
    const storage = new PodRuntimeStorage(runtime).for('llbot-e1');
    await expect(storage.readFile('/app/x.json')).rejects.toBeInstanceOf(StorageFileMissing);
    // A readdir of an absent directory is an empty listing, matching the local backend.
    expect(await storage.readdir('/app/absent')).toEqual([]);
  });

  it('creates directories world-writable so the image user can write them', async () => {
    const exec = vi.fn(async (_name: string, _args: string[], _stdin?: string) => ({ stdout: '', stderr: '' }));
    await new PodRuntimeStorage({ exec }).for('napcat-e1').ensureDirectory('/data/qq');
    expect(exec.mock.calls[0]![1]).toEqual(['/bin/sh', '-c', "mkdir -p '/data/qq' && chmod 777 '/data/qq'"]);
  });
});

describe('LocalRuntimeStorage', () => {
  it('is the default backend and distinguishes missing from empty', async () => {
    const storage = new LocalRuntimeStorage();
    expect(storage.kind).toBe('local');
    // A directory that does not exist yet is a normal first-run condition.
    expect(await storage.for('unused').readdir('/nonexistent/botroost-test-dir')).toEqual([]);
    await expect(storage.for('unused').readFile('/nonexistent/botroost-test-dir/x.json')).rejects.toBeInstanceOf(StorageFileMissing);
  });
});
