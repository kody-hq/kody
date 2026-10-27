import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	accessGrantCapability,
	accessListCapability,
	accessRevokeCapability,
} from './access-grants.ts'
import {
	inviteLinkAcceptCapability,
	inviteLinkCreateCapability,
	inviteLinkListCapability,
	inviteLinkRevokeCapability,
} from './invite-links.ts'
import {
	inviteAcceptCapability,
	inviteCreateCapability,
	inviteRevokeCapability,
} from './invites.ts'
import {
	orgCreateCapability,
	orgMemberListCapability,
	orgMemberRemoveCapability,
	orgMemberUpdateCapability,
} from './org-members.ts'
import {
	packageCollaboratorListCapability,
	packageCollaboratorRemoveCapability,
	packageCollaboratorSetCapability,
} from './package-collaborators.ts'
import {
	teamCreateCapability,
	teamListCapability,
	teamMemberAddCapability,
	teamMemberRemoveCapability,
} from './teams.ts'

export const accessDomain = defineDomain({
	name: capabilityDomainNames.access,
	description:
		'Organization access: grants, invites, membership, and teams for the organization this request is bound to.',
	keywords: [
		'access',
		'grant',
		'invite',
		'org',
		'organization',
		'team',
		'member',
		'permission',
	],
	capabilities: [
		accessGrantCapability,
		accessRevokeCapability,
		accessListCapability,
		packageCollaboratorListCapability,
		packageCollaboratorSetCapability,
		packageCollaboratorRemoveCapability,
		inviteCreateCapability,
		inviteAcceptCapability,
		inviteRevokeCapability,
		inviteLinkCreateCapability,
		inviteLinkListCapability,
		inviteLinkRevokeCapability,
		inviteLinkAcceptCapability,
		orgCreateCapability,
		orgMemberListCapability,
		orgMemberUpdateCapability,
		orgMemberRemoveCapability,
		teamListCapability,
		teamCreateCapability,
		teamMemberAddCapability,
		teamMemberRemoveCapability,
	],
})
