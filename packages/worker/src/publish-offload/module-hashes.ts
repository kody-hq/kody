import type {
	WorkerLoaderModule,
	WorkerLoaderModules,
} from '#worker/worker-loader-types.ts'

/**
 * Hashing shared by the offloaded builder (CLI, execution context) and the
 * server, so a bundle built anywhere compares byte for byte. Pure Web Crypto:
 * this file also runs inside the builder outside the Worker.
 */

const encoder = new TextEncoder()

export async function sha256Hex(bytes: Uint8Array | ArrayBuffer | string) {
	const data = typeof bytes === 'string' ? encoder.encode(bytes) : bytes
	const digest = await crypto.subtle.digest('SHA-256', data as BufferSource)
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('')
}

/** The one representation a module is hashed and size-capped as. */
export function workerLoaderModuleBytes(module: WorkerLoaderModule) {
	if (typeof module === 'string') return encoder.encode(`js\0${module}`)
	if (typeof module.js === 'string') return encoder.encode(`js\0${module.js}`)
	if (typeof module.cjs === 'string')
		return encoder.encode(`cjs\0${module.cjs}`)
	if (typeof module.text === 'string') {
		return encoder.encode(`text\0${module.text}`)
	}
	if (module.json !== undefined) {
		return encoder.encode(`json\0${JSON.stringify(module.json)}`)
	}
	if (module.data instanceof ArrayBuffer) {
		const prefix = encoder.encode('data\0')
		const out = new Uint8Array(prefix.byteLength + module.data.byteLength)
		out.set(prefix, 0)
		out.set(new Uint8Array(module.data), prefix.byteLength)
		return out
	}
	throw new Error('Unsupported worker loader module shape.')
}

export async function hashWorkerLoaderModules(modules: WorkerLoaderModules) {
	const entries = await Promise.all(
		Object.keys(modules)
			.sort()
			.map(
				async (path) =>
					[
						path,
						await sha256Hex(workerLoaderModuleBytes(modules[path]!)),
					] as const,
			),
	)
	return Object.fromEntries(entries) as Record<string, string>
}

export function workerLoaderModulesByteSize(modules: WorkerLoaderModules) {
	let total = 0
	for (const module of Object.values(modules)) {
		total += workerLoaderModuleBytes(module).byteLength
	}
	return total
}
