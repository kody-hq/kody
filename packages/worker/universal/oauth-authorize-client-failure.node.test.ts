import { expect, test } from 'vitest'
import { buildMcpAuthorizeClientFailureAgentPrompt } from '#universal/error-agent-prompt-presets.ts'
import {
	oauthAuthorizeClientFailureMessage,
	type OAuthAuthorizeClientFailure,
} from '#universal/oauth-authorize-client-failure.ts'

const codexFetchFailure: OAuthAuthorizeClientFailure = {
	kind: 'metadata_fetch',
	host: 'chatgpt.com',
	status: 404,
	errorType: 'http_404',
	client: 'codex',
	kodyOrigin: 'https://kody.codes',
	at: '2026-10-23T23:05:00.000Z',
}

test('metadata fetch failures say whose side failed, with host and status', () => {
	expect(oauthAuthorizeClientFailureMessage(codexFetchFailure)).toBe(
		"Kody could not load Codex's client details from chatgpt.com (HTTP 404). This is a problem on the app's side, not with your Kody account.",
	)
	expect(
		oauthAuthorizeClientFailureMessage({
			...codexFetchFailure,
			status: null,
			errorType: 'timeout',
			client: 'other',
		}),
	).toBe(
		"Kody could not load this app's client details from chatgpt.com (timed out). This is a problem on the app's side, not with your Kody account.",
	)
})

test('agent prompt for a Codex metadata failure works on the machine, not Kody tools', () => {
	const prompt = buildMcpAuthorizeClientFailureAgentPrompt({
		failure: codexFetchFailure,
	})
	expect(prompt).toContain('https://kody.codes/mcp')
	expect(prompt).toContain('Client: Codex (client metadata at chatgpt.com)')
	expect(prompt).toContain(
		"Kody could not download the client's metadata document from chatgpt.com (HTTP 404) at 2026-10-23 23:05 UTC.",
	)
	expect(prompt).toContain('do not use Kody MCP tools')
	expect(prompt).toContain('`codex mcp list`')
	expect(prompt).toContain(
		'`codex mcp login <server> --oauth-client-registration dcr`',
	)
	expect(prompt).toContain('ChatGPT and the Codex app have no switch for this')
	expect(prompt).toContain('support@kody.codes')
	expect(prompt).toContain('Never ask me to paste credentials')
	expect(prompt).not.toContain('search({')
	expect(prompt).not.toContain('\u2014')
})

test('agent prompt for a missing registration says to sign in again', () => {
	const prompt = buildMcpAuthorizeClientFailureAgentPrompt({
		failure: { kind: 'missing_registration', kodyOrigin: 'https://kody.codes' },
	})
	expect(prompt).toContain('Kody has no registration for the client_id')
	expect(prompt).toContain(
		'`codex mcp logout <server>` then `codex mcp login <server>`',
	)
	expect(prompt).toContain('~/.mcp-auth')
	expect(prompt).toContain('then add https://kody.codes/mcp again')
	expect(prompt).not.toContain('--oauth-client-registration dcr')
	expect(prompt).toContain('support@kody.codes')
})
