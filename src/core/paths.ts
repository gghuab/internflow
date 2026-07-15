import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return resolve(path);
}

export function defaultConfigPath(): string {
  return process.env.INTERNFLOW_CONFIG || join(homedir(), '.config', 'internflow', 'config.yaml');
}

export function stateDirectory(): string {
  return process.env.INTERNFLOW_STATE_DIR || join(homedir(), '.local', 'state', 'internflow');
}

export function dataDirectory(): string {
  return process.env.INTERNFLOW_DATA_DIR || join(homedir(), '.local', 'share', 'internflow');
}

