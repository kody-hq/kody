import { expect, test } from 'vitest'
import {
	requiresSessionVerification,
	type SessionVerificationPolicy,
} from './session-verification-policy.ts'
const match = (
	policy?: SessionVerificationPolicy,
	params: Record<string, unknown> = {},
) => ({ staticData: { sessionVerification: policy }, params })
test('new and unknown routes require verification and cannot inherit a public parent exemption', () => {
	expect(requiresSessionVerification([])).toBe(true)
	expect(requiresSessionVerification([match()])).toBe(true)
	expect(requiresSessionVerification([match('public'), match()])).toBe(true)
	expect(
		requiresSessionVerification([{ ...match('public'), globalNotFound: true }]),
	).toBe(true)
	expect(
		requiresSessionVerification([match('public'), match('required')]),
	).toBe(true)
})
test('a route can explicitly identify public content without matching its URL again', () => {
	expect(requiresSessionVerification([match(), match('public')])).toBe(false)
})
test('docs use decoded native params and their authoritative public catalog', () => {
	for (const slug of ['what-is-kody', 'integration-backed-app-happy-path'])
		expect(requiresSessionVerification([match('public-doc', { slug })])).toBe(
			false,
		)
	for (const slug of ['admin-events', 'unknown', '%invalid'])
		expect(requiresSessionVerification([match('public-doc', { slug })])).toBe(
			true,
		)
	expect(requiresSessionVerification([match('public-doc')])).toBe(true)
})
