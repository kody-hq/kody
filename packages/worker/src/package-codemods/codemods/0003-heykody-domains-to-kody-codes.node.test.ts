import { expect, test } from 'vitest'
import { heykodyDomainsToKodyCodesCodemod } from './0003-heykody-domains-to-kody-codes.ts'

test('0003 rewrites full legacy origins and preserves boundaries', async () => {
	const files = {
		'index.ts': [
			"const site = 'https://heykody.app'",
			"const mcp = 'https://heykody.dev/mcp'",
			"const invoke = 'https://heykody.app/@user/webhooks/demo/sentry/secret?x=1'",
			'',
		].join('\n'),
		'README.md': 'Docs: visit https://heykody.app.\n',
	}

	const result = await heykodyDomainsToKodyCodesCodemod.transform(files)
	expect(result.changed).toBe(true)
	expect(result.changedPaths).toEqual(['index.ts', 'README.md'])
	expect(result.files['index.ts']).toBe(
		[
			"const site = 'https://kody.codes'",
			"const mcp = 'https://kody.codes/mcp'",
			"const invoke = 'https://kody.codes/@user/webhooks/demo/sentry/secret?x=1'",
			'',
		].join('\n'),
	)
	// Sentence-final period is not a subdomain continuation.
	expect(result.files['README.md']).toBe('Docs: visit https://kody.codes.\n')
	expect(result.needsManual).toEqual([])

	// Idempotent: a second run changes nothing.
	const again = await heykodyDomainsToKodyCodesCodemod.transform(result.files)
	expect(again.changed).toBe(false)
	expect(again.changedPaths).toEqual([])
})

test('0003 never rewrites subdomains, emails, bare hostnames, or lookalike hosts', async () => {
	const boundaryFiles = {
		'config.ts': [
			"const status = 'https://status.heykody.dev'",
			"const inbox = 'you@inbox.heykody.app'",
			"const support = 'support@heykody.dev'",
			"const evil = 'https://heykody.app.evil.example'",
			"const bare = 'served from heykody.app for now'",
			'',
		].join('\n'),
	}
	const boundaryResult =
		await heykodyDomainsToKodyCodesCodemod.transform(boundaryFiles)
	expect(boundaryResult.changed).toBe(false)
	expect(boundaryResult.files['config.ts']).toBe(boundaryFiles['config.ts'])
	expect(boundaryResult.needsManual).toEqual([
		{
			path: 'config.ts',
			message: expect.stringContaining('manually'),
		},
	])
})

test('0003 detect reports rewritable origins and skips binary-ish paths', async () => {
	const files = {
		'index.ts': "export const url = 'https://heykody.app/guides'\n",
		'logo.png': 'https://heykody.app pretend-binary',
	}
	const findings = await heykodyDomainsToKodyCodesCodemod.detect(files)
	expect(findings).toEqual([
		{
			path: 'index.ts',
			message: expect.stringContaining('rewrite to https://kody.codes'),
		},
	])
	const result = await heykodyDomainsToKodyCodesCodemod.transform(files)
	expect(result.changedPaths).toEqual(['index.ts'])
	expect(result.files['logo.png']).toBe(files['logo.png'])
})
