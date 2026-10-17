import { expect, test } from 'vitest'
import {
	connectOauthInput,
	connectOauthSchema,
	connectSecretsInput,
	connectWebhookInput,
	connectSecretsSchema,
} from './connect-input.ts'

test('connect reads preserve first-value and repeated approval query semantics', () => {
	const search =
		'?org=team&org=other&name=ONE&name=TWO&host=a&hosts=b,c&selected=user%3A%3A%3A%3ATOKEN&state=opaque&state=second'
	const input = connectSecretsInput(search)
	expect(input.orgSlug).toBe('team')
	expect(input.selectedSecretId).toBe('user::::TOKEN')
	expect(input.approval.names).toEqual(['ONE', 'TWO'])
	expect(input.approval.hosts).toEqual(['b,c', 'a'])
	expect(new URLSearchParams(input.search).getAll('state')).toEqual([
		'opaque',
		'second',
	])
	expect(
		connectSecretsSchema.safeParse({ ...input, orgSlug: '../other' }).success,
	).toBe(false)
})
test('OAuth callback and setup fields remain distinct from navigation state', () => {
	expect(connectOauthInput('?code=first&code=second&state=s')).toMatchObject({
		code: 'first',
		provider: undefined,
	})
	expect(connectOauthInput('?provider=work&app=google&org=team')).toMatchObject(
		{ provider: 'work', appSlug: 'google', orgSlug: 'team' },
	)
	expect(
		connectWebhookInput('?handle=%20abc%20&fingerprint=%20def%20'),
	).toMatchObject({ handle: 'abc', fingerprint: 'def' })
})

test.each(['?org=', '?org=%20%20', '?org=../other', '?org=team%2Fother'])(
	'OAuth rejects explicit malformed scope %s',
	(search) => {
		expect(
			connectOauthSchema.safeParse(connectOauthInput(search)).success,
		).toBe(false)
	},
)
test('OAuth accepts absent personal scope and preserves valid first organization scope', () => {
	expect(
		connectOauthSchema.parse(connectOauthInput('?provider=github')).orgSlug,
	).toBeUndefined()
	expect(
		connectOauthSchema.parse(connectOauthInput('?org=%20team%20&org=other'))
			.orgSlug,
	).toBe('team')
})
