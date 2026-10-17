import { expect, test } from 'vitest'
import { requestHasDataFields } from './server-function-requests.ts'

test('typed input matcher excludes authorization and reads null auth redirect input exactly', () => {
	const request = (keys: string[], values: unknown[]) => ({
		method: () => 'GET',
		url: () =>
			`https://kody.test/_serverFn/example?${new URLSearchParams({ payload: JSON.stringify({ t: { t: 10, p: { k: ['data'], v: [{ t: 10, p: { k: keys, v: values } }] } } }) })}`,
	})
	expect(
		requestHasDataFields(
			request(['orgSlug'], [{ t: 1, s: 'team' }]),
			{ orgSlug: 'team' },
			['section'],
		),
	).toBe(true)
	expect(
		requestHasDataFields(
			request(
				['orgSlug', 'section'],
				[
					{ t: 1, s: 'team' },
					{ t: 1, s: 'jobs' },
				],
			),
			{ orgSlug: 'team' },
			['section'],
		),
	).toBe(false)
	expect(
		requestHasDataFields(request(['redirectTo'], [{ t: 2, s: 0 }]), {
			redirectTo: null,
		}),
	).toBe(true)
	expect(
		requestHasDataFields(request(['redirectTo'], [{ t: 2, s: 1 }]), {
			redirectTo: null,
		}),
	).toBe(false)
})
