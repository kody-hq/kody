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
	personalOrgId: null,
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
						personalOrgId: null,
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
