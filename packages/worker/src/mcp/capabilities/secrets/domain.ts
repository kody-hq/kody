import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { credentialListCapability } from './credential-list.ts'
import { credentialMappingProposeCapability } from './credential-mapping-propose.ts'
import { credentialPlacementApprovalLinkCapability } from './credential-placement-approval-link.ts'
import {
	credentialOrgGrantCapability,
	credentialOrgGrantListCapability,
	credentialOrgRevokeCapability,
} from './credential-org-grants.ts'
import { credentialTriggerPickSetCapability } from './credential-trigger-pick-set.ts'
import { credentialUpdateCapability } from './credential-update.ts'
import { jwtSignCapability } from './jwt-sign.ts'
import { secretDeleteCapability } from './secret-delete.ts'
import { secretDisconnectCapability } from './secret-disconnect.ts'
import { secretListCapability } from './secret-list.ts'
import { secretProviderBindCapability } from './secret-provider-bind.ts'
import { secretProviderListCapability } from './secret-provider-list.ts'
import { secretProviderUnbindCapability } from './secret-provider-unbind.ts'
import { secretSetCapability } from './secret-set.ts'
import { secretSetManyCapability } from './secret-set-many.ts'
import { resourceLockCapability } from './resource-lock.ts'

export const secretsDomain = defineDomain({
	name: capabilityDomainNames.secrets,
	description:
		'Server-side secret references (never paste secret values into chat).',
	keywords: [
		'secret',
		'credentials',
		'reference',
		'secure input',
		'lock',
		'usage',
		'integration',
		'mcp server',
	],
	capabilities: [
		secretListCapability,
		secretSetCapability,
		secretSetManyCapability,
		resourceLockCapability,
		secretProviderListCapability,
		secretProviderBindCapability,
		secretProviderUnbindCapability,
		secretDisconnectCapability,
		secretDeleteCapability,
		credentialListCapability,
		credentialUpdateCapability,
		credentialPlacementApprovalLinkCapability,
		credentialMappingProposeCapability,
		credentialOrgGrantCapability,
		credentialOrgRevokeCapability,
		credentialOrgGrantListCapability,
		credentialTriggerPickSetCapability,
		jwtSignCapability,
	],
})
