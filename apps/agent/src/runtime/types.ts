import type { DockerInspectResult, DockerClient } from '../index.js';
/** One durable volume the workload mounts. Docker bind-mounts its source; Kubernetes
 *  resolves the entry to a subPath of the endpoint's claim, so provider code never has
 *  to know which backend it runs on. */
export interface RuntimeVolume {
  name: 'qq' | 'config' | 'data';
  target: string;
}
export interface RuntimeSpec {
  name: string;
  image: string;
  labels: Record<string,string>;
  environment: Record<string,string>;
  volumes: RuntimeVolume[];
  resources: { cpuMillis: number; memoryMiB: number };
  /** Container ports the provider reaches over HTTP (management/WebUI/OneBot/vnc).
   *  Docker publishes them on the host; Kubernetes exposes them on the Service so the
   *  pod's address resolves them without host port allocation. */
  ports?: { name: string; port: number }[];
  /** Privilege extras required by providers that need them (e.g. SnowLuma's
   *  SYS_PTRACE + seccomp unconfined + 1Gi shm). NapCat and LLBot pass none. */
  capAdd?: string[];
  securityOpt?: string[];
  shmBytes?: number;
}
/** Infrastructure boundary; protocol HTTP and OneBot remain in the provider. */
export interface RuntimeDriver {
  readonly backend: 'docker' | 'kubernetes';
  inspect(name: string): Promise<DockerInspectResult | null>;
  ensure(spec: RuntimeSpec): Promise<void>;
  start(name: string): Promise<void>;
  stop(name: string): Promise<void>;
  restart(name: string, operationId: string): Promise<void>;
  forceRestart(name: string, operationId: string): Promise<void>;
  delete(name: string): Promise<void>;
  logs: DockerClient['logs'];
  stats?: DockerClient['stats'];
  /** Run a command inside the workload's protocol container. Optional: a backend that
   *  cannot exec must omit it so providers fail with an explicit error instead of
   *  silently skipping a required step. */
  exec?(name: string, args: string[]): Promise<{ stdout: string; stderr: string }>;
}
