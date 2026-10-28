import { expect, test } from 'vitest'
import { buildCapabilityRegistry } from '#mcp/capabilities/build-capability-registry.ts'
import { type Capability } from '#mcp/capabilities/types.ts'
import {
	buildDomainIndexMatches,
	buildDomainOverviewMatches,
} from './search-domain-overview.ts'
import { understandSearchQuery } from './understand-search-query.ts'

function capability(
	name: string,
	domain: string,
	description: string,
): Capability {
	return {
		name,
		domain,
		description,
		keywords: [],
		readOnly: true,
		idempotent: true,
		destructive: false,
		orgPermission: 'none',
		contextRuns: 'deny',
		requiresLivePerson: 'never',
		source: 'builtin',
		inputSchema: { type: 'object', properties: {} },
		inputTypeDefinition: '',
		handler: async () => null,
	}
}

const registry = buildCapabilityRegistry([
	{
		name: 'email',
		description: 'Email primitives for the per-user inbox.',
		capabilities: [
			capability('emailSend', 'email', 'Send a message.'),
			capability('emailMessageList', 'email', 'List stored messages.'),
			capability('emailMessageGet', 'email', 'Get one stored message.'),
			capability('emailReply', 'email', 'Reply to a stored message.'),
		],
	},
	{
		name: 'jobs',
		description: 'Schedule durable work.',
		capabilities: [capability('jobList', 'jobs', 'List scheduled jobs.')],
	},
])

function overviewFor(query: string) {
	return buildDomainOverviewMatches({
		intent: understandSearchQuery({ query, entities: [] }),
		capabilityDomains: registry.capabilityDomains,
		capabilitySpecs: registry.capabilitySpecs,
	})
}

test('domain overviews cover named, plural, exploratory, and non-collapse cases', () => {
	expect(
		buildDomainIndexMatches({
			capabilityDomains: registry.capabilityDomains,
			capabilitySpecs: registry.capabilitySpecs,
		}),
	).toEqual([
		expect.objectContaining({
			type: 'domain',
			name: 'email',
			capabilityCount: 4,
		}),
		expect.objectContaining({
			type: 'domain',
			name: 'jobs',
			capabilityCount: 1,
		}),
	])
	expect(overviewFor('what can you do with email')).toEqual([
		{
			type: 'domain',
			name: 'email',
			title: 'email',
			description: 'Email primitives for the per-user inbox.',
			capabilityCount: 4,
			sampleCapabilities: ['emailSend', 'emailMessageList', 'emailMessageGet'],
		},
	])
	expect(overviewFor('email')).toEqual([
		expect.objectContaining({ type: 'domain', name: 'email' }),
	])
	expect(overviewFor('what jobs exist')).toEqual([
		expect.objectContaining({ type: 'domain', name: 'jobs' }),
	])
	expect(overviewFor('job')).toEqual([
		expect.objectContaining({ type: 'domain', name: 'jobs' }),
	])
	expect(overviewFor('what can kody do')).toEqual([
		expect.objectContaining({ type: 'domain', name: 'email' }),
		expect.objectContaining({ type: 'domain', name: 'jobs' }),
	])
	expect(overviewFor('send an email to kent')).toBeNull()
	expect(overviewFor('list unread email from yesterday')).toBeNull()
	expect(overviewFor('spotify playlists')).toBeNull()

	const withoutJobsSpecs = Object.fromEntries(
		Object.entries(registry.capabilitySpecs).filter(
			([, spec]) => spec.domain !== 'jobs',
		),
	)
	expect(
		buildDomainOverviewMatches({
			intent: understandSearchQuery({
				query: 'what can kody do',
				entities: [],
			}),
			capabilityDomains: registry.capabilityDomains,
			capabilitySpecs: withoutJobsSpecs,
		}),
	).toEqual([expect.objectContaining({ type: 'domain', name: 'email' })])
	expect(
		buildDomainOverviewMatches({
			intent: understandSearchQuery({ query: 'email', entities: [] }),
			capabilityDomains: [],
			capabilitySpecs: registry.capabilitySpecs,
		}),
	).toBeNull()
})
