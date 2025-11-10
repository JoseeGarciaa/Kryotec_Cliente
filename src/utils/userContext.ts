import { AsyncLocalStorage } from 'async_hooks';

const userStorage = new AsyncLocalStorage<number | null>();

export function runWithUserContext<T>(userId: number | null, fn: () => T): T {
	const value = typeof userId === 'number' && Number.isFinite(userId) ? userId : null;
	return userStorage.run(value, fn);
}

export function getCurrentUserContext(): number | null {
	const value = userStorage.getStore();
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
