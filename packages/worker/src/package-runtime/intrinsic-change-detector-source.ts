/**
 * Sandbox source that snapshots the shared globals and prototype methods a
 * package's request can depend on, and names the ones that changed since.
 * Every module in a run shares these, so a change made by one package can
 * steer a request another package makes. The names ride along with a
 * package-bound fetch so the host can record them (see
 * `scheduleChangedIntrinsicsUse`). Emit it after the wrapper installs its own
 * `globalThis.fetch` and before any package module is imported.
 */
const watchedGlobals = [
	'fetch',
	'URL',
	'URLSearchParams',
	'Request',
	'Headers',
	'Response',
	'Promise',
	'JSON',
	'Reflect',
]

const watchedMethods: Record<string, Array<string>> = {
	JSON: ['stringify', 'parse'],
	Reflect: ['apply', 'get', 'construct'],
	Promise: ['resolve', 'all'],
	'Promise.prototype': ['then', 'catch'],
	'String.prototype': [
		'trim',
		'startsWith',
		'toLowerCase',
		'replace',
		'split',
		'concat',
	],
	'Array.prototype': ['push', 'map', 'join', 'concat', 'forEach'],
	'Object.prototype': ['toString', 'hasOwnProperty', 'valueOf'],
	'Headers.prototype': ['get', 'set', 'append'],
	'URL.prototype': ['toString'],
	Object: ['assign', 'keys', 'entries', 'fromEntries', 'defineProperty'],
}

export const maxChangedIntrinsicNames = 32

export function createIntrinsicChangeDetectorSource() {
	return `
const __kodyIntrinsicSnapshot = (() => {
	const entries = [];
	const add = (name, holder, key) => {
		let value;
		try { value = holder[key]; } catch { return; }
		entries[entries.length] = { name, holder, key, value };
	};
	const globals = ${JSON.stringify(watchedGlobals)};
	for (let index = 0; index < globals.length; index += 1) {
		add(globals[index], globalThis, globals[index]);
	}
	const methods = ${JSON.stringify(watchedMethods)};
	const holders = {
		JSON,
		Reflect,
		Promise,
		Object,
		'Promise.prototype': Promise.prototype,
		'String.prototype': String.prototype,
		'Array.prototype': Array.prototype,
		'Object.prototype': Object.prototype,
		'Headers.prototype': Headers.prototype,
		'URL.prototype': URL.prototype,
	};
	for (const holderName in methods) {
		const names = methods[holderName];
		for (let index = 0; index < names.length; index += 1) {
			add(holderName + '.' + names[index], holders[holderName], names[index]);
		}
	}
	return entries;
})();
function __kodyChangedIntrinsics() {
	const changed = [];
	try {
		for (let index = 0; index < __kodyIntrinsicSnapshot.length; index += 1) {
			const entry = __kodyIntrinsicSnapshot[index];
			let current;
			try { current = entry.holder[entry.key]; } catch { current = undefined; }
			if (current !== entry.value) changed[changed.length] = entry.name;
		}
		for (const added in {}) {
			changed[changed.length] = 'Object.prototype (added key)';
			break;
		}
	} catch {}
	return changed;
}
`
}

/** Host side: keep only short strings, capped. */
export function normalizeChangedIntrinsicNames(value: unknown): Array<string> {
	if (!Array.isArray(value)) return []
	const names: Array<string> = []
	for (const entry of value) {
		if (typeof entry !== 'string' || entry.length === 0 || entry.length > 64) {
			continue
		}
		if (!names.includes(entry)) names.push(entry)
		if (names.length >= maxChangedIntrinsicNames) break
	}
	return names.sort()
}
