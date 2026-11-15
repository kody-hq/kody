import { createHash, type Hash } from 'node:crypto'
import { bytesToBase64Url } from '@kody-internal/shared/base64.ts'
import type { StorageContext } from '#mcp/storage.ts'
import type { WorkerLoaderModules } from '#worker/worker-loader-types.ts'

export const dynamicWorkerIdPrefix = 'kody-'

/**
 * Sandbox-contract / cache-key version. Bump only when the executor harness
 * or LOADER identity contract changes — not on every parent commit.
 */
export const dynamicWorkerCacheKeyVersion = 7

export type DynamicWorkerIdOptions = {
	compatibilityDate: string
	compatibilityFlags: Array<string>
	mainModule: string
	modules: WorkerLoaderModules
}

/**
 * Stable LOADER id for a Dynamic Worker isolate.
 *
 * Identity is the module graph (agent code plus generated harness), compat
 * knobs, an explicit contract version, and the acting-user facets bound on
 * `globalOutbound` (`userId`, `storageContext`). `LOADER.get` reuses the
 * first factory's WorkerCode for a given id, including that gateway stub, so
 * those facets stay in the key. Deploy SHA, email, execute `params`,
 * `packageContext`, live MCP connect/tool metadata, and other request-only
 * fields do not — those arrive on `evaluate` RPC.
 *
 * Unique worker days are the billed and capped unit, so the same inputs must
 * always mint the same id. A module value that cannot be hashed (a function,
 * symbol, or compiled `WebAssembly.Module`) throws instead of minting a
 * one-off id that would bill and count as a new worker on every call.
 */
export async function createStableDynamicWorkerId(input: {
	userId: string | null
	storageContext: StorageContext | null
	workerOptions: DynamicWorkerIdOptions
	cacheKeyVersion?: number
}) {
	const hash = sha256CanonicalJsonBase64Url({
		version: input.cacheKeyVersion ?? dynamicWorkerCacheKeyVersion,
		binding: 'LOADER',
		userId: input.userId,
		storageContext: input.storageContext,
		compatibilityDate: input.workerOptions.compatibilityDate,
		compatibilityFlags: input.workerOptions.compatibilityFlags,
		mainModule: input.workerOptions.mainModule,
		modules: input.workerOptions.modules,
	})
	return `${dynamicWorkerIdPrefix}${hash.slice(0, 43)}`
}

/**
 * Billing / cap version for {@link createDynamicWorkerBillingId}. Bump only
 * when the billing identity contract itself changes.
 */
export const dynamicWorkerBillingKeyVersion = 1

/**
 * Key for unique-worker-day billing and caps (`claimDynamicWorkerDay`).
 *
 * Built only from what the user controls: their code, their own modules
 * (saved and published package sources, so the published commit), and the
 * acting user plus storage context. Kody-owned inputs are left out on
 * purpose: the executor harness, the `kody:runtime` modules, compatibility
 * date/flags, and `dynamicWorkerCacheKeyVersion`. A Kody deploy that changes
 * those still loads a fresh isolate under a new LOADER id
 * ({@link createStableDynamicWorkerId}), but it does not start a new billable
 * worker for unchanged user code on the same UTC day.
 */
export async function createDynamicWorkerBillingId(input: {
	userId: string | null
	storageContext: StorageContext | null
	code: string
	userModules: WorkerLoaderModules
}) {
	const hash = sha256CanonicalJsonBase64Url({
		version: dynamicWorkerBillingKeyVersion,
		binding: 'LOADER:billing',
		userId: input.userId,
		storageContext: input.storageContext,
		code: input.code,
		modules: input.userModules,
	})
	return `${dynamicWorkerIdPrefix}${hash.slice(0, 43)}`
}

/**
 * SHA-256 of `JSON.stringify` of the canonical form, fed to the hash a piece
 * at a time. Execute mints these ids in the shared API isolate, and building
 * the whole JSON string and its UTF-8 bytes cost about three copies of the
 * module graph per id, enough to reset that isolate on a multi-megabyte
 * import.
 */
function sha256CanonicalJsonBase64Url(value: unknown) {
	const hash = createHash('sha256')
	writeJson(hash, canonicalizeForHash(value, '$'))
	return bytesToBase64Url(new Uint8Array(hash.digest()))
}

const jsonStringChunkChars = 64 * 1024

/** Writes exactly the bytes `JSON.stringify` would for a canonical value. */
function writeJson(hash: Hash, value: unknown) {
	if (typeof value === 'string') {
		writeJsonString(hash, value)
		return
	}
	if (Array.isArray(value)) {
		hash.update('[')
		value.forEach((entry, index) => {
			if (index > 0) hash.update(',')
			writeJson(hash, entry)
		})
		hash.update(']')
		return
	}
	if (value !== null && typeof value === 'object') {
		const record = value as Record<string, unknown>
		hash.update('{')
		Object.keys(record).forEach((key, index) => {
			if (index > 0) hash.update(',')
			writeJsonString(hash, key)
			hash.update(':')
			writeJson(hash, record[key])
		})
		hash.update('}')
		return
	}
	hash.update(JSON.stringify(value))
}

function writeJsonString(hash: Hash, value: string) {
	if (value.length <= jsonStringChunkChars) {
		hash.update(JSON.stringify(value))
		return
	}
	hash.update('"')
	let start = 0
	while (start < value.length) {
		let end = Math.min(start + jsonStringChunkChars, value.length)
		// A pair split across chunks would be escaped as two lone surrogates.
		if (end < value.length && isHighSurrogate(value.charCodeAt(end - 1))) {
			end -= 1
		}
		hash.update(JSON.stringify(value.slice(start, end)).slice(1, -1))
		start = end
	}
	hash.update('"')
}

function isHighSurrogate(charCode: number) {
	return charCode >= 0xd800 && charCode <= 0xdbff
}

const hashTagKey = '__kodyType'

/**
 * JSON-shaped canonical form; bytes, `undefined`, and bigint become
 * `{ __kodyType, value }` records. A plain object that carries its own
 * `__kodyType` key is escaped as `{ __kodyType: 'object', value }` so module
 * JSON can never spell another value's tag. Every other value keeps the
 * encoding ids have always used, so live ids do not change. Only plain
 * objects are walked: anything else (a compiled `WebAssembly.Module`, Map,
 * class instance) exposes no hashable contents and would collide with every
 * other value of its kind.
 */
function canonicalizeForHash(value: unknown, path: string): unknown {
	if (value === undefined) return { [hashTagKey]: 'undefined' }
	if (value === null) return null
	if (typeof value === 'bigint') {
		return { [hashTagKey]: 'bigint', value: String(value) }
	}
	if (typeof value === 'function' || typeof value === 'symbol') {
		throw unhashableModuleValue(path, `a ${typeof value}`)
	}
	if (typeof value !== 'object') return value
	if (value instanceof ArrayBuffer) {
		return {
			[hashTagKey]: 'arrayBuffer',
			value: bytesToBase64Url(new Uint8Array(value)),
		}
	}
	if (ArrayBuffer.isView(value)) {
		return {
			[hashTagKey]: 'arrayBuffer',
			value: bytesToBase64Url(
				new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
			),
		}
	}
	if (Array.isArray(value)) {
		return value.map((entry, index) =>
			canonicalizeForHash(entry, `${path}[${index}]`),
		)
	}
	const prototype: unknown = Object.getPrototypeOf(value)
	if (prototype !== Object.prototype && prototype !== null) {
		throw unhashableModuleValue(
			path,
			`a ${value.constructor?.name ?? 'non-plain'} object`,
		)
	}
	const record = value as Record<string, unknown>
	const entries = Object.fromEntries(
		Object.keys(record)
			.sort((left, right) => left.localeCompare(right))
			.map((key) => [key, canonicalizeForHash(record[key], `${path}.${key}`)]),
	)
	return Object.hasOwn(record, hashTagKey)
		? { [hashTagKey]: 'object', value: entries }
		: entries
}

function unhashableModuleValue(path: string, kind: string) {
	return new TypeError(
		`Dynamic Worker id input ${path} is ${kind}; worker modules must be strings, byte buffers, or JSON values.`,
	)
}
