import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import {
	profileCreateCapability,
	profileGetCapability,
	profileListCapability,
	profileRevokeCapability,
	profileUpdateCapability,
} from './capabilities.ts'

export const profilesDomain = defineDomain({
	name: capabilityDomainNames.profiles,
	description:
		'Profiles (an experiment: turn it on with experimentSet or at /account/experiments): scoped identities in an org for the agents and bots you run, with a snapshot of grants, an optional expiry that only shortens, sub-profiles up to 5 levels, and a final revoke that stops everything below. To let an agent act as a profile, mint a profile token through the api tool: tokenCreate with profile_id, or profileHandoff for a new sub-profile plus its token (profile tokens are not accepted by /mcp). Guide: guide:profiles.',
	keywords: [
		'profile',
		'profiles',
		'agent identity',
		'bot identity',
		'sub-profile',
		'sub-agent',
		'handoff',
		'profile token',
		'scoped access',
		'expiry',
		'experiment',
	],
	capabilities: [
		profileListCapability,
		profileGetCapability,
		profileCreateCapability,
		profileUpdateCapability,
		profileRevokeCapability,
	],
})
