import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { type DeclaredTrigger } from '#worker/enablements/service.ts'
import {
	type EnablementRecord,
	type EnablementSenderKind,
} from '#worker/enablements/types.ts'
import { viewerEnablement } from './package-credential-mappings.ts'

const actorId = personIdFromStored('b'.repeat(64))

function emailRow(input: {
	id: string
	senderKind: EnablementSenderKind | null
	senderValue: string | null
}): EnablementRecord {
	return {
		id: input.id,
		orgId: ownerIdFromStored('a'.repeat(64)),
		packageId: 'pkg',
		triggerKind: 'subscription',
		triggerName: 'email.message.received',
		instanceId: 'pkg',
		enablerUserId: actorId,
		enablerScopes: null,
		enablerProfileName: null,
		enablerProfileId: null,
		state: 'on',
		pause: null,
		origin: 'enabled',
		senderKind: input.senderKind,
		senderValue: input.senderValue,
		enabledAt: '2026-10-14T00:00:00.000Z',
		disabledAt: null,
		updatedAt: '2026-10-14T00:00:00.000Z',
	}
}

function emailTrigger(enablements: Array<EnablementRecord>): DeclaredTrigger {
	return {
		kind: 'subscription',
		name: 'email.message.received',
		instanceId: 'pkg',
		enablements,
	}
}

test('an inbound-email topic with several of the viewer rows and no sender matches none', () => {
	const first = emailRow({
		id: 'sender-a',
		senderKind: 'address',
		senderValue: 'a@example.com',
	})
	const second = emailRow({
		id: 'sender-b',
		senderKind: 'address',
		senderValue: 'b@example.com',
	})
	expect(viewerEnablement(emailTrigger([first, second]), actorId)).toEqual({
		enablement: null,
		otherEnabler: false,
	})
	expect(
		viewerEnablement(emailTrigger([first, second]), actorId, {
			kind: 'address',
			value: 'b@example.com',
		}),
	).toEqual({ enablement: second, otherEnabler: false })
})

test('one inbound-email row is that sender when the caller omits sender', () => {
	const only = emailRow({
		id: 'only',
		senderKind: 'member',
		senderValue: actorId,
	})
	expect(viewerEnablement(emailTrigger([only]), actorId)).toEqual({
		enablement: only,
		otherEnabler: false,
	})
})

test('a non-email subscription still uses the viewer first row when sender is omitted', () => {
	const first = emailRow({
		id: 'first',
		senderKind: null,
		senderValue: null,
	})
	const second = emailRow({
		id: 'second',
		senderKind: null,
		senderValue: null,
	})
	const trigger: DeclaredTrigger = {
		kind: 'subscription',
		name: 'acme.thing.happened',
		instanceId: 'pkg',
		enablements: [first, second],
	}
	expect(viewerEnablement(trigger, actorId)).toEqual({
		enablement: first,
		otherEnabler: false,
	})
})
