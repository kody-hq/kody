import { describe, expect, test } from 'vitest'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import {
	normalizeRunStartedBy,
	runStartedByFromRequest,
} from './run-started-by.ts'

const person = {
	userId: personIdFromStored('person-alice'),
	username: 'alice',
}

describe('runStartedByFromRequest', () => {
	test('stamps interactive MCP callers with username and mcp client', () => {
		const request = deriveRequestContext({
			user: person,
			source: { kind: 'mcp-oauth' },
			profileName: 'work',
		})
		expect(runStartedByFromRequest(request)).toEqual({
			userId: person.userId,
			username: 'alice',
			client: 'mcp',
			label: 'work',
		})
	})

	test('prefers an explicit token name label over profile name', () => {
		const request = deriveRequestContext({
			user: person,
			source: { kind: 'api-token', tokenId: 'tok_1' },
			profileName: 'profile-a',
		})
		expect(runStartedByFromRequest(request, { label: 'ci-bot' })).toEqual({
			userId: person.userId,
			username: 'alice',
			client: 'api-token',
			label: 'ci-bot',
		})
	})

	test('records the enablement owner for scheduled background runs', () => {
		const request = deriveRequestContext({
			user: person,
			source: {
				kind: 'schedule',
				jobId: 'job-1',
				enablement: {
					id: 'en_1',
					enabler: {
						userId: personIdFromStored('person-bob'),
						username: 'bob',
					},
					role: 'member',
				},
			},
		})
		expect(runStartedByFromRequest(request)).toEqual({
			userId: personIdFromStored('person-bob'),
			username: 'bob',
			client: 'schedule',
			label: null,
		})
	})

	test('returns null without a request', () => {
		expect(runStartedByFromRequest(null)).toBeNull()
		expect(normalizeRunStartedBy(null)).toBeNull()
		expect(
			normalizeRunStartedBy({
				userId: 'x',
				username: 'y',
				client: 'not-a-client' as 'mcp',
				label: null,
			}),
		).toBeNull()
	})
})

describe('profile attribution', () => {
	test('records the profile id and its chain from the credential', () => {
		const request = deriveRequestContext({
			user: person,
			source: { kind: 'api-token', tokenId: 'tok_1' },
			profileId: 'prof_child',
			profileChain: ['prof_root', 'prof_child'],
		})
		expect(runStartedByFromRequest(request)).toMatchObject({
			profileId: 'prof_child',
			profileChain: ['prof_root', 'prof_child'],
		})
	})

	test('a chain that does not end at the profile falls back to the profile', () => {
		expect(
			normalizeRunStartedBy({
				userId: person.userId,
				username: 'alice',
				client: 'api-token',
				label: null,
				profileId: 'prof_child',
				profileChain: ['prof_other'],
			}),
		).toMatchObject({ profileId: 'prof_child', profileChain: ['prof_child'] })
	})

	test('person runs carry no profile', () => {
		const request = deriveRequestContext({
			user: person,
			source: { kind: 'api-token', tokenId: 'tok_1' },
		})
		expect(runStartedByFromRequest(request)).not.toHaveProperty('profileId')
	})
})
