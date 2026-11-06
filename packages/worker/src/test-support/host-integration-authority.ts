import {
	type HostIntegrationAuthority,
	type IntegrationConfig,
	type KodyNamespace,
	INTEGRATION_RUNTIME_CONFIG_TOOL_NAME,
} from '#mcp/execute-modules/kody-runtime-utils.ts'

/**
 * Host-side authority backed by the same fake `kody` a sandbox test
 * dispatches to, so host and sandbox `createAuthenticatedFetch` share one
 * fixture.
 */
export function hostAuthorityFromKody(
	kody: KodyNamespace,
): HostIntegrationAuthority {
	return {
		async readConfig(name) {
			const readConfig = kody[INTEGRATION_RUNTIME_CONFIG_TOOL_NAME]
			if (typeof readConfig !== 'function') {
				throw new Error(
					'createAuthenticatedFetch is not available in this sandbox.',
				)
			}
			const result = (await readConfig({ name })) as {
				integration: IntegrationConfig | null
			} | null
			return result?.integration ?? null
		},
		async refresh(name) {
			const refresh = kody.integrationTokenRefresh
			if (typeof refresh !== 'function') {
				throw new Error('integrationTokenRefresh is not available.')
			}
			return (await refresh({ name })) as { ok: true; refreshed: boolean }
		},
	}
}
