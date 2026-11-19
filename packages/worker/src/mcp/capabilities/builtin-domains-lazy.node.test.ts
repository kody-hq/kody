import { expect, test, vi } from 'vitest'
import { builtinDomainModuleLoaders } from './builtin-domains.ts'

const domainModulePaths = {
	access: './access/domain.ts',
	account: './account/domain.ts',
	admin: './admin/domain.ts',
	apps: './apps/domain.ts',
	community: './community/domain.ts',
	coding: './coding/domain.ts',
	email: './email/domain.ts',
	executionContexts: './execution-contexts/domain.ts',
	files: './files/domain.ts',
	follow: './follow/domain.ts',
	integrations: './integrations/domain.ts',
	jobs: './jobs/domain.ts',
	mcpServers: './mcp-servers/domain.ts',
	meta: './meta/domain.ts',
	profiles: './profiles/domain.ts',
	orgs: './orgs/domain.ts',
	packages: './packages/domain.ts',
	repo: './repo/domain.ts',
	runs: './runs/domain.ts',
	secrets: './secrets/domain.ts',
	storage: './storage/domain.ts',
	webhooks: './webhooks/domain.ts',
} as const

test('every builtin domain module is covered by this test', () => {
	expect(Object.keys(domainModulePaths).sort()).toEqual(
		Object.keys(builtinDomainModuleLoaders).sort(),
	)
})

test('listing, filtering, and search specs load no domain module; dispatch loads only the called domain', async () => {
	const dispatchedDomain = 'storage'
	const evaluatedDomains: Array<string> = []
	vi.resetModules()
	for (const [name, modulePath] of Object.entries(domainModulePaths)) {
		if (name === dispatchedDomain) continue
		vi.doMock(modulePath, () => {
			evaluatedDomains.push(name)
			throw new Error(`domain module "${name}" must not load`)
		})
	}
	const storageModule = await import('./storage/domain.ts')
	const { getStaticRegistry } = await import('./registry.ts')
	const registry = await getStaticRegistry()
	expect(Object.keys(registry.capabilitySpecs).length).toBeGreaterThan(300)
	expect(
		Object.keys(registry.capabilityToolDescriptors).length,
	).toBeGreaterThan(300)
	expect(evaluatedDomains).toEqual([])

	const realCapability = storageModule.storageDomain.capabilities[0]!
	const result = { ok: true }
	vi.spyOn(realCapability, 'handler').mockResolvedValue(result)
	await expect(
		registry.capabilityMap[realCapability.name]!.handler({}, {} as never),
	).resolves.toBe(result)
	expect(evaluatedDomains).toEqual([])
	for (const name of Object.keys(domainModulePaths))
		vi.doUnmock(domainModulePaths[name as keyof typeof domainModulePaths])
})
