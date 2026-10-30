import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import {
	executionChainGetCapability,
	executionChainSetCapability,
	executionContextAttachCapability,
	executionContextAuditListCapability,
	executionContextDetachCapability,
	executionContextGetCapability,
	executionContextListCapability,
	executionContextOptInCapability,
	executionContextOptOutCapability,
	executionContextRevokeCapability,
	executionContextDeleteCapability,
	executionContextRunListCapability,
	executionContextShareListCapability,
	executionContextShareRemoveCapability,
	executionContextShareSetCapability,
	executionContextUpdateCapability,
} from './capabilities.ts'
import {
	automationExecutionGetCapability,
	automationExecutionSetCapability,
} from './automation-execution.ts'

export const executionContextsDomain = defineDomain({
	name: capabilityDomainNames.executionContexts,
	description:
		'Execution contexts: machines running `kody daemon` that execute runs instead of Kody cloud, their sharing, and your per-org fallback chain. Behind the execution-contexts feature flag.',
	keywords: [
		'execution context',
		'machine',
		'daemon',
		'chain',
		'fallback',
		'local',
		'lan',
		'filesystem',
	],
	capabilities: [
		executionContextListCapability,
		executionContextGetCapability,
		executionContextUpdateCapability,
		executionContextRevokeCapability,
		executionContextDeleteCapability,
		executionContextOptInCapability,
		executionContextOptOutCapability,
		executionContextShareListCapability,
		executionContextShareSetCapability,
		executionContextShareRemoveCapability,
		executionContextAttachCapability,
		executionContextDetachCapability,
		executionContextRunListCapability,
		executionContextAuditListCapability,
		executionChainGetCapability,
		executionChainSetCapability,
		automationExecutionGetCapability,
		automationExecutionSetCapability,
	],
})
