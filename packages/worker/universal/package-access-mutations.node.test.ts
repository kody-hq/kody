import { expect, test } from 'vitest'
import {
	grantPackageCollaboratorInput,
	revokePackageCollaboratorInput,
	packageWebhookInput,
} from './package-access-mutations.ts'
const identity = { username: 'team', kodyId: 'repo' }

test('named package access inputs cannot carry an operation dispatch field', () => {
	expect(
		grantPackageCollaboratorInput.parse({
			...identity,
			subjectType: 'user',
			subjectId: 'person',
			preset: 'use',
			intent: 'revoke',
		}),
	).toEqual({
		...identity,
		subjectType: 'user',
		subjectId: 'person',
		preset: 'use',
	})
	expect(
		revokePackageCollaboratorInput.parse({
			...identity,
			grantId: 'grant',
			intent: 'grant',
		}),
	).toEqual({ ...identity, grantId: 'grant' })
	expect(
		packageWebhookInput.parse({
			...identity,
			webhookName: ' hook ',
			intent: 'delete',
		}),
	).toEqual({ ...identity, webhookName: 'hook' })
})

test('package webhook and collaborator inputs require explicit valid resource identities', () => {
	expect(
		packageWebhookInput.safeParse({ ...identity, webhookName: ' ' }).success,
	).toBe(false)
	expect(
		packageWebhookInput.safeParse({
			...identity,
			username: '../other',
			webhookName: 'hook',
		}).success,
	).toBe(false)
	expect(
		grantPackageCollaboratorInput.safeParse({
			...identity,
			subjectType: 'invite',
			subjectId: 'person',
			preset: 'use',
		}).success,
	).toBe(false)
	expect(
		revokePackageCollaboratorInput.safeParse({ ...identity, grantId: '' })
			.success,
	).toBe(false)
})
