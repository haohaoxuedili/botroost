import { chmod, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';

/** Raised when a file the provider expects is absent; callers treat this as "not created yet". */
export class StorageFileMissing extends Error {
  constructor(readonly path: string) {
    super(`${path} does not exist`);
    this.name = 'StorageFileMissing';
  }
}

/** File operations scoped to one endpoint's workload. Paths are the paths the protocol
 *  container sees, so provider code is identical on both backends. */
export interface EndpointStorage {
  readdir(directory: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  /** Create the directory (recursively) with mode 0o777 so the image's unprivileged
   *  runtime user can write it; a no-op if it already exists. */
  ensureDirectory(directory: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface RuntimeStorage {
  readonly kind: 'local' | 'pod';
  for(workload: string): EndpointStorage;
}

/** Docker backend: the agent shares the host filesystem with its containers. */
export class LocalRuntimeStorage implements RuntimeStorage {
  readonly kind = 'local' as const;
  /** The host filesystem is shared with the containers, so every workload sees the same
   *  absolute paths; the scope is a no-op. */
  for(): EndpointStorage { return local; }
}

const local: EndpointStorage = {
  async readdir(directory) {
    try { return await readdir(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  },
  async readFile(path) {
    try { return await readFile(path, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new StorageFileMissing(path);
      throw error;
    }
  },
  async writeFile(path, content) { await writeFile(path, content, 'utf8'); },
  async ensureDirectory(directory) {
    await mkdir(directory, { recursive: true, mode: 0o777 });
    await chmod(directory, 0o777).catch(() => {});
  },
  async remove(path) { await rm(path, { recursive: true, force: true }); },
};

/** Anything that can run a command inside a workload's protocol container. */
export interface ContainerExec {
  exec(name: string, args: string[], stdin?: string): Promise<{ stdout: string; stderr: string }>;
}

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** Distinguishes "the path is not there" from "the exec itself failed". */
const isMissing = (error: unknown) => /no such file or directory|not found|cannot access|cannot open/i.test(String((error as Error)?.message ?? error));

/** Kubernetes backend: endpoint data lives on a PVC inside the endpoint pod, which the
 *  agent pod cannot mount (PVCs are namespace-scoped). Reach it through pods/exec. */
export class PodRuntimeStorage implements RuntimeStorage {
  readonly kind = 'pod' as const;
  constructor(private readonly runtime: ContainerExec) {}
  for(workload: string): EndpointStorage {
    const run = async (script: string, stdin?: string) => (await this.runtime.exec(workload, ['/bin/sh', '-c', script], stdin)).stdout;
    return {
      async readdir(directory) {
        try { return (await run(`ls -1A ${quote(directory)}`)).split('\n').map(line => line.trim()).filter(Boolean); }
        catch (error) {
          // Only an absent directory is an empty listing. A broken exec (pod restarting, API
          // server unreachable) must surface, or providers report "not configured" instead of
          // the storage failure that actually happened.
          if (isMissing(error)) return [];
          throw error;
        }
      },
      async readFile(path) {
        try { return await run(`cat ${quote(path)}`); }
        catch (error) {
          // `cat` reports ENOENT on stderr; exec surfaces it as a rejected command.
          if (isMissing(error)) throw new StorageFileMissing(path);
          throw error;
        }
      },
      async writeFile(path, content) {
        // base64 keeps arbitrary JSON/CRLF intact and avoids shell quoting of the payload.
        // The payload travels over exec's stdin so OneBot access tokens never appear in the
        // exec request parameters, the audit log, or the container's process list.
        await run(`base64 -d > ${quote(path)}`, Buffer.from(content, 'utf8').toString('base64'));
      },
      async ensureDirectory(directory) {
        await run(`mkdir -p ${quote(directory)} && chmod 777 ${quote(directory)}`);
      },
      async remove(path) { await run(`rm -rf ${quote(path)}`); },
    };
  }
}
