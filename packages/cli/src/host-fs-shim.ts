import * as nodeFs from 'node:fs'
import { runSecretHeader } from './local-runtime-source.js'

/**
 * workerd has no host filesystem, so execution-context runs reach granted host
 * folders through these `node:fs` / `node:fs/promises` replacements. Paths in
 * a mount (or anywhere outside workerd's own /bundle, /tmp, /dev) go to the
 * kody bridge, which enforces the effective mounts on the Node side; every
 * other call goes to workerd's built-in virtual fs unchanged.
 */
export const hostFsShimModules = [
	{ name: 'node:fs', file: 'host-fs.js' },
	{ name: 'node:fs/promises', file: 'host-fs-promises.js' },
] as const

const identifier = /^[A-Za-z_$][\w$]*$/

function exportNames(value: object) {
	return Object.keys(value)
		.filter((name) => identifier.test(name) && name !== 'default')
		.sort()
}

export function createHostFsPromisesSource(input: {
	routeRoots: ReadonlyArray<string>
}) {
	const names = exportNames(nodeFs.promises)
	return `import { env } from 'cloudflare:workers';
import { Buffer } from 'node:buffer';
import { posix } from 'node:path';

const real = process.getBuiltinModule('node:fs').promises;
const routeRoots = ${JSON.stringify(input.routeRoots)};
const virtualRoots = ['/bundle', '/tmp', '/dev'];
const within = (path, root) => path === root || path.startsWith(root.endsWith('/') ? root : root + '/');

export function __kodyHostPath(path) {
	if (path instanceof URL) {
		if (path.protocol !== 'file:') return null;
		path = decodeURIComponent(path.pathname);
	}
	if (typeof path !== 'string' || !path.startsWith('/')) return null;
	const normalized = posix.normalize(path);
	if (routeRoots.some((root) => within(normalized, root))) return normalized;
	if (virtualRoots.some((root) => within(normalized, root))) return null;
	return normalized;
}

export function __kodyHostFsError(code, message, syscall, path) {
	const error = new Error(message);
	error.code = code;
	error.syscall = syscall;
	if (path !== undefined) error.path = path;
	return error;
}

async function call(op, body) {
	const response = await env.KODY_BRIDGE.fetch('http://kody-bridge/fs', {
		method: 'POST',
		headers: { 'content-type': 'application/json', ${JSON.stringify(runSecretHeader)}: env.KODY_RUN_SECRET },
		body: JSON.stringify({ op, ...body }),
	});
	const data = await response.json();
	if (data.error) throw __kodyHostFsError(data.error.code, data.error.message, op, body.path);
	return data.result;
}

const encodingOf = (options) => (typeof options === 'string' ? options : (options?.encoding ?? null));

function toBase64(data, options) {
	if (typeof data === 'string') return Buffer.from(data, encodingOf(options) ?? 'utf8').toString('base64');
	if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64');
	throw new TypeError('Host folder writes take a string, Buffer, or TypedArray.');
}

function kindChecks(kind) {
	return {
		isFile: () => kind === 'file',
		isDirectory: () => kind === 'directory',
		isSymbolicLink: () => kind === 'symlink',
		isFIFO: () => false,
		isSocket: () => false,
		isBlockDevice: () => false,
		isCharacterDevice: () => false,
	};
}

function toStats(view) {
	return {
		...kindChecks(view.kind),
		size: view.size,
		mode: view.mode,
		mtimeMs: view.mtimeMs,
		atimeMs: view.atimeMs,
		ctimeMs: view.ctimeMs,
		birthtimeMs: view.birthtimeMs,
		mtime: new Date(view.mtimeMs),
		atime: new Date(view.atimeMs),
		ctime: new Date(view.ctimeMs),
		birthtime: new Date(view.birthtimeMs),
	};
}

const hosted = {
	async readFile(path, options) {
		const bytes = Buffer.from(await call('readFile', { path }), 'base64');
		const encoding = encodingOf(options);
		return encoding ? bytes.toString(encoding) : bytes;
	},
	async writeFile(path, data, options) {
		await call('writeFile', { path, data: toBase64(data, options) });
	},
	async appendFile(path, data, options) {
		await call('appendFile', { path, data: toBase64(data, options) });
	},
	async readdir(path, options) {
		const entries = await call('readdir', { path });
		return options?.withFileTypes
			? entries.map((entry) => ({ name: entry.name, parentPath: path, path, ...kindChecks(entry.kind) }))
			: entries.map((entry) => entry.name);
	},
	async stat(path) {
		return toStats(await call('stat', { path }));
	},
	async lstat(path) {
		return toStats(await call('lstat', { path }));
	},
	async mkdir(path, options) {
		await call('mkdir', { path, recursive: typeof options === 'object' && options?.recursive === true });
	},
	async rm(path, options) {
		await call('rm', { path, recursive: options?.recursive === true, force: options?.force === true });
	},
	async unlink(path) {
		await call('unlink', { path });
	},
	async rmdir(path) {
		await call('rmdir', { path });
	},
	async rename(path, dest) {
		await call('rename', { path, dest });
	},
	async copyFile(path, dest) {
		await call('copyFile', { path, dest });
	},
	async access(path, mode) {
		await call('access', { path, ...(typeof mode === 'number' ? { mode } : {}) });
	},
	async realpath(path) {
		return await call('realpath', { path });
	},
};
const twoPath = new Set(['rename', 'copyFile']);

function wrapHosted(name) {
	return function (...args) {
		const first = __kodyHostPath(args[0]);
		const second = twoPath.has(name) ? __kodyHostPath(args[1]) : null;
		if (first === null && second === null) return real[name](...args);
		if (twoPath.has(name) && (first === null || second === null)) {
			return Promise.reject(__kodyHostFsError('ENOTSUP', 'fs.' + name + ' cannot move files between a host folder and the run\\'s virtual filesystem.', name, args[0]));
		}
		args[0] = first;
		if (second !== null) args[1] = second;
		return hosted[name](...args);
	};
}

function guardUnsupported(name) {
	const fn = real[name];
	return function (...args) {
		if (__kodyHostPath(args[0]) !== null) {
			return Promise.reject(__kodyHostFsError('ENOTSUP', 'fs.promises.' + name + ' is not supported on execution context host folders. Supported: ' + Object.keys(hosted).join(', ') + '.', name, args[0]));
		}
		return fn.apply(real, args);
	};
}

const promises = {};
for (const name of Object.keys(real)) {
	const value = real[name];
	promises[name] = name in hosted ? wrapHosted(name) : typeof value === 'function' ? guardUnsupported(name) : value;
}
for (const name of Object.keys(hosted)) promises[name] ??= wrapHosted(name);

export default promises;
${names.map((name) => `export const ${name} = promises[${JSON.stringify(name)}];`).join('\n')}
`
}

export function createHostFsSource() {
	const names = exportNames(nodeFs)
	return `import __kodyPromises, { __kodyHostPath, __kodyHostFsError } from 'node:fs/promises';

const real = process.getBuiltinModule('node:fs');
const hosted = new Set(['readFile', 'writeFile', 'appendFile', 'readdir', 'stat', 'lstat', 'mkdir', 'rm', 'unlink', 'rmdir', 'rename', 'copyFile', 'access', 'realpath']);
const twoPath = new Set(['rename', 'copyFile']);

const routed = (name, args) =>
	__kodyHostPath(args[0]) !== null || (twoPath.has(name) && __kodyHostPath(args[1]) !== null);

function wrapCallback(name) {
	const fn = real[name];
	return function (...args) {
		const callback = args[args.length - 1];
		if (typeof callback !== 'function' || !routed(name, args)) return fn.apply(real, args);
		args.pop();
		__kodyPromises[name](...args).then((value) => callback(null, value), (error) => callback(error));
	};
}

function guard(name) {
	const fn = real[name];
	const hint = name.endsWith('Sync') && hosted.has(name.slice(0, -4))
		? ' Synchronous fs calls cannot reach host folders; use await fs.promises.' + name.slice(0, -4) + '(...) instead.'
		: ' Use fs.promises ' + [...hosted].join(', ') + '.';
	return function (...args) {
		if (routed(name, args)) {
			throw __kodyHostFsError('ENOTSUP', 'fs.' + name + ' is not supported on execution context host folders.' + hint, name, args[0]);
		}
		return fn.apply(real, args);
	};
}

const fs = {};
for (const name of Object.keys(real)) {
	const value = real[name];
	fs[name] = name === 'promises' ? __kodyPromises : typeof value !== 'function' || /^[A-Z]/.test(name) ? value : hosted.has(name) ? wrapCallback(name) : guard(name);
}

export default fs;
${names.map((name) => `export const ${name} = fs[${JSON.stringify(name)}];`).join('\n')}
`
}
