import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createRuntimeHelperPreludes } from './runtime-helper-manifest.ts'

test('packageSecrets prelude reads the run package id from evaluate invocation', () => {
	const first = createRuntimeHelperPreludes({
		env: {} as Env,
		callerContext: { user: { userId: ownerIdFromStored('user-1') } } as never,
		capabilityMap: {},
		packageSecretTools: {
			get: async () => '',
			has: async () => false,
			runPackageId: 'pkg-a',
		},
	}).join('\n')
	const second = createRuntimeHelperPreludes({
		env: {} as Env,
		callerContext: { user: { userId: ownerIdFromStored('user-1') } } as never,
		capabilityMap: {},
		packageSecretTools: {
			get: async () => '',
			has: async () => false,
			runPackageId: 'pkg-b',
		},
	}).join('\n')
	expect(first).toBe(second)
	expect(first).toContain('__kodyTrustedPackageId')
	expect(first).toContain('__kodyPackageSecrets(__kodyTrustedPackageId)')
	expect(first).not.toContain('__invocation.packageContext')
})

test('computed package import helper prelude forwards callDefault to the host bridge', async () => {
	const callDefault = vi.fn(async (input: unknown) => input)
	const preludes = createRuntimeHelperPreludes({
		env: {} as Env,
		callerContext: { user: { userId: ownerIdFromStored('user-1') } } as never,
		capabilityMap: {},
		computedPackageImportTools: { callDefault },
	})
	const prelude = preludes.find((entry) =>
		entry.includes('__kodyComputedPackageImport'),
	)
	expect(prelude).toBeDefined()
	const createHelper = new Function(
		'__kodyComputedPackageImportRuntimeBridge',
		`${prelude}; return __kodyComputedPackageImport;`,
	) as (bridge: { callDefault(input: unknown): Promise<unknown> }) => {
		callDefault(input: {
			specifier: string
			params?: Record<string, unknown>
		}): Promise<unknown>
	}
	const helper = createHelper({ callDefault })
	await expect(
		helper.callDefault({
			specifier: 'kody:@kentcdodds/example/probe',
			params: { marker: 'ok' },
		}),
	).resolves.toEqual({
		specifier: 'kody:@kentcdodds/example/probe',
		params: { marker: 'ok' },
	})
	expect(callDefault).toHaveBeenCalledTimes(1)
})
