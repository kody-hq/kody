import { expect, test } from 'vitest'
import {
	credentialMappingChangesSchema,
	credentialProposalSchema,
} from './credential-mutations.ts'
import { parseCredentialApprovalQuery } from './credential-contracts.ts'

test('typed proposals preserve parsed URL meaning and reject invalid sender identities', () => {
	const parsed = parseCredentialApprovalQuery(
		new URLSearchParams(
			'mine[mail]=resend-prod&enable=webhook:incoming&reason=Digest',
		),
	)
	expect(credentialProposalSchema.parse(parsed)).toEqual(parsed)
	expect(
		credentialProposalSchema.safeParse({
			...parsed,
			sender: { kind: 'member', value: 'not-a-person-id' },
		}).success,
	).toBe(false)
	expect(
		credentialProposalSchema.safeParse({
			...parsed,
			sender: { kind: 'domain', value: '*.example.com' },
		}).success,
	).toBe(false)
})
test('mapping validation distinguishes inheritance from intentionally empty picks and rejects unknown authority fields', () => {
	const change = { target: { type: 'default', layer: 'mine' }, needKey: 'mail' }
	for (const credentials of [null, []]) {
		expect(
			credentialMappingChangesSchema.parse({
				changes: [{ ...change, credentials }],
			}).changes[0]?.credentials,
		).toEqual(credentials)
	}
	expect(
		credentialMappingChangesSchema.safeParse({
			changes: [
				{
					...change,
					credentials: [{ id: 'secret-id', ownerId: 'other-person' }],
				},
			],
		}).success,
	).toBe(false)
	expect(
		credentialMappingChangesSchema.safeParse({ changes: [] }).success,
	).toBe(false)
})

test('typed approval preserves the exact minted endpoint and rejects malformed endpoint refs', () => {
	const parsed = parseCredentialApprovalQuery(
		new URLSearchParams('enable=webhook:incoming:endpoint-staging'),
	)
	expect(credentialProposalSchema.parse(parsed)).toEqual(parsed)
	expect(credentialProposalSchema.parse(parsed).enable).toEqual([
		{ kind: 'webhook', name: 'incoming', endpointId: 'endpoint-staging' },
	])
	for (const ref of [
		{ kind: 'webhook', name: 'incoming', endpointId: '' },
		{ kind: 'cron', name: 'daily', endpointId: 'endpoint-staging' },
		{
			kind: 'webhook',
			name: 'incoming',
			endpointId: 'endpoint-staging',
			ownerId: 'other',
		},
	]) {
		expect(
			credentialProposalSchema.safeParse({ ...parsed, enable: [ref] }).success,
		).toBe(false)
	}
})

test('mapping inputs retain the selected webhook endpoint without accepting caller authority', () => {
	const trigger = {
		kind: 'webhook',
		name: 'incoming',
		endpointId: 'endpoint-staging',
	}
	const changes = [
		{
			target: { type: 'trigger', trigger },
			needKey: 'github',
			credentials: [],
		},
	]
	expect(credentialMappingChangesSchema.parse({ changes })).toEqual({ changes })
	expect(
		credentialMappingChangesSchema.safeParse({
			changes: [
				{
					...changes[0],
					target: {
						type: 'trigger',
						trigger: { ...trigger, ownerId: 'other' },
					},
				},
			],
		}).success,
	).toBe(false)
})
