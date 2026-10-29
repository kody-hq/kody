import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { type ConnectOauthConfig } from '#client/routes/connect-oauth-config.ts'
import { type ConnectOauthExistingConnection } from '#universal/loader-data.ts'
import {
	newConnectionNameError,
	renderLiveAppReplaceWarning,
	suggestNewConnectionName,
	wouldReplaceLiveApp,
} from './connect-oauth-sections.tsx'

const identity = {
	clientId: 'client-a',
	tokenUrl: 'https://auth.example.com/token',
	authorizeUrl: 'https://auth.example.com/authorize',
	deviceAuthorizationUrl: null,
	flow: 'pkce' as const,
}

const liveConnection: ConnectOauthExistingConnection = {
	lane: 'user',
	appSlug: 'acme',
	appName: 'Acme',
	connected: true,
	identity,
}

function next(overrides: Partial<ConnectOauthConfig> = {}) {
	return {
		...identity,
		platformAppSlug: null,
		...overrides,
	} as ConnectOauthConfig
}

test('wouldReplaceLiveApp flags app-identity edits on a live bring-your-own connection only', () => {
	const existingConnection = liveConnection
	expect(wouldReplaceLiveApp({ next: next(), existingConnection })).toBe(false)
	expect(
		wouldReplaceLiveApp({
			next: next({ clientId: 'client-b' }),
			existingConnection,
		}),
	).toBe(true)
	expect(
		wouldReplaceLiveApp({
			next: next({ tokenUrl: 'https://auth.example.com/v2/token' }),
			existingConnection,
		}),
	).toBe(true)
	expect(
		wouldReplaceLiveApp({
			next: next({ flow: 'confidential' }),
			existingConnection,
		}),
	).toBe(true)
	// Unfinished setups and platform connections keep today's behavior.
	expect(
		wouldReplaceLiveApp({
			next: next({ clientId: 'client-b' }),
			existingConnection: { ...liveConnection, connected: false },
		}),
	).toBe(false)
	expect(
		wouldReplaceLiveApp({
			next: next({ clientId: 'client-b' }),
			existingConnection: {
				...liveConnection,
				lane: 'platform',
				identity: null,
			},
		}),
	).toBe(false)
	expect(
		wouldReplaceLiveApp({
			next: next({ clientId: 'client-b' }),
			existingConnection: null,
		}),
	).toBe(false)
})

test('save-as-new suggests NAME-2 and validates with the integration name rules', () => {
	expect(suggestNewConnectionName('acme')).toBe('acme-2')
	expect(newConnectionNameError('acme-2', 'acme')).toBeNull()
	expect(newConnectionNameError('Acme Work', 'acme')).toBeNull()
	expect(newConnectionNameError('---', 'acme')).toMatch(/letters or numbers/)
	expect(newConnectionNameError('ACME', 'acme')).toMatch(/other than acme/)
})

function render(mode: 'choose' | 'new-name', nameError: string | null = null) {
	const noop = () => {}
	return renderToStaticMarkup(
		renderLiveAppReplaceWarning({
			connectionName: 'acme',
			existingConnection: liveConnection,
			state: { mode, newName: 'acme-2', nameError },
			submitting: false,
			onReplace: noop,
			onChooseNewName: noop,
			onNewNameInput: noop,
			onSaveAsNew: noop,
			onCancel: noop,
		}),
	)
}

test('the live-app warning names the app and offers replace or save-as-new', () => {
	const choose = render('choose')
	expect(choose).toContain('connect-live-replace-warning')
	expect(choose).toContain('<strong>Acme</strong>')
	expect(choose).toContain('stops working until you reconnect it')
	expect(choose).toContain('Replace this app')
	expect(choose).toContain('Save as a new connection')
	expect(choose).not.toContain('newConnectionName')

	const newName = render('new-name')
	expect(newName).toContain('name="newConnectionName"')
	expect(newName).toContain('value="acme-2"')
	expect(newName).toContain('acme keeps its current app and tokens.')

	const invalid = render('new-name', 'Pick a name other than acme.')
	expect(invalid).toContain('aria-invalid="true"')
	expect(invalid).toContain('Pick a name other than acme.')
})
