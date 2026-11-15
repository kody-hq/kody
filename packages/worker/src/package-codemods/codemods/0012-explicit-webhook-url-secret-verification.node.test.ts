import { expect, test } from 'vitest'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import { explicitWebhookUrlSecretVerificationCodemod as codemod } from './0012-explicit-webhook-url-secret-verification.ts'

const githubVerification = {
	type: 'hmac-sha256',
	header: 'x-hub-signature-256',
	encoding: 'hex',
	prefix: 'sha256=',
}

function manifest(kodyExtra: Record<string, unknown> = {}, indent = '\t') {
	return `${JSON.stringify(
		{
			name: '@user/demo',
			exports: {
				'./telegram': './src/telegram.ts',
				'./github': './src/github.ts',
			},
			kody: {
				id: 'demo',
				description: 'Demo package for webhook verification codemod tests.',
				...kodyExtra,
			},
		},
		null,
		indent,
	)}\n`
}

test('0012 is detect-only: it reports undeclared webhooks as a recommendation and never rewrites the manifest', async () => {
	const files = {
		'package.json': manifest(
			{
				webhooks: [
					{ name: 'telegram', export: './telegram', responseMode: 'sync' },
					{
						name: 'github',
						export: './github',
						verification: githubVerification,
					},
				],
			},
			'  ',
		),
		'src/telegram.ts': 'export default () => ({ ok: true })\n',
	}
	const findings = await codemod.detect(files)
	expect(findings).toEqual([
		{
			path: 'package.json',
			message: expect.stringContaining('without verification'),
		},
	])
	expect(findings[0]?.message).toContain('keeps working on its URL secret')

	const result = await codemod.transform(files)
	expect(result).toEqual({
		files,
		changed: false,
		changedPaths: [],
		needsManual: findings,
	})
	expect(
		parseAuthoredPackageJson({
			content: result.files['package.json']!,
		}).kody.webhooks?.map((webhook) => webhook.verification?.type ?? null),
	).toEqual([null, 'hmac-sha256'])
})

test('0012 leaves packages without webhooks or with every webhook declared untouched', async () => {
	for (const files of [
		{ 'package.json': manifest() },
		{ 'package.json': manifest({ webhooks: [] }) },
		{
			'package.json': manifest({
				webhooks: [
					{
						name: 'telegram',
						export: './telegram',
						verification: { type: 'url-secret' },
					},
				],
			}),
		},
		{ 'package.json': '{ "name": "@user/demo" }\n' },
	]) {
		expect(await codemod.detect(files)).toEqual([])
		const result = await codemod.transform(files)
		expect(result).toEqual({
			files,
			changed: false,
			changedPaths: [],
			needsManual: [],
		})
	}
})

test('0012 flags unreadable manifests and malformed webhooks for manual review without echoing their contents', async () => {
	for (const source of [
		undefined,
		'{ not json',
		manifest({ webhooks: { telegram: './telegram' } }),
		manifest({ webhooks: ['telegram'] }),
		manifest({
			webhooks: [
				{ name: 'telegram', export: './telegram' },
				{ name: 'github', export: './github', verification: 'hmac' },
			],
		}),
	]) {
		const files: Record<string, string> =
			source === undefined ? {} : { 'package.json': source }
		const findings = await codemod.detect(files)
		expect(findings).toHaveLength(1)
		expect(findings[0]?.message).toMatch(/manual/)
		expect(findings[0]?.message).not.toContain('telegram')
		const result = await codemod.transform(files)
		expect(result.changed).toBe(false)
		expect(result.files).toEqual(files)
		expect(result.needsManual).toEqual(findings)
	}
})
