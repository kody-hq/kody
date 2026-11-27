import { expect, test } from 'vitest'
import { getStaticRegistry } from '#mcp/capabilities/registry.ts'
import { apiOperations } from '#worker/open-api/operations.ts'
import { buildPackageTestHints } from '#worker/package-registry/package-test-hints.ts'

const oldName = /package[-_ ]?app[-_ ]?fetch|packages\/app-fetch/i

test('appFetch and appList are the only names for calling apps', async () => {
	const registry = await getStaticRegistry()
	const capabilityNames = Object.keys(registry.capabilitySpecs)
	expect(capabilityNames).toContain('appFetch')
	expect(capabilityNames).toContain('appList')
	expect(capabilityNames.filter((name) => oldName.test(name))).toEqual([])

	const routes = apiOperations.map((operation) => ({
		id: operation.operationId,
		method: operation.method,
		path: operation.path,
	}))
	expect(routes).toContainEqual({
		id: 'appFetch',
		method: 'POST',
		path: '/v1/apps/fetch',
	})
	expect(routes).toContainEqual({
		id: 'appList',
		method: 'GET',
		path: '/v1/apps',
	})
	expect(
		routes.filter((route) => oldName.test(`${route.id} ${route.path}`)),
	).toEqual([])

	const hints = buildPackageTestHints({
		packageId: 'pkg-1',
		kodyId: 'board',
		hasApp: true,
		subscriptionTopics: [],
	})
	const hintText = JSON.stringify(hints)
	expect(hintText).toContain('appFetch({')
	expect(hintText).not.toMatch(oldName)
})
