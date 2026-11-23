import { expect, test } from 'vitest'
import {
	applyPackageAppDefaults,
	buildPackageAppIconDataUrl,
} from './package-app-defaults.ts'

function pageVisit(method = 'GET') {
	return new Request('https://alice.kody.run/notes/missing', {
		method,
		headers: {
			Accept: 'text/html,application/xhtml+xml',
			'Sec-Fetch-Dest': 'document',
		},
	})
}

const base = {
	appName: 'notes',
	description: 'Quick notes for the family.',
	appHomePath: '/notes/',
}

test('a page visit the app answers with a plain-text 404 gets the friendly 404 page', async () => {
	const response = await applyPackageAppDefaults({
		...base,
		request: pageVisit(),
		response: new Response('Not found', { status: 404 }),
	})
	expect(response.status).toBe(404)
	expect(response.headers.get('x-kody-default')).toBe('not-found')
	expect(response.headers.get('Content-Type')).toContain('text/html')
	const body = await response.text()
	expect(body).toContain('Page not found')
	expect(body).toContain('href="/notes/"')
	expect(body).not.toContain('\u2014')
})

test('API 404s and app-made HTML 404 pages keep the app response body', async () => {
	const api = await applyPackageAppDefaults({
		...base,
		request: new Request('https://alice.kody.run/notes/api/x', {
			headers: { Accept: 'application/json' },
		}),
		response: Response.json({ error: 'nope' }, { status: 404 }),
	})
	expect(await api.json()).toEqual({ error: 'nope' })
	expect(api.headers.get('x-kody-default')).toBeNull()

	const custom = await applyPackageAppDefaults({
		...base,
		request: pageVisit(),
		response: new Response(
			'<!doctype html><html><head><title>Lost</title></head><body>My 404</body></html>',
			{ status: 404, headers: { 'Content-Type': 'text/html' } },
		),
	})
	expect(custom.status).toBe(404)
	expect(await custom.text()).toContain('My 404')
})

test('missing head tags are added and the app keeps every tag it set', async () => {
	const bare = await applyPackageAppDefaults({
		...base,
		request: pageVisit(),
		response: new Response(
			'<!doctype html><html><head><meta charset="utf-8"></head><body>Hi</body></html>',
			{ headers: { 'Content-Type': 'text/html; charset=utf-8' } },
		),
	})
	const bareHtml = await bare.text()
	expect(bare.headers.get('x-kody-default')).toBe('head')
	expect(bareHtml).toContain(
		'<meta name="viewport" content="width=device-width, initial-scale=1" />',
	)
	expect(bareHtml).toContain('<title>notes</title>')
	expect(bareHtml).toContain(
		'<meta name="description" content="Quick notes for the family." />',
	)
	expect(bareHtml).toContain('<meta property="og:title" content="notes" />')
	expect(bareHtml).toContain(
		'<meta property="og:description" content="Quick notes for the family." />',
	)
	expect(bareHtml).toContain(
		`<link rel="icon" href="${buildPackageAppIconDataUrl('notes').replaceAll('&', '&amp;')}" />`,
	)
	expect(bareHtml.indexOf('<link rel="icon"')).toBeLessThan(
		bareHtml.indexOf('</head>'),
	)

	const complete = `<!doctype html><html><head><meta name="viewport" content="width=400"><title>My Notes</title><meta name="description" content="Mine"><meta property="og:title" content="OG"><meta property="og:description" content="OG d"><link rel="shortcut icon" href="/notes/_assets/icon.png"></head><body>Hi</body></html>`
	const kept = await applyPackageAppDefaults({
		...base,
		request: pageVisit(),
		response: new Response(complete, {
			headers: { 'Content-Type': 'text/html' },
		}),
	})
	expect(await kept.text()).toBe(complete)
})

test('the og:title follows the page title the app set', async () => {
	const response = await applyPackageAppDefaults({
		...base,
		request: pageVisit(),
		response: new Response(
			'<html><head><title>Shopping &amp; Errands</title></head><body></body></html>',
			{ headers: { 'Content-Type': 'text/html' } },
		),
	})
	const body = await response.text()
	expect(body).toContain(
		'<meta property="og:title" content="Shopping &amp; Errands" />',
	)
	expect(body).not.toContain('<title>notes</title>')
})

test('an empty title is filled in place, so the page has one title', async () => {
	const response = await applyPackageAppDefaults({
		...base,
		request: pageVisit(),
		response: new Response(
			'<html><head><title></title></head><body></body></html>',
			{ headers: { 'Content-Type': 'text/html' } },
		),
	})
	const body = await response.text()
	expect(body).toContain('<title>notes</title>')
	expect(body.match(/<title>/g)).toHaveLength(1)
	expect(body).toContain('<meta property="og:title" content="notes" />')
})

test('the friendly 404 keeps the cookies the app set', async () => {
	const fetched = new Response('Not found', { status: 404 })
	fetched.headers.append('Set-Cookie', 'a=1; Path=/; HttpOnly')
	fetched.headers.append('Set-Cookie', 'b=2; Path=/; HttpOnly')
	const response = await applyPackageAppDefaults({
		...base,
		request: pageVisit(),
		response: fetched,
	})
	expect(response.headers.get('x-kody-default')).toBe('not-found')
	expect(response.headers.getSetCookie()).toEqual([
		'a=1; Path=/; HttpOnly',
		'b=2; Path=/; HttpOnly',
	])
})
