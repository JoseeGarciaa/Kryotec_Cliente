import { AsyncLocalStorage } from 'async_hooks';

const sedeStorage = new AsyncLocalStorage<number | null>();

export function runWithSedeContext<T>(sedeId: number | null, fn: () => T): T {
  const value = typeof sedeId === 'number' && Number.isFinite(sedeId) ? sedeId : null;
  return sedeStorage.run(value, fn);
}

export function getCurrentSedeContext(): number | null {
  const value = sedeStorage.getStore();
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
