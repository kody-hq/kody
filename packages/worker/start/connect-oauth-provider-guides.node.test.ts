import { readFileSync, readdirSync } from 'node:fs'
import { expect, test } from 'vitest'
import {
	mergeConnectOauthConfig,
	toStoredIntegrationConfig,
} from '#client/routes/connect-oauth-config.ts'
import { readConnectOauthQueryConfig } from './pages/connect-oauth-shared.ts'

const providerGuidesDirectory = new URL(
	'../../../docs/guides/providers/',
	import.meta.url,
)

const connectOauthLinkPattern = /https:\/\/kody\.codes\/connect\/oauth\?\S+/g

function readGuide(fileName: string) {
	return readFileSync(new URL(fileName, providerGuidesDirectory), 'utf8')
}

function readConnectLinks(fileName: string) {
	return [...readGuide(fileName).matchAll(connectOauthLinkPattern)]
		.map((match) => match[0].replace(/[).,`]+$/, ''))
		.filter((href) => new URL(href).searchParams.has('authorizeUrl'))
}

function readQueryConfig(href: string) {
	const result = readConnectOauthQueryConfig(new URL(href))
	if (!result.ok) throw new Error(`${href}: ${result.error}`)
	return result.value
}

test('every prefilled provider connect link parses into a connect config', () => {
	const guides = readdirSync(providerGuidesDirectory).filter((name) =>
		name.endsWith('.md'),
	)
	expect(guides).toContain('dropbox.md')
	for (const guide of guides) {
		for (const href of readConnectLinks(guide)) {
			const config = mergeConnectOauthConfig({
				queryConfig: readQueryConfig(href),
				storedIntegration: null,
			})
			expect(config, `${guide}: ${href}`).not.toBeNull()
		}
	}
})

const dropboxHosts = [
	'api.dropboxapi.com',
	'content.dropboxapi.com',
	'notify.dropboxapi.com',
]

function readDropboxPreset() {
	const [href, ...rest] = readConnectLinks('dropbox.md')
	expect(rest).toEqual([])
	if (!href) throw new Error('The Dropbox guide has no connect link.')
	return readQueryConfig(href)
}

test('the Dropbox preset connects with PKCE, a refresh token, and every Dropbox API host', () => {
	const config = mergeConnectOauthConfig({
		queryConfig: readDropboxPreset(),
		storedIntegration: null,
	})
	expect(config).toMatchObject({
		provider: 'dropbox',
		authorizeUrl: 'https://www.dropbox.com/oauth2/authorize',
		tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
		apiBaseUrl: 'https://api.dropboxapi.com/',
		flow: 'pkce',
		usePkce: true,
		extraAuthorizeParams: { token_access_type: 'offline' },
		allowedHosts: dropboxHosts,
	})
	expect(config?.scopes).toEqual(
		expect.arrayContaining(['files.content.read', 'files.content.write']),
	)
})

test('reconnecting an api-only Dropbox connection with the preset adds the missing hosts', () => {
	const stored = toStoredIntegrationConfig({
		name: 'dropbox',
		appSlug: 'dropbox',
		provider: 'dropbox',
		appLabel: null,
		accountLabel: null,
		createdAt: '2026-10-14T00:00:00.000Z',
		updatedAt: '2026-10-14T00:00:00.000Z',
		tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
		flow: 'pkce',
		clientId: 'dropbox-app-key',
		requiredHosts: ['api.dropboxapi.com', 'files.example.com'],
		authorization: {
			authorizeUrl: 'https://www.dropbox.com/oauth2/authorize',
			scopes: ['files.content.read'],
		},
	})
	expect(stored?.requiredHosts).toEqual([
		'api.dropboxapi.com',
		'files.example.com',
	])
	const config = mergeConnectOauthConfig({
		queryConfig: readDropboxPreset(),
		storedIntegration: stored,
	})
	expect(config?.allowedHosts).toEqual([
		'api.dropboxapi.com',
		'content.dropboxapi.com',
		'files.example.com',
		'notify.dropboxapi.com',
	])
	expect(config?.clientId).toBe('dropbox-app-key')
})
