import { expect, test } from 'vitest'
import {
	cimdLastKnownGoodKey,
	isCimdClientIdUrl,
	prepareCimdClientForRefresh,
} from '#worker/oauth-cimd-refresh-cache.ts'

test('isCimdClientIdUrl matches HTTPS client ids with a path', () => {
	expect(
		isCimdClientIdUrl('https://vscode.dev/oauth/client-metadata.json'),
	).toBe(true)
	expect(isCimdClientIdUrl('https://vscode.dev/')).toBe(false)
	expect(isCimdClientIdUrl('http://vscode.dev/client.json')).toBe(false)
	expect(isCimdClientIdUrl('https://user:pw@vscode.dev/client.json')).toBe(
		false,
	)
	expect(isCimdClientIdUrl('https://vscode.dev/client.json#x')).toBe(false)
	expect(isCimdClientIdUrl('FDUN-3EVGH5LdgdI')).toBe(false)
})

test('cimdLastKnownGoodKey hashes the client id under the derived cache prefix', async () => {
	const key = await cimdLastKnownGoodKey(
		'https://vscode.dev/oauth/client-metadata.json',
	)
	expect(key).toMatch(
		/^derived-cache:v1:oauth-cimd-last-known-good:[0-9a-f]{64}$/,
	)
	expect(key).not.toContain('vscode')
})

test('prepareCimdClientForRefresh ignores registered client ids', async () => {
	await expect(
		prepareCimdClientForRefresh({ env: {} as Env, clientId: 'dcr-client' }),
	).resolves.toMatchObject({ outcome: 'not-cimd' })
	await expect(
		prepareCimdClientForRefresh({ env: {} as Env, clientId: null }),
	).resolves.toMatchObject({ outcome: 'not-cimd' })
})
