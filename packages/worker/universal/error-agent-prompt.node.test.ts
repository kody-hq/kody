import { expect, test } from 'vitest'
import {
	buildErrorAgentPrompt,
	escapeErrorAgentPromptHtml,
	redactErrorAgentPromptText,
	renderErrorAgentPromptStaticHtml,
} from './error-agent-prompt.ts'
import {
	buildConnectOauthFailureAgentPrompt,
	buildInternalErrorAgentPrompt,
	buildPackageAppErrorAgentPrompt,
} from './error-agent-prompt-presets.ts'

test('buildErrorAgentPrompt includes activity, codes, ids, tools, and docs', () => {
	const prompt = buildErrorAgentPrompt({
		activity: 'Connecting GitHub on /connect/oauth',
		errorCode: 'token_exchange_failed',
		errorMessage: 'Unable to save OAuth tokens.',
		ids: {
			provider: 'github',
			packageKodyId: 'pkg_abc',
			orgSlug: 'acme',
			requestId: 'req_123',
			path: '/connect/oauth',
		},
		likelyCause: 'Token exchange failed after the provider callback.',
		nextSteps: ['Open guide:oauth', 'Retry with a complete connect URL'],
		kodyTools: ['search({ entity: "guide:oauth" })', 'integrationList'],
		docs: ['search({ entity: "guide:oauth" })'],
	})

	expect(prompt).toContain('Connecting GitHub on /connect/oauth')
	expect(prompt).toContain('Error code: token_exchange_failed')
	expect(prompt).toContain('Exact error: Unable to save OAuth tokens.')
	expect(prompt).toContain('Package kody_id: pkg_abc')
	expect(prompt).toContain('Org slug: acme')
	expect(prompt).toContain('Provider: github')
	expect(prompt).toContain('Likely cause:')
	expect(prompt).toContain('Concrete next steps:')
	expect(prompt).toContain('Kody tools to use:')
	expect(prompt).toContain('Relevant docs:')
	expect(prompt).toContain('search({ entity: "guide:oauth" })')
})

test('redactErrorAgentPromptText strips bearer, jwt, keys, and query secrets', () => {
	expect(
		redactErrorAgentPromptText('Authorization: Bearer abcdefghijklmnop.secret'),
	).toContain(`Bearer [REDACTED]`)
	expect(
		redactErrorAgentPromptText(
			'token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturepartishere',
		),
	).toContain('[REDACTED]')
	expect(
		redactErrorAgentPromptText('key sk_live_abcdefghijklmnopqrstuv'),
	).toContain('[REDACTED]')
	expect(
		redactErrorAgentPromptText(
			'https://kody.codes/connect/oauth?code=splendid-secret-code&provider=github',
		),
	).toContain('code=[REDACTED]')
	expect(
		redactErrorAgentPromptText(
			'https://kody.codes/callback?access_token%3Dsuper-secret-token-value-here',
		),
	).toContain('access_token=[REDACTED]')
	expect(
		redactErrorAgentPromptText(
			'Authorization: Bearer abc+def/ghi=padded-token-value',
		),
	).toContain('Bearer [REDACTED]')
	expect(
		redactErrorAgentPromptText(
			'Authorization: Bearer abc+def/ghi=padded-token-value',
		),
	).not.toContain('abc def')
	// Encoded JWT dots (`%2E`): plain matchers stop at `%` and would leave the
	// payload/signature visible if we kept the raw redaction.
	const encodedJwt =
		'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9%2EeyJzdWIiOiIxMjM0NTY3ODkwIn0%2Esignaturepartishere'
	const redactedEncodedJwt = redactErrorAgentPromptText(encodedJwt)
	expect(redactedEncodedJwt).toContain('Bearer [REDACTED]')
	expect(redactedEncodedJwt).not.toContain('signaturepartishere')
	expect(redactedEncodedJwt).not.toContain('%2E')
	expect(
		redactErrorAgentPromptText('password: hunter2-extra-long-value'),
	).toContain('password: [REDACTED]')
	expect(
		redactErrorAgentPromptText(
			'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
		),
	).toBe('[REDACTED]')
})

test('buildErrorAgentPrompt redacts secrets inside free-form fields', () => {
	const prompt = buildErrorAgentPrompt({
		activity: 'Opened callback with access_token=super-secret-token-value-here',
		errorMessage:
			'Exchange failed for Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature-extra-chars',
	})
	expect(prompt).toContain('access_token=[REDACTED]')
	expect(prompt).not.toContain('super-secret-token-value-here')
	expect(prompt).toContain('Bearer [REDACTED]')
})

test('static HTML block stamps the inventory marker and escapes prompt text', () => {
	const html = renderErrorAgentPromptStaticHtml(
		'Exact error: use <script>alert(1)</script> & fail',
	)
	expect(html).toContain('data-error-agent-prompt=""')
	expect(html).toContain('&lt;script&gt;')
	expect(html).toContain('&amp; fail')
	expect(html).not.toContain('<script>alert')
	expect(escapeErrorAgentPromptHtml('<&>')).toBe('&lt;&amp;&gt;')
})

test('presets cover internal and package-app failures', () => {
	const internal = buildInternalErrorAgentPrompt({ path: '/account' })
	expect(internal).toContain('internal_error')
	expect(internal).toContain('Path: /account')

	const crashed = buildPackageAppErrorAgentPrompt({
		kind: 'package-entrypoint',
		packageName: '@acme/app',
		kodyId: 'pkg_123',
		path: '/@acme/packages/pkg_123/',
		runtimeRunId: 'run_abc',
	})
	expect(crashed).toContain('pkg_123')
	expect(crashed).toContain('runGet')

	const pending = buildPackageAppErrorAgentPrompt({
		kind: 'runtime-bundle-pending',
		packageName: '@acme/app',
		kodyId: 'pkg_123',
		path: '/@acme/packages/pkg_123/',
	})
	expect(pending).toContain('package_app_runtime_bundle_pending')
	expect(pending).toContain('still preparing')

	const oauth = buildConnectOauthFailureAgentPrompt({
		statusMessage: 'Unable to save OAuth tokens.',
		provider: 'linear',
	})
	expect(oauth).toContain('Unable to save OAuth tokens.')
	expect(oauth).toContain('guide:oauth')
})
