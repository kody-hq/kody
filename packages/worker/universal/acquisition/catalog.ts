import { n8nAlternatives } from './n8nAlternatives.ts'
import { mcpGateway } from './mcpGateway.ts'
import { sharedMemory } from './sharedMemory.ts'
import { gmail } from './gmail.ts'
import { customTools } from './customTools.ts'
import { composioAlternatives } from './composioAlternatives.ts'
import { slack } from './slack.ts'
import { scheduledWorkflows } from './scheduledWorkflows.ts'
import { claudeIntegrations } from './claudeIntegrations.ts'
import { automation } from './automation.ts'
import type { AcquisitionPage } from './types.ts'

export const acquisitionPages: Array<AcquisitionPage> = [
	n8nAlternatives,
	mcpGateway,
	sharedMemory,
	gmail,
	customTools,
	composioAlternatives,
	slack,
	scheduledWorkflows,
	claudeIntegrations,
	automation,
]
