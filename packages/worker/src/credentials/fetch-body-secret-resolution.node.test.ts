import { expect, test } from 'vitest'
import { findFetchBodiesMissingSecretResolution } from './fetch-body-secret-resolution.ts'

function lines(source: string) {
	return findFetchBodiesMissingSecretResolution(source).map((hit) => hit.line)
}

test('warns when a fetch body forwards a value and headers do not opt out', () => {
	const source = `
export async function post(userReport: string) {
	await fetch('https://api.github.com/repos/acme/widgets/issues', {
		method: 'POST',
		headers: {
			Authorization: 'Bearer {{secret:github}}',
			'content-type': 'application/json',
		},
		body: JSON.stringify({ title: 'Widget broke', body: userReport }),
	})
}
`
	expect(lines(source)).toEqual([3])
})

test('uses the last body and headers properties when keys are duplicated', () => {
	expect(
		lines(`
			fetch(url, {
				body: userText,
				body: 'fixed',
			})
		`),
	).toEqual([])
	expect(
		lines(`
			fetch(url, {
				headers: {},
				headers: { 'x-kody-secret-resolution': 'headers-only' },
				body: userText,
			})
		`),
	).toEqual([])
	expect(
		lines(`
			fetch(url, {
				body: 'fixed',
				body: userText,
			})
		`),
	).toEqual([2])
})

test('skips author-written bodies and explicit resolution modes', () => {
	expect(
		lines(`
			fetch(url, {
				body: JSON.stringify({ tags: ['a', 'b'] }),
			})
		`),
	).toEqual([])
	expect(
		lines(`
			fetch(url, {
				body: new URLSearchParams([['a', 'b']]),
			})
		`),
	).toEqual([])
	expect(
		lines(`
			fetch(url, {
				body: JSON.stringify(['a'].concat(userText)),
			})
		`),
	).toEqual([2])
	expect(
		lines(`
			fetch('https://api.example.com/oauth/token', {
				method: 'POST',
				headers: { Authorization: 'Bearer {{secret:github}}' },
				body: JSON.stringify({ grant_type: 'client_credentials' }),
			})
		`),
	).toEqual([])
	expect(
		lines(`
			fetch('https://api.example.com/issues', {
				method: 'POST',
				headers: {
					Authorization: 'Bearer {{secret:github}}',
					'x-kody-secret-resolution': 'headers-only',
				},
				body: JSON.stringify({ body: userReport }),
			})
		`),
	).toEqual([])
	expect(
		lines(`
			fetch(url, {
				headers: { 'X-Kody-Secret-Resolution': "off" },
				body: message,
			})
		`),
	).toEqual([])
	expect(
		lines(`
			fetch(url, {
				headers: { 'x-kody-secret-resolution': mode },
				body: message,
			})
		`),
	).toEqual([])
	expect(
		lines(`
			fetch(url, {
				headers: { 'x-kody-secret-resolution': 'ON' },
				body: userText,
			})
		`),
	).toEqual([2])
	expect(
		lines(`
			fetch(url, {
				headers: { 'x-kody-secret-resolution': ' ON ' },
				body: userText,
			})
		`),
	).toEqual([2])
	expect(lines(`fetch(url, init)`)).toEqual([])
	expect(lines(`fetch(url)`)).toEqual([])
})

test('warns when headers come from a variable, helper, or spread', () => {
	expect(
		lines(`
			fetch(url, { headers, body: message })
		`),
	).toEqual([2])
	expect(
		lines(`
			fetch(url, { headers: buildHeaders(), body: message })
		`),
	).toEqual([2])
	expect(
		lines(`
			fetch(url, { headers: { ...headers }, body: message })
		`),
	).toEqual([2])
	expect(
		lines(`
			fetch(url, {
				headers: {
					Authorization: 'Bearer {{secret:github}}',
					...extra,
				},
				body: message,
			})
		`),
	).toEqual([2])
})

test('ignores an async fetch method on a package app entry', () => {
	expect(
		lines(`
			export default {
				async fetch(request: Request) {
					return new Response('ok')
				},
			}
		`),
	).toEqual([])
})

test('ignores comments, strings, and function declarations', () => {
	expect(
		lines(`
			// fetch(url, { body: message })
			const sample = "fetch(url, { body: message })"
			function fetch(req: Request) {
				return req
			}
			export const ready = true
		`),
	).toEqual([])
})

test('warns for shorthand bodies, templates, and new Request', () => {
	expect(lines(`fetch(url, { body })`)).toEqual([1])
	expect(lines('fetch(url, { body: `note ${text}` })')).toEqual([1])
	expect(lines('fetch(url, { body: `plain` })')).toEqual([])
	expect(
		lines(`
			const request = new Request(url, { method: 'POST', body: issueBody })
			await fetch(request)
		`),
	).toEqual([2])
	expect(
		lines(`
			client.fetch(url, { body: payload })
		`),
	).toEqual([2])
})
