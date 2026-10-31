import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import {
	createDynamicWorkerBillingId,
	createStableDynamicWorkerId,
	dynamicWorkerCacheKeyVersion,
} from '#mcp/dynamic-worker-id.ts'
import { type StorageContext } from '#mcp/storage.ts'
import { createDynamicWorkerCompatibilityOptions } from '#worker/dynamic-worker-compatibility.ts'

const modules = {
	'executor.js': 'export default class Executor { evaluate() { return 1 } }',
}
const storageContext = {
	sessionId: 'session-1',
	appId: 'app-1',
	storageId: 'storage-1',
}

async function mintId(
	input: {
		userId?: string | null
		storageContext?: StorageContext | null
		modules?: Record<string, unknown>
		cacheKeyVersion?: number
	} = {},
) {
	return await createStableDynamicWorkerId({
		userId: input.userId === undefined ? 'user-1' : input.userId,
		storageContext:
			input.storageContext === undefined
				? storageContext
				: input.storageContext,
		workerOptions: {
			...createDynamicWorkerCompatibilityOptions(),
			mainModule: 'executor.js',
			modules: (input.modules ?? modules) as Record<string, string>,
		},
		cacheKeyVersion: input.cacheKeyVersion,
	})
}

test('createStableDynamicWorkerId is stable for the same modules, user, and storage context and ignores evaluate-time params', async () => {
	const first = await mintId()
	expect(first).toMatch(/^kody-[A-Za-z0-9_-]{43}$/)
	// Same modules + user + storage mint one id. Evaluate-time params and
	// packageContext are not hash inputs; they must not appear in `modules`.
	expect(await mintId()).toBe(first)
	expect(await mintId({ userId: ownerIdFromStored('user-1') })).toBe(first)

	const variants = {
		otherUser: await mintId({ userId: ownerIdFromStored('user-2') }),
		otherStorage: await mintId({
			storageContext: { ...storageContext, sessionId: 'session-2' },
		}),
		otherCode: await mintId({
			modules: {
				'executor.js':
					'export default class Executor { evaluate() { return 2 } }',
			},
		}),
		bumped: await mintId({ cacheKeyVersion: dynamicWorkerCacheKeyVersion + 1 }),
		missingUser: await mintId({ userId: null, storageContext: null }),
	}
	expect(Object.entries(variants).filter(([, id]) => id === first)).toEqual([])
	expect(await mintId()).toBe(first)
	expect(await mintId({ userId: null, storageContext: null })).toBe(
		variants.missingUser,
	)
})

test('createStableDynamicWorkerId hashes binary and untyped module fields deterministically', async () => {
	const binaryModules = () => ({
		'executor.js': 'export default class Executor {}',
		'lib.wasm': { wasm: new Uint8Array([0, 97, 115, 109]) },
		'data.bin': { data: new Uint8Array([1, 2, 3]).buffer },
		'config.json': { json: { b: [1, 2n], a: 'x' } },
	})
	const first = await mintId({ modules: binaryModules() })
	expect(await mintId({ modules: binaryModules() })).toBe(first)
	expect(
		await mintId({
			modules: {
				...binaryModules(),
				'data.bin': { data: new Uint8Array([1, 2, 4]).buffer },
			},
		}),
	).not.toBe(first)
})

test('createStableDynamicWorkerId rejects function-valued module fields instead of minting a one-off id', async () => {
	await expect(
		mintId({
			modules: {
				'executor.js': {
					js: 'export default class Executor {}',
					onLoad: async () => 'not-hashable',
				},
			},
		}),
	).rejects.toThrow(
		'Dynamic Worker id input $.modules.executor.js.onLoad is a function',
	)
})

test('createStableDynamicWorkerId keeps JSON that spells an encoding tag distinct from the value it imitates', async () => {
	const bytes = await mintId({
		modules: { ...modules, 'data.json': { json: new Uint8Array([1]) } },
	})
	const imitation = await mintId({
		modules: {
			...modules,
			'data.json': { json: { __kodyType: 'arrayBuffer', value: 'AQ' } },
		},
	})
	const escapedImitation = await mintId({
		modules: {
			...modules,
			'data.json': {
				json: { __kodyType: 'object', value: { __kodyType: 'arrayBuffer' } },
			},
		},
	})
	expect(new Set([bytes, imitation, escapedImitation]).size).toBe(3)
})

test('createStableDynamicWorkerId keeps the ids already minted for hashable module graphs', async () => {
	const id = await createStableDynamicWorkerId({
		userId: 'user-1',
		storageContext: { sessionId: 's', appId: 'a', storageId: 'st' },
		workerOptions: {
			compatibilityDate: '2026-01-01',
			compatibilityFlags: ['nodejs_compat'],
			mainModule: 'executor.js',
			modules: {
				'executor.js': 'export default 1',
				'lib.js': { js: 'export const a = 1' },
				'config.json': { json: { b: [1, null, true], a: 'x' } },
				'data.bin': { data: new Uint8Array([1, 2, 3]).buffer },
			},
		},
	})
	// Minted by the pre-change implementation for the same inputs.
	expect(id).toBe('kody-tWMSfyhWrwFOyXYMhEBR6J4teIHwoIzK-vgsSRYPprA')
})

test('createStableDynamicWorkerId rejects compiled WebAssembly modules, which expose no bytes to hash', async () => {
	const compiled = new WebAssembly.Module(
		new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
	)
	await expect(
		mintId({ modules: { ...modules, 'lib.wasm': { wasm: compiled } } }),
	).rejects.toThrow(
		'Dynamic Worker id input $.modules.lib.wasm.wasm is a Module object',
	)
})

test('createDynamicWorkerBillingId follows only user code, user modules, user, and storage context', async () => {
	const mintBilling = (
		input: {
			userId?: string | null
			storageContext?: StorageContext | null
			code?: string
			userModules?: Record<string, string>
		} = {},
	) =>
		createDynamicWorkerBillingId({
			userId: input.userId === undefined ? 'user-1' : input.userId,
			storageContext:
				input.storageContext === undefined
					? storageContext
					: input.storageContext,
			code: input.code ?? 'async () => 1',
			userModules: input.userModules ?? { 'lib.js': 'export const a = 1' },
		})
	const first = await mintBilling()
	expect(first).toMatch(/^kody-[A-Za-z0-9_-]{43}$/)
	expect(await mintBilling()).toBe(first)
	const variants = [
		await mintBilling({ userId: 'user-2' }),
		await mintBilling({
			storageContext: { ...storageContext, storageId: 'storage-2' },
		}),
		await mintBilling({ code: 'async () => 2' }),
		await mintBilling({ userModules: { 'lib.js': 'export const a = 2' } }),
	]
	expect(variants.filter((id) => id === first)).toEqual([])
	// Never collides with the LOADER id for the same inputs.
	expect(first).not.toBe(await mintId())
})
