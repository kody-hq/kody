import { expect, test } from 'vitest'
import { kodyappsDevToKodyRunCodemod } from './0004-kodyapps-dev-to-kody-run.ts'

test('0004 rewrites apex and per-user subdomain origins and preserves boundaries', async () => {
	const files = {
		'index.ts': [
			"const apex = 'https://kodyapps.dev'",
			"const hosted = 'https://alice.kodyapps.dev/packages/demo/report?x=1'",
			"const path = 'https://kodyapps.dev/@alice/packages/demo'",
			'',
		].join('\n'),
		'README.md': 'Docs: visit https://alice.kodyapps.dev.\n',
	}

	const result = await kodyappsDevToKodyRunCodemod.transform(files)
	expect(result.changed).toBe(true)
	expect(result.changedPaths).toEqual(['index.ts', 'README.md'])
	expect(result.files['index.ts']).toBe(
		[
			"const apex = 'https://kody.run'",
			"const hosted = 'https://alice.kody.run/packages/demo/report?x=1'",
			"const path = 'https://kody.run/@alice/packages/demo'",
			'',
		].join('\n'),
	)
	expect(result.files['README.md']).toBe(
		'Docs: visit https://alice.kody.run.\n',
	)
	expect(result.needsManual).toEqual([])

	const again = await kodyappsDevToKodyRunCodemod.transform(result.files)
	expect(again.changed).toBe(false)
	expect(again.changedPaths).toEqual([])
})

test('0004 skips non-rewritable hosts, lookalikes, and binary-ish paths', async () => {
	const boundaryFiles = {
		'config.ts': [
			"const site = 'https://kody.codes'",
			"const mcp = 'https://kody.codes/mcp'",
			"const heykody = 'https://heykody.app/@user/packages/demo'",
			"const status = 'https://status.heykody.dev'",
			"const inbox = 'you@inbox.kody.codes'",
			"const evil = 'https://kodyapps.dev.evil.example'",
			"const nested = 'https://a.b.kodyapps.dev/packages/demo'",
			"const bare = 'served from kodyapps.dev for now'",
			"const legacyVar = 'PACKAGE_APP_LEGACY_HOSTS=kodyapps.dev'",
			'',
		].join('\n'),
		'phish.ts': "const evil = 'https://kodyapps.dev.evil.example/app'\n",
		'index.ts': "export const url = 'https://bob.kodyapps.dev/packages/x'\n",
		'logo.png': 'https://kodyapps.dev pretend-binary',
	}
	const boundaryResult =
		await kodyappsDevToKodyRunCodemod.transform(boundaryFiles)
	expect(boundaryResult.changed).toBe(true)
	expect(boundaryResult.changedPaths).toEqual(['index.ts'])
	expect(boundaryResult.files['config.ts']).toBe(boundaryFiles['config.ts'])
	expect(boundaryResult.files['phish.ts']).toBe(boundaryFiles['phish.ts'])
	expect(boundaryResult.files['logo.png']).toBe(boundaryFiles['logo.png'])
	expect(boundaryResult.needsManual).toEqual(
		expect.arrayContaining([
			{
				path: 'config.ts',
				message: expect.stringContaining('manually'),
			},
			{
				path: 'phish.ts',
				message: expect.stringContaining('manually'),
			},
		]),
	)

	const findings = await kodyappsDevToKodyRunCodemod.detect(boundaryFiles)
	expect(findings).toEqual(
		expect.arrayContaining([
			{
				path: 'index.ts',
				message: expect.stringContaining('rewrite to https://kody.run'),
			},
			{
				path: 'config.ts',
				message: expect.stringContaining('manually'),
			},
			{
				path: 'phish.ts',
				message: expect.stringContaining('manually'),
			},
		]),
	)
	expect(findings.some((finding) => finding.path === 'logo.png')).toBe(false)
})
