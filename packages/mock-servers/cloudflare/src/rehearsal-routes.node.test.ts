import { expect, test } from 'vitest'
import { routeRehearsal } from './rehearsal-routes.ts'

test('rehearsal authorize redirects to redirect_uri with a mock code and state', async () => {
	const url = new URL(
		'https://preview.example/__mocks/rehearsal/oauth/authorize?response_type=code&client_id=rehearsal-client&redirect_uri=https://app.example/connect/oauth&state=csrf-state',
	)
	const response = await routeRehearsal(new Request(url), url)
	expect(response).not.toBeNull()
	expect(response?.status).toBe(302)
	const location = new URL(response?.headers.get('location') ?? '')
	expect(location.origin + location.pathname).toBe(
		'https://app.example/connect/oauth',
	)
	expect(location.searchParams.get('state')).toBe('csrf-state')
	expect(location.searchParams.get('code')).toMatch(/^rehearsal_code_/)
})

test('rehearsal authorize refuses a missing response_type', async () => {
	const url = new URL(
		'https://preview.example/__mocks/rehearsal/oauth/authorize?client_id=rehearsal-client&redirect_uri=https://app.example/connect/oauth&state=x',
	)
	const response = await routeRehearsal(new Request(url), url)
	expect(response?.status).toBe(400)
	expect(await response?.json()).toMatchObject({
		error: 'invalid_request',
	})
})

test('rehearsal authorize refuses a non-http redirect_uri', async () => {
	const url = new URL(
		'https://preview.example/__mocks/rehearsal/oauth/authorize?response_type=code&client_id=rehearsal-client&redirect_uri=javascript:alert(1)&state=x',
	)
	const response = await routeRehearsal(new Request(url), url)
	expect(response?.status).toBe(400)
	expect(await response?.json()).toMatchObject({
		error: 'invalid_request',
	})
})
