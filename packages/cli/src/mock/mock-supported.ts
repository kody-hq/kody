/**
 * Operations the CLI mock implements. Generated-adjacent: keep this list in
 * sync with handlers in mock-server.ts. Contract tests assert every id here
 * works on mock; anything else must refuse with not_implemented_in_mock.
 *
 * Source of truth for the *prod* surface remains api.kody.codes/openapi.json
 * plus CapabilityProxy paths. When adding a mock handler, add its id here.
 */

/** Open API operationIds the mock answers. */
export const mockOpenApiOperationIds = [
	'search',
	'searchTool',
	'metaGetCurrentUser',
	'usageGet',
] as const

/** CapabilityProxy `path` joins (dot form) the mock answers under kody.*. */
export const mockCapabilityPaths = [
	'kody.metaGetCurrentUser',
	'kody.search',
	'kody.execute',
	'kody.usageGet',
	// Local package scratch storage via capability hops used by packageStorage()
	// bridging in the mock runtime (see mock-server call dispatch).
	'kody.__mockPackageStorageGet',
	'kody.__mockPackageStorageSet',
	'kody.__mockPackageStorageDelete',
	'kody.__mockPackageStorageList',
	'kody.__mockPackageStorageSql',
	// Published package-app-kit / packageStorage helpers may hop these names
	// directly (same scratch store as the __mock* bridges above).
	'kody.packageStorageGet',
	'kody.packageStorageSet',
	'kody.packageStorageDelete',
	'kody.packageStorageList',
	'kody.packageStorageSql',
	// Credential client: fake metadata + handles only (never prod secrets).
	'kody.credentialClientOpen',
	'kody.credentialClientOpenAll',
	'kody.credentialClientCheck',
	'kody.credentialClientRefresh',
	// OAuth / ambient outbound hops — intercepted by the Node MSW gateway on
	// --target mock (see mock-fetch-gateway.ts). Listed here so CapabilityProxy
	// session probes treat them as known; the mock HTTP server refuses with
	// unmocked_request if a call somehow bypasses the bridge.
	'kody.authenticatedFetch',
	'kody.gatewayFetch',
	'kody.gatewayFetchStream',
	// Read-only admin fixture so gift-cliff-ops-style packages can smoke locally.
	'kody.adminUserList',
] as const

export type MockOpenApiOperationId = (typeof mockOpenApiOperationIds)[number]
export type MockCapabilityPath = (typeof mockCapabilityPaths)[number]

export function isMockOpenApiOperation(
	id: string,
): id is MockOpenApiOperationId {
	return (mockOpenApiOperationIds as ReadonlyArray<string>).includes(id)
}

export function isMockCapabilityPath(
	pathKey: string,
): pathKey is MockCapabilityPath {
	return (mockCapabilityPaths as ReadonlyArray<string>).includes(pathKey)
}
