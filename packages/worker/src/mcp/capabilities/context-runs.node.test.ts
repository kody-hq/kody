import { expect, test } from 'vitest'
import { loadBuiltinDomains } from './builtin-domains.ts'

// Every capability an execution context run may call. Widening this list is
// a one-line diff in review (ECP 8.2).
test('contextRuns allow list snapshot', async () => {
	const domains = await loadBuiltinDomains()
	const capabilities = domains.flatMap((domain) => domain.capabilities)
	for (const capability of capabilities) {
		expect(['allow', 'deny']).toContain(capability.contextRuns)
	}
	const allowed = capabilities
		.filter((capability) => capability.contextRuns === 'allow')
		.map((capability) => capability.name)
		.sort()
	expect(allowed).toMatchSnapshot()
	for (const denied of [
		'execute',
		'jobRunNow',
		'cliCredentialBootstrap',
		'experimentSet',
		'accessGrant',
		'inviteLinkCreate',
		'packageCollaboratorSet',
		'secretSet',
		'packageDelete',
		'repoRunChecks',
		'credentialTriggerPickSet',
		'packageAppRunsAsSet',
		'adminSoftDeletePurgeRun',
	]) {
		expect(allowed).not.toContain(denied)
	}
})
