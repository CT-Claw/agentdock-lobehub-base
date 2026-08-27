import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { app } from 'electron';

import { ControllerModule, IpcMethod } from './index';

type RuntimeId = 'openclaw' | 'hermes' | 'deepseek-harness';
type RuntimeStatus = 'missing' | 'ready' | 'running' | 'error';

interface RuntimeSpec {
  archive: string;
  cwd: string;
  executable: string;
  args: string[];
  env?: Record<string, string>;
}

const specs: Record<RuntimeId, RuntimeSpec> = {
  openclaw: {
    archive: 'openclaw.runtime.tar',
    cwd: 'openclaw',
    executable: 'app/runtime/node-win-x64/node.exe',
    args: ['app/core/node_modules/openclaw/openclaw.mjs', 'gateway', 'run', '--allow-unconfigured', '--force', '--port', '18789'],
  },
  hermes: {
    archive: 'hermes.runtime.tar',
    cwd: 'hermes',
    executable: 'python_embedded/python.exe',
    args: ['-m', 'hermes_cli.main'],
    env: { HERMES_HOME: 'hermes' },
  },
  'deepseek-harness': {
    archive: 'deepseek-harness.runtime.tar',
    cwd: 'deepseek-harness',
    executable: 'runtime/node.exe',
    args: ['app/node_modules/@deepseek-ai/dsh/lib/bin.js', 'web'],
  },
};

const ids = Object.keys(specs) as RuntimeId[];
const children = new Map<RuntimeId, ChildProcess>();

function rootOnUsb() {
  return process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
}

function hostCacheRoot() {
  return path.join(app.getPath('temp'), 'AgentDock', 'runtimes');
}

function isRuntimeId(value: unknown): value is RuntimeId {
  return typeof value === 'string' && ids.includes(value as RuntimeId);
}

async function exists(file: string) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** Thin bridge to the upstream runtime payloads; no runtime code is reimplemented here. */
export default class AgentDockRuntimeController extends ControllerModule {
  static override readonly groupName = 'agentdockRuntime';

  @IpcMethod()
  async list(): Promise<Record<RuntimeId, RuntimeStatus>> {
    const result = {} as Record<RuntimeId, RuntimeStatus>;
    for (const id of ids) {
      const spec = specs[id];
      const root = path.join(hostCacheRoot(), id);
      result[id] = children.has(id)
        ? 'running'
        : (await exists(path.join(root, spec.executable)))
          ? 'ready'
          : 'missing';
    }
    return result;
  }

  @IpcMethod()
  async prepare(id: RuntimeId): Promise<void> {
    if (!isRuntimeId(id)) throw new Error(`Unknown runtime: ${String(id)}`);
    const spec = specs[id];
    const destination = path.join(hostCacheRoot(), id);
    if (await exists(path.join(destination, spec.executable))) return;
    const archive = path.join(rootOnUsb(), spec.archive);
    if (!(await exists(archive))) throw new Error(`Runtime payload not found: ${archive}`);
    await mkdir(destination, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      const tar = spawn('tar', ['-xf', archive, '-C', destination], { windowsHide: true });
      tar.once('error', reject);
      tar.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`tar exited with ${code}`)));
    });
  }

  @IpcMethod()
  async start(id: RuntimeId): Promise<{ pid: number }> {
    if (!isRuntimeId(id)) throw new Error(`Unknown runtime: ${String(id)}`);
    await this.prepare(id);
    const spec = specs[id];
    const root = path.join(hostCacheRoot(), id);
    const env = { ...process.env, ...spec.env, AGENTDOCK_RUNTIME: id };
    if (spec.env?.HERMES_HOME) env.HERMES_HOME = path.join(root, spec.env.HERMES_HOME);
    const child = spawn(path.join(root, spec.executable), spec.args, {
      cwd: path.join(root, spec.cwd),
      env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.set(id, child);
    child.once('exit', () => children.delete(id));
    return new Promise((resolve, reject) => {
      child.once('spawn', () => resolve({ pid: child.pid! }));
      child.once('error', reject);
    });
  }

  @IpcMethod()
  stop(id: RuntimeId): boolean {
    const child = children.get(id);
    if (!child || child.killed) return false;
    child.kill();
    return true;
  }
}
