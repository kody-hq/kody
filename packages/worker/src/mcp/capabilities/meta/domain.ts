import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { metaMemoryDeleteCapability } from './meta-memory-delete.ts'
import { metaMemoryGetCapability } from './meta-memory-get.ts'
import { metaMemorySearchCapability } from './meta-memory-search.ts'
import { metaMemoryUpsertCapability } from './meta-memory-upsert.ts'
import { metaMemoryVerifyCapability } from './meta-memory-verify.ts'
import { metaPlatformFeedbackGetCapability } from './meta-platform-feedback-get.ts'
import { metaPlatformFeedbackListCapability } from './meta-platform-feedback-list.ts'
import { metaPlatformFeedbackSubmitCapability } from './meta-platform-feedback-submit.ts'
import { metaGetCurrentUserCapability } from './meta-get-current-user.ts'
import { metaGetMcpServerInstructionsCapability } from './meta-get-mcp-server-instructions.ts'
import { executeCapability } from './execute.ts'
import { metaListCapabilitiesCapability } from './meta-list-capabilities.ts'
import { metaSetMcpServerInstructionsCapability } from './meta-set-mcp-server-instructions.ts'
import { searchCapability } from './search.ts'
import { cliCredentialBootstrapCapability } from './cli-credential-bootstrap.ts'
import {
	experimentListCapability,
	experimentSetCapability,
} from './experiments.ts'

export const metaDomain = defineDomain({
	name: capabilityDomainNames.meta,
	description:
		'Registry inspection, memories, search/execute workflows, feedback, and self-serve experiments.',
	keywords: [
		'meta',
		'kody',
		'capabilities',
		'memory',
		'verify',
		'platform feedback',
		'friction',
		'bug report',
		'suggestion',
		'feedback status',
		'cli',
		'bootstrap',
		'experiments',
		'feature flag',
		'opt in',
	],
	capabilities: [
		searchCapability,
		executeCapability,
		metaListCapabilitiesCapability,
		metaGetCurrentUserCapability,
		metaGetMcpServerInstructionsCapability,
		metaSetMcpServerInstructionsCapability,
		metaMemorySearchCapability,
		metaMemoryGetCapability,
		metaMemoryVerifyCapability,
		metaMemoryUpsertCapability,
		metaMemoryDeleteCapability,
		metaPlatformFeedbackSubmitCapability,
		metaPlatformFeedbackGetCapability,
		metaPlatformFeedbackListCapability,
		cliCredentialBootstrapCapability,
		experimentListCapability,
		experimentSetCapability,
	],
})
