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
		'Profiles (an experiment: turn it on with experimentSet or at /account/experiments): scoped identities in an org for the agents and bots you run, with a snapshot of grants, an optional expiry that only shortens, sub-profiles up to 5 levels, and a final revoke that stops everything below. Guide: guide:profiles.',
	keywords: [
		'profile',
		'profiles',
		'agent identity',
		'bot identity',
		'sub-profile',
		'sub-agent',
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
