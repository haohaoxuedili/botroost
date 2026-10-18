import { describe, it, expect, vi } from 'vitest';
import { KubeConfig, KubernetesObjectApi } from '@kubernetes/client-node';
import { KubernetesRuntimeDriver } from '../src/runtime/kubernetes.js';

function fixture() {
  const config = new KubeConfig();
  config.loadFromOptions({ clusters: [{ name: 'test', server: 'https://example.invalid' }], users: [{ name: 'test' }], contexts: [{ name: 'test', cluster: 'test', user: 'test' }], currentContext: 'test' });
  const labels = { 'botroost.endpoint_id': 'endpoint', 'botroost.workspace_id': 'workspace', 'botroost.provider': 'napcat' };
  const workload = { apiVersion: 'apps/v1', kind: 'StatefulSet', metadata: { name: 'test', uid: 'workload-uid', resourceVersion: '1', labels }, spec: { replicas: 1, template: { spec: { containers: [{ image: 'example/image' }] } } } };
  return { config, workload, labels };
}
describe('Kubernetes API lifecycle safety', () => {
  it('does not wait for an identically named replacement pod to disappear', async () => {
    const { config, workload, labels } = fixture();
    let removed = false;
    const read = vi.spyOn(KubernetesObjectApi.prototype, 'read').mockImplementation(async object => {
      if (object.kind === 'StatefulSet') return workload;
      return { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'test-0', uid: removed ? 'replacement' : 'original', resourceVersion: '2', labels, annotations: removed ? { 'botroost.io/restart-operation': 'op' } : {} }, status: { containerStatuses: [{ name: 'protocol', state: { running: {} } }] } };
    });
    const patch = vi.spyOn(KubernetesObjectApi.prototype, 'patch').mockResolvedValue(workload);
    const remove = vi.spyOn(KubernetesObjectApi.prototype, 'delete').mockImplementation(async () => { removed = true; return {}; });
    try {
      await new KubernetesRuntimeDriver({ namespace: 'test', volumeSize: '2Gi' }, undefined, config).restart('test', 'op');
      expect(remove).toHaveBeenCalledOnce();
      for (const call of patch.mock.calls) expect(call[4]).toBeUndefined();
      // The uid keeps a replacement pod from being deleted by a stale call; the resourceVersion
      // only added conflicts, because a running pod's version moves with every status update.
      expect(remove.mock.calls[0]?.[6]).toEqual({ preconditions: { uid: 'original' } });
    } finally { read.mockRestore(); patch.mockRestore(); remove.mockRestore(); }
  }, 2000);
  it('retries a patch that loses the resourceVersion race instead of failing the operation', async () => {
    const { config, workload, labels } = fixture();
    // The pod already carries the marker, so restart() has nothing left to do once the
    // template write succeeds -- the assertion is about the patch, not the rollout.
    const read = vi.spyOn(KubernetesObjectApi.prototype, 'read').mockImplementation(async object => object.kind === 'StatefulSet'
      ? workload
      : { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'test-0', uid: 'original', resourceVersion: '2', labels, annotations: { 'botroost.io/restart-operation': 'op' } }, status: { containerStatuses: [{ name: 'protocol', state: { running: {} } }] } });
    // The control loop and the kubelet both write the same StatefulSet, so the first two
    // attempts carry a version that is already stale.
    const conflict = Object.assign(new Error('the object has been modified'), { code: 409 });
    const patch = vi.spyOn(KubernetesObjectApi.prototype, 'patch')
      .mockRejectedValueOnce(conflict)
      .mockRejectedValueOnce(conflict)
      .mockResolvedValue(workload);
    try {
      await new KubernetesRuntimeDriver({ namespace: 'test', volumeSize: '2Gi' }, undefined, config).restart('test', 'op');
      // Two conflicts, then success: the operation continues instead of surfacing the 409.
      // The following scale() patch from start() is a separate write with its own retries.
      expect(patch.mock.calls.length).toBeGreaterThanOrEqual(3);
    } finally { read.mockRestore(); patch.mockRestore(); }
  }, 5000);
  it('refuses a claim that belongs to another endpoint', async () => {
    // Deleting by a reused name must not destroy a volume whose labels name someone else.
    const { config } = fixture();
    const claim = { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: 'reused', uid: 'claim-uid', resourceVersion: '1', labels: { 'botroost.endpoint_id': 'someone-else', 'botroost.workspace_id': 'ws-2', 'botroost.provider': 'napcat' } } };
    const read = vi.spyOn(KubernetesObjectApi.prototype, 'read').mockResolvedValue(claim as never);
    const remove = vi.spyOn(KubernetesObjectApi.prototype, 'delete').mockResolvedValue({});
    try {
      const driver = new KubernetesRuntimeDriver({ namespace: 'test', volumeSize: '2Gi', agentNamespace: 'botroost-system' }, undefined, config);
      await expect(driver.deleteData('reused', { endpointId: 'mine', workspaceId: 'ws-1', provider: 'napcat' })).rejects.toThrow(/ownership/);
      expect(remove).not.toHaveBeenCalled();
    } finally { read.mockRestore(); remove.mockRestore(); }
  }, 5000);

  it('drops the claim of the endpoint it was told to delete', async () => {
    const { config } = fixture();
    const labels = { 'botroost.endpoint_id': 'mine', 'botroost.workspace_id': 'ws-1', 'botroost.provider': 'napcat' };
    const claim = { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: 'mine', uid: 'claim-uid', resourceVersion: '1', labels } };
    let gone = false;
    const read = vi.spyOn(KubernetesObjectApi.prototype, 'read').mockImplementation((async () => (gone ? null : claim)) as never);
    const remove = vi.spyOn(KubernetesObjectApi.prototype, 'delete').mockImplementation(async () => { gone = true; return {}; });
    try {
      const driver = new KubernetesRuntimeDriver({ namespace: 'test', volumeSize: '2Gi', agentNamespace: 'botroost-system' }, undefined, config);
      await driver.deleteData('mine', { endpointId: 'mine', workspaceId: 'ws-1', provider: 'napcat' });
      expect(remove.mock.calls[0]?.[0]).toMatchObject({ kind: 'PersistentVolumeClaim', metadata: { name: 'mine' } });
    } finally { read.mockRestore(); remove.mockRestore(); }
  }, 5000);

  it('does not delete a claim for a command whose lease was lost', async () => {
    const { config } = fixture();
    const read = vi.spyOn(KubernetesObjectApi.prototype, 'read').mockResolvedValue({ apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: 'mine', uid: 'claim-uid', labels: { 'botroost.endpoint_id': 'mine', 'botroost.workspace_id': 'ws-1', 'botroost.provider': 'napcat' } } } as never);
    const remove = vi.spyOn(KubernetesObjectApi.prototype, 'delete').mockResolvedValue({});
    try {
      const driver = new KubernetesRuntimeDriver({ namespace: 'test', volumeSize: '2Gi', agentNamespace: 'botroost-system' }, undefined, config);
      const aborted = AbortSignal.abort(new Error('command lease refresh failed'));
      await expect(driver.deleteData('mine', { endpointId: 'mine', workspaceId: 'ws-1', provider: 'napcat' }, aborted)).rejects.toThrow(/lease/);
      await expect(driver.delete('mine', aborted)).rejects.toThrow(/lease/);
      expect(remove).not.toHaveBeenCalled();
    } finally { read.mockRestore(); remove.mockRestore(); }
  }, 5000);

  it('lets a retry finish claim cleanup after the workload is already gone', async () => {
    // The first attempt removed the StatefulSet and then failed on the claim; the retry must
    // not refuse because there is no workload left to read ownership from.
    const { config } = fixture();
    const seen: string[] = [];
    const read = vi.spyOn(KubernetesObjectApi.prototype, 'read').mockImplementation((async (object: { kind?: string }) => { seen.push(String(object.kind)); return null; }) as never);
    try {
      const driver = new KubernetesRuntimeDriver({ namespace: 'test', volumeSize: '2Gi', agentNamespace: 'botroost-system' }, undefined, config);
      await expect(driver.delete('gone')).resolves.toBeUndefined();
      await expect(driver.deleteData('gone', { endpointId: 'gone', workspaceId: 'ws-1', provider: 'napcat' })).resolves.toBeUndefined();
      expect(seen).toContain('StatefulSet');
    } finally { read.mockRestore(); }
  }, 5000);

  it('addresses a NetworkPolicy in its own API group', async () => {
    // A NetworkPolicy read or deleted as "v1" fails with "Unrecognized API version and kind",
    // which is what broke snowluma start and delete in production.
    const { config, workload } = fixture();
    const seen: string[] = [];
    let policyGone = false;
    let workloadGone = false;
    const read = vi.spyOn(KubernetesObjectApi.prototype, 'read').mockImplementation((async (object: { apiVersion?: string; kind?: string; metadata?: { name?: string } }) => {
      seen.push(`${object.apiVersion}/${object.kind}`);
      if (object.kind === 'StatefulSet') return workloadGone ? null : workload;
      if (object.kind === 'NetworkPolicy' && !policyGone) return { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: { name: object.metadata!.name, uid: 'policy-uid', resourceVersion: '1', labels: workload.metadata.labels } };
      return null;
    }) as never);
    const patch = vi.spyOn(KubernetesObjectApi.prototype, 'patch').mockResolvedValue(workload);
    const remove = vi.spyOn(KubernetesObjectApi.prototype, 'delete').mockImplementation(async object => { if (object?.kind === 'NetworkPolicy') policyGone = true; if (object?.kind === 'StatefulSet') workloadGone = true; return {}; });
    try {
      await new KubernetesRuntimeDriver({ namespace: 'test', volumeSize: '2Gi', agentNamespace: 'botroost-system' }, undefined, config).delete('test');
      expect(remove.mock.calls.some(call => call[0]?.kind === 'NetworkPolicy' && call[0]?.apiVersion === 'networking.k8s.io/v1')).toBe(true);
      expect(seen).not.toContain('v1/NetworkPolicy');
    } finally { read.mockRestore(); patch.mockRestore(); remove.mockRestore(); }
  }, 5000);
  it('restores the previous resource request when the larger replacement cannot be scheduled', async () => {
    const { config, labels } = fixture();
    const small = { requests: { cpu: '1', memory: '1Gi' }, limits: { cpu: '1', memory: '1Gi' } };
    const large = { requests: { cpu: '2', memory: '2Gi' }, limits: { cpu: '2', memory: '2Gi' } };
    // ensure() already wrote the larger request to the template before restart() ran.
    let templateResources = large;
    const workload = () => ({ apiVersion: 'apps/v1', kind: 'StatefulSet', metadata: { name: 'test', uid: 'workload-uid', resourceVersion: '1', labels },
      spec: { replicas: 1, template: { spec: { containers: [{ name: 'protocol', image: 'example/image', resources: templateResources }] } } } });
    let pod: Record<string, unknown> | null = { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'test-0', uid: 'original', resourceVersion: '2', labels, annotations: {} },
      spec: { containers: [{ name: 'protocol', resources: small }] }, status: { containerStatuses: [{ name: 'protocol', state: { running: {} } }] } };
    const read = vi.spyOn(KubernetesObjectApi.prototype, 'read').mockImplementation(async object => {
      if (object.kind === 'StatefulSet') return workload();
      return pod as never;
    });
    const patch = vi.spyOn(KubernetesObjectApi.prototype, 'patch').mockImplementation(async object => {
      const containers = (object as { spec?: { template?: { spec?: { containers?: { resources?: unknown }[] } } } }).spec?.template?.spec?.containers;
      const restored = containers?.[0]?.resources;
      if (restored) templateResources = restored as typeof large;
      return workload();
    });
    // The first replacement is rejected by the scheduler; the pod created after the restore runs.
    const remove = vi.spyOn(KubernetesObjectApi.prototype, 'delete').mockImplementation(async object => {
      const wasOriginal = (pod?.metadata as { uid?: string } | undefined)?.uid === 'original';
      pod = wasOriginal
        ? { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'test-0', uid: 'pending', resourceVersion: '3', labels, annotations: { 'botroost.io/restart-operation': 'op' } },
            spec: { containers: [{ name: 'protocol', resources: large }] },
            status: { conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable' }] } }
        : { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'test-0', uid: 'restored', resourceVersion: '4', labels, annotations: { 'botroost.io/restart-operation': 'op' } },
            spec: { containers: [{ name: 'protocol', resources: templateResources }] }, status: { containerStatuses: [{ name: 'protocol', state: { running: {} } }] } };
      void object;
      return {};
    });
    try {
      await expect(new KubernetesRuntimeDriver({ namespace: 'test', volumeSize: '2Gi' }, undefined, config).restart('test', 'op'))
        .rejects.toThrow(/running again on its previous resources/);
      // The template was rewritten to the 1 vCPU / 1 GiB the endpoint was actually running on.
      expect(templateResources).toEqual(small);
      // Original pod, the unschedulable replacement, and nothing else: no third pod was needed.
      // The unschedulable replacement was deleted and replaced by a pod of the old size.
      expect((pod as { metadata?: { uid?: string } })?.metadata?.uid).toBe('restored');
      expect(remove).toHaveBeenCalledTimes(2);
    } finally { read.mockRestore(); patch.mockRestore(); remove.mockRestore(); }
  }, 20000);
  it('maps pod-metric UIDs to resource samples and tolerates unknown quantities', async () => {
    const { config } = fixture();
    const driver = new KubernetesRuntimeDriver({ namespace: 'test', volumeSize: '2Gi' }, undefined, config);
    const metrics = await import('@kubernetes/client-node');
    // @ts-expect-error: Metrics is constructed with the config; substitute a stub.
    driver['metricsApi'] = { getPodMetrics: async () => ({
      kind: 'PodMetricsList', apiVersion: 'metrics.k8s.io/v1beta1', metadata: {},
      items: [
        { metadata: { name: 'pod-a', namespace: 'test', uid: 'uid-a', creationTimestamp: '' }, timestamp: '', window: '30s', containers: [{ name: 'protocol', usage: { cpu: '8073539n', memory: '258980Ki' } }] },
        { metadata: { name: 'pod-b', namespace: 'test', uid: 'uid-b', creationTimestamp: '' }, timestamp: '', window: '30s', containers: [{ name: 'protocol', usage: { cpu: '1000000n', memory: '2Mi' } }, { name: 'sidecar', usage: { cpu: '500000n', memory: '1Mi' } }] },
        { metadata: { name: 'pod-c', namespace: 'test', uid: 'uid-c', creationTimestamp: '' }, timestamp: '', window: '30s', containers: [{ name: 'protocol', usage: { cpu: 'bogus', memory: '' } }] },
      ],
    } as never) };
    const result = await driver.stats(['uid-a', 'uid-b', 'uid-other']);
    expect(result.get('uid-a')).toEqual({ cpuPercent: 0.8073539, memoryBytes: 258980 * 1024 });
    // Multi-container pods sum to a pod-level sample.
    expect(result.get('uid-b')).toEqual({ cpuPercent: 0.15, memoryBytes: 3 * 1024 * 1024 });
    // Malformed quantities contribute zero; zero-only pods are omitted.
    expect(result.has('uid-c')).toBe(false);
    expect(result.has('uid-other')).toBe(false);
    expect(metrics).toBeTruthy();
  });
  it('falls back to the pod name when PodMetrics omits metadata.uid', async () => {
    const { config } = fixture();
    const driver = new KubernetesRuntimeDriver({ namespace: 'test', volumeSize: '2Gi' }, undefined, config);
    // The hk cluster's metrics-server returns no uid at all; inspect() is what records the pair.
    driver['podUidToName'].set('uid-a', 'pod-a');
    // @ts-expect-error: Metrics is constructed with the config; substitute a stub.
    driver['metricsApi'] = { getPodMetrics: async () => ({
      kind: 'PodMetricsList', apiVersion: 'metrics.k8s.io/v1beta1', metadata: {},
      items: [
        { metadata: { name: 'pod-a', namespace: 'test', creationTimestamp: '' }, timestamp: '', window: '30s', containers: [{ name: 'protocol', usage: { cpu: '2000000n', memory: '4Mi' } }] },
        { metadata: { name: 'pod-unknown', namespace: 'test', creationTimestamp: '' }, timestamp: '', window: '30s', containers: [{ name: 'protocol', usage: { cpu: '9000000n', memory: '9Mi' } }] },
      ],
    } as never) };
    const result = await driver.stats(['uid-a']);
    expect(result.get('uid-a')).toEqual({ cpuPercent: 0.2, memoryBytes: 4 * 1024 * 1024 });
    // A pod nobody asked about is not invented into the result.
    expect(result.size).toBe(1);
  });
});
