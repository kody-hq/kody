import { expect, test } from 'vitest'
import { http, HttpResponse } from 'msw'
import {
	type KitSignupError,
	KIT_API_BASE_URL,
	tagExistingKitSubscriberOnSignup,
} from '#app/kit-signup.ts'
import { createMswNodeServer } from '#worker/test-support/msw-node-server.ts'

type KitCall = {
	url: string
	method: string
	body: unknown
	apiKey: string | null
}

type RecordedHttpRequest = {
	url: string
	method: string
	headers: { get(name: string): string | null }
	clone(): { json(): Promise<unknown> }
}

async function recordKitCall(
	request: RecordedHttpRequest,
	calls: Array<KitCall>,
) {
	calls.push({
		url: request.url,
		method: request.method,
		body:
			request.method === 'GET' || request.method === 'DELETE'
				? null
				: await request.clone().json(),
		apiKey: request.headers.get('X-Kit-Api-Key'),
	})
}

test('tagExistingKitSubscriberOnSignup tags existing subscribers, skips unknowns, and classifies client failures', async () => {
	const existingCalls: Array<KitCall> = []
	using msw = createMswNodeServer([
		http.get(`${KIT_API_BASE_URL}/subscribers`, async ({ request }) => {
			await recordKitCall(request, existingCalls)
			const email = new URL(request.url).searchParams.get('email_address')
			if (email === 'ada@example.com') {
				return HttpResponse.json({
					subscribers: [
						{
							id: 9,
							email_address: 'ada@example.com',
							first_name: 'Ada',
						},
					],
				})
			}
			if (email === 'new@example.com') {
				return HttpResponse.json({ subscribers: [] })
			}
			return HttpResponse.json({ errors: ['unexpected'] }, { status: 500 })
		}),
		http.post(
			`${KIT_API_BASE_URL}/tags/:tagId/subscribers`,
			async ({ request }) => {
				await recordKitCall(request, existingCalls)
				return HttpResponse.json(
					{ subscriber: { id: 9, email_address: 'ada@example.com' } },
					{ status: 201 },
				)
			},
		),
	])

	const tagged = await tagExistingKitSubscriberOnSignup({
		apiKey: 'key',
		email: 'ada@example.com',
		tagId: 123,
	})
	expect(tagged).toEqual({ tagged: true, subscriberId: 9 })
	expect(existingCalls.map((call) => call.method)).toEqual(['GET', 'POST'])
	expect(existingCalls.every((call) => call.apiKey === 'key')).toBe(true)
	expect(existingCalls[1]).toMatchObject({
		url: `${KIT_API_BASE_URL}/tags/123/subscribers`,
		method: 'POST',
		body: { email_address: 'ada@example.com' },
	})
	expect(
		existingCalls.some(
			(call) =>
				call.method === 'POST' &&
				call.url === `${KIT_API_BASE_URL}/subscribers`,
		),
	).toBe(false)

	const missingBefore = existingCalls.length
	expect(
		await tagExistingKitSubscriberOnSignup({
			apiKey: 'key',
			email: 'new@example.com',
			tagId: 123,
		}),
	).toEqual({ tagged: false, reason: 'not_found' })
	expect(existingCalls.length - missingBefore).toBe(1)

	msw.use(
		http.get(`${KIT_API_BASE_URL}/subscribers`, () =>
			HttpResponse.json({ errors: ['invalid'] }, { status: 422 }),
		),
	)
	await expect(
		tagExistingKitSubscriberOnSignup({
			apiKey: 'key',
			email: 'ada@example.com',
		}),
	).rejects.toMatchObject({
		name: 'KitSignupError',
		kind: 'client',
		status: 422,
	} satisfies Partial<KitSignupError>)
})
