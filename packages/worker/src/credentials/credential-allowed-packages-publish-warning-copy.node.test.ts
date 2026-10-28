import { expect, test } from 'vitest'
import { formatCredentialAllowedPackagesPublishWarning } from './credential-allowed-packages-publish-warning.ts'

test('warning copy describes enforced behavior without a rollout date', () => {
	const message = formatCredentialAllowedPackagesPublishWarning({
		credentialName: 'RESEND_API_KEY',
		allowedEntries: [
			{ kind: 'package', id: 'pkg-notes', displayName: '@owner/notes' },
		],
		packageDisplayName: '@owner/demo',
		approvalUrl:
			'https://kody.codes/@owner/-/secrets/user/RESEND_API_KEY?package_id=pkg-demo&package=demo',
	})
	expect(message).toContain(
		'Credential "RESEND_API_KEY" is allowed only for @owner/notes, not @owner/demo, so',
	)
	expect(message).toContain(
		'so Kody denies @owner/demo when it uses this credential, whether it runs on its own',
	)
	expect(message).not.toContain('for now')
	expect(message).toContain(
		'approve: https://kody.codes/@owner/-/secrets/user/RESEND_API_KEY?package_id=pkg-demo&package=demo.',
	)
	expect(message).not.toMatch(/Starting|2026|Wednesday/)
})
