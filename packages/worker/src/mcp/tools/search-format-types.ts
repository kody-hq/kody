import { type IntegrationConfig } from '#mcp/capabilities/integrations/integration-shared.ts'
import { type CapabilitySpec } from '#mcp/capabilities/types.ts'
import { type SecretSearchRow } from '#mcp/secrets/types.ts'
import {
	type AuthoredPackageJson,
	type SavedPackageRecord,
} from '#worker/package-registry/types.ts'

export const searchEntityRefTypes = [
	'capability',
	'guide',
	'integration',
	'mcp-server',
	'package',
	'secret',
] as const

export const jevSearchRerankOutcomes = [
	'applied',
	'fallback-error',
	'fallback-timeout',
	'fallback-low-confidence',
	'fallback-empty-after-drop',
	'skipped-offline',
	'skipped-no-ai',
	'skipped-plan',
	'skipped-small-pool',
	'skipped-clear-winner',
	'skipped-empty',
] as const

export type JevSearchRerankOutcome = (typeof jevSearchRerankOutcomes)[number]

export type SearchEntityType = (typeof searchEntityRefTypes)[number]

type SearchMatchType =
	| 'capability'
	| 'guide'
	| 'package'
	| 'integration'
	| 'secret'
	| 'domain'
	| 'mcp-server'

export type PackageActionMatch = {
	subpath: string
	description: string | null
	typeDefinition: string | null
	functions: Array<{
		name: string
		description: string | null
		typeDefinition: string | null
	}>
	score: number
	matchedTerms: Array<string>
	/**
	 * Tokens matched against export-local fields only (excludes parent package
	 * identity). Nested display and first-pass promotion require at least one
	 * so package aliases boost siblings without promoting identity-only hits.
	 * When omitted (older fixtures), treat all `matchedTerms` as export-local.
	 */
	exportLocalMatchedTermCount?: number
}

export type SearchResultStructuredContent = {
	matches: Array<SlimSearchMatch>
	offline: boolean
	warnings: Array<string>
	guidance?: string
	telemetry?: {
		intent: {
			task: string
			confidence: number
			entityCount: number
			actionCount: number
			constraintCount: number
			topEntities: Array<{
				type: string
				id: string
				confidence: number
			}>
		}
		candidateCounts: Partial<Record<SearchMatchType, number>>
		topResultTypes: Array<SearchMatchType>
		trimmedMatchCount?: number
		responseTrimmed?: boolean
		jevRerank?: {
			enabled: boolean
			outcome: JevSearchRerankOutcome
			candidatesBefore: number
			candidatesAfter: number
			droppedCount: number
			meanConfidence: number | null
			top1Type: SearchMatchType | null
			/**
			 * Adaptive keep path after Jev Score (`kept-high` |
			 * `kept-lowered` | `kept-identity` | `empty`). Present when Score
			 * ran successfully. `kept-identity` is the empty-list exception
			 * for package name / kody id / leaf hits.
			 */
			keepPath?: 'kept-high' | 'kept-lowered' | 'kept-identity' | 'empty'
			/** Present only when `outcome` is `fallback-error`. */
			errorReason?: string
			/** Present when the Jev stage ran or attempted. */
			model?: 'typesafe/jev'
			/** Score `AI.run` count (one per question batch). */
			aiCallCount?: number
			usage?: {
				inputTokens: number | null
				outputTokens: number | null
			}
		}
	}
	waiting?: {
		count: number
		items: Array<{
			id: string
			kind: string
			title: string
			why: string
			doLabel: string
			href: string
			severity: string
		}>
	}
	phaseTimings?: {
		queryUnderstandingMs: number
		candidateGenerationMs: number
		rerankingMs: number
		jevRerankMs?: number
		formattingMs?: number
		rowAndRegistryLoadMs?: number
		queryEmbeddingMs?: number
		capabilityCandidatesMs?: number
		packageCandidatesMs?: number
		memoryEnrichmentMs?: number
		memoryEnrichmentWaitMs?: number
		memoryAcknowledgementMs?: number
		memoryEnrichmentTimedOut?: boolean
		memoryAcknowledgementTimedOut?: boolean
		memoryEnrichmentFailed?: boolean
		memoryAcknowledgementFailed?: boolean
		waitingItemsTimedOut?: boolean
		onboardingNoticeTimedOut?: boolean
		usernameLookupMs?: number
		identityResolutionMs?: number
		loadAndRankMs?: number
		searchUnifiedMs?: number
		entityResolveMs?: number
		firstSearchStampMs?: number
		onboardingNoticeMs?: number
		waitingItemsMs?: number
		exclusiveMs?: number
		unaccountedMs?: number
	}
	memories?: {
		surfaced: Array<{
			id: string
			subject: string
			summary: string
		}>
		suppressedCount: number
		retrievalQuery: string
	}
}

export type RelatedCapabilityOperation = {
	name: string
	entityRef: string
	description: string
	method?: string
	path?: string
}

export type RelatedIntegrationPackageSuggestion =
	| {
			source: 'user'
			kodyId: string
			name: string
			description: string
			entityRef: string
	  }
	| {
			source: 'community'
			kodyId: string
			name: string
			description: string
			listingId: string
			publicUrl: string
			trusted: boolean
	  }

export type SlimSearchMatch =
	| {
			type: 'domain'
			id: string
			name: string
			title: string
			description: string
			capabilityCount: number
			sampleCapabilities: Array<string>
			usage: string
	  }
	| {
			type: 'mcp-server'
			id: string
			entityRef: string
			title: string
			description: string
			domain: string
			source: 'mcp-server'
			kodyName: string
			serverName: string
			instructions: string | null
			capabilityCount: number
			sampleCapabilities: Array<string>
			usage: string
			wrappingPackage: {
				kodyId: string
				name: string
				entityRef: string
			} | null
	  }
	| {
			type: 'capability'
			id: string
			entityRef: string
			title: string
			description: string
			domain: string
			usage: string
			/** False when Open API / MCP `api` does not accept this name. */
			apiAvailable: boolean
			source?: CapabilitySpec['source']
			mcpServer?: CapabilitySpec['mcpServer']
			inputTypeDefinition?: string
			inputTypeDefinitionTruncated?: boolean
	  }
	| {
			type: 'guide'
			id: string
			entityRef: string
			title: string
			description: string
			usage: string
			category: 'platform' | 'provider'
			slug: string
			provider: string | null
	  }
	| {
			type: 'package'
			id: string
			entityRef: string
			packageId: string
			kodyId: string
			title: string
			description: string
			usage: string
			rootImportUsage: string
			tags: Array<string>
			hasApp: boolean
			hidden: boolean
			hostedUrl: string | null
			readmeSnippet: {
				path: string
				snippet: string
				truncated: boolean
			} | null
			/**
			 * Present when this ranked hit is a package export contract
			 * (`package:{id}#{subpath}`), not the package index.
			 */
			exportSubpath?: string
			actionMatches: Array<{
				subpath: string
				importSpecifier: string
				description: string | null
				typeDefinition: string | null
				functions: Array<{
					name: string
					description: string | null
					typeDefinition: string | null
					usage: string
				}>
				score: number
				matchedTerms: Array<string>
			}>
			/**
			 * Present on high-confidence top export hits: import path +
			 * signature/types (same substance as entity export detail).
			 */
			exportCallContract?: {
				importSpecifier: string
				usage: string
				executeExample: string
				typeDefinition: string | null
				typeDefinitionTruncated?: boolean
				functions: Array<{
					name: string
					description: string | null
					typeDefinition: string | null
				}>
			}
			nextStep?: string
			listingAhead?: true
	  }
	| {
			type: 'secret'
			id: string
			entityRef: string
			title: string
			description: string
			usage: string
	  }
	| {
			type: 'integration'
			id: string
			entityRef: string
			name: string
			title: string
			description: string
			usage: string
			flow: string
			tokenUrl: string
			apiBaseUrl: string | null
			requiredHosts: Array<string>
			clientId: string
			authorization: IntegrationConfig['authorization'] | null
			nextStep?: string
	  }

export type SearchEntityDetailStructured =
	| {
			kind: 'entity'
			type: 'capability'
			id: string
			entityRef: string
			title: string
			description: string
			usage: string
			/** False when Open API / MCP `api` does not accept this name. */
			apiAvailable: boolean
			executeExample: string
			requiredInputFields: Array<string>
			readOnly: boolean
			idempotent: boolean
			destructive: boolean
			source: CapabilitySpec['source']
			mcpServer?: CapabilitySpec['mcpServer']
			inputTypeDefinition: string
			outputTypeDefinition?: string
			relatedOperations?: Array<RelatedCapabilityOperation>
			relatedOperationCount?: number
	  }
	| {
			kind: 'entity'
			type: 'guide'
			id: string
			entityRef: string
			title: string
			description: string
			usage: string
			category: 'platform' | 'provider'
			slug: string
			body: string
			bodyMode: 'full' | 'toc' | 'section' | 'lines'
			section: {
				title: string
				slug: string
			} | null
			lines: {
				startLine: number
				endLine: number
				requestedStartLine: number
				requestedEndLine: number
				totalLines: number
			} | null
			sections: Array<{
				title: string
				slug: string
				level: number
				entityRef: string
			}>
			provider: string | null
			lastVerified: string | null
	  }
	| {
			kind: 'entity'
			type: 'package'
			detailMode: 'index'
			id: string
			entityRef: string
			title: string
			description: string
			usage: string
			packageId: string
			kodyId: string
			name: string
			tags: Array<string>
			hasApp: boolean
			hidden: boolean
			hostedUrl: string | null
			appEntry: string | null
			maintain: {
				gitLane: string
				publish: string
				sourceSession: string
			}
			exports: Array<{
				subpath: string
				description: string | null
			}>
			jobs: Array<{
				name: string
			}>
			webhooks: Array<{
				name: string
				exportName: string
				responseMode: 'ack' | 'sync'
				inputMode: 'request' | 'params'
				rateLimitPerMinute: number
				replay: {
					timestampHeader?: string
					timestampFormat?:
						| 'unix-seconds'
						| 'unix-millis'
						| 'iso-8601'
						| 'stripe-signature'
					toleranceSeconds?: number
					deliveryIdHeader?: string
				} | null
				signedPayload: 'body' | 'timestamp.body' | null
			}>
			readmeIntent: {
				path: string
				content: string
				truncated: boolean
			} | null
			agentsDocs: {
				path: string
				content: string
				truncated: boolean
			} | null
			followUp: string
			listingAhead: boolean | null
	  }
	| {
			kind: 'entity'
			type: 'package'
			detailMode: 'export'
			id: string
			entityRef: string
			title: string
			description: string
			usage: string
			packageId: string
			kodyId: string
			name: string
			importSpecifier: string
			executeExample: string
			typeDefinition: string | null
			functions: Array<{
				name: string
				description: string | null
				typeDefinition: string | null
			}>
			referencedTypes: Array<{
				name: string
				kind: 'type' | 'interface' | 'enum'
				definition: string | null
			}>
			example: string | null
			followUp: string
			hidden: boolean
			referencedTypesTruncated?: true
	  }
	| {
			kind: 'entity'
			type: 'package'
			detailMode: 'file'
			id: string
			entityRef: string
			title: string
			description: string
			usage: string
			packageId: string
			kodyId: string
			name: string
			path: string
			content: string
			truncated: boolean
			anchor: {
				kind: 'lines' | 'heading'
				requested: string
				startLine: number
				endLine: number
				requestedStartLine: number
				requestedEndLine: number
				totalLines: number
				heading: {
					title: string
					slug: string
					level: number
				} | null
			} | null
	  }
	| {
			kind: 'entity'
			type: 'secret'
			id: string
			entityRef: string
			title: string
			description: string
			usage: string
			scope: string
			updatedAt: string
	  }
	| {
			kind: 'entity'
			type: 'integration'
			id: string
			entityRef: string
			title: string
			description: string
			usage: string
			flow: IntegrationConfig['flow']
			tokenUrl: string
			apiBaseUrl: string | null
			clientId: string
			requiredHosts: Array<string>
			authorization: IntegrationConfig['authorization'] | null
			relatedPackageSuggestions?: Array<RelatedIntegrationPackageSuggestion>
	  }
	| {
			kind: 'entity'
			type: 'mcp-server'
			id: string
			entityRef: string
			title: string
			description: string
			usage: string
			domain: string
			kodyName: string
			serverName: string
			serverId: string
			instructions: string | null
			capabilityCount: number
			tools: Array<{
				name: string
				entityRef: string
				description: string
				toolName: string
				usage: string
			}>
			wrappingPackage: {
				kodyId: string
				name: string
				entityRef: string
			} | null
	  }

export type SearchEntityDetail =
	| {
			type: 'capability'
			id: string
			title: string
			description: string
			spec: CapabilitySpec
			relatedOperations?: Array<RelatedCapabilityOperation>
			relatedOperationCount?: number
	  }
	| {
			type: 'guide'
			id: string
			title: string
			description: string
			body: string
			slug: string
			category: 'platform' | 'provider'
			provider: string | null
			lastVerified: string | null
			section?: string
	  }
	| {
			type: 'package'
			id: string
			title: string
			description: string
			record: SavedPackageRecord
			manifest: AuthoredPackageJson
			publishedCommit?: string | null
			files: Record<string, string>
			baseUrl: string
			hostedUrl: string | null
			ownerUsername?: string | null
			listingAhead: boolean | null
			/** Export subpath when opening `package:{id}#{subpath}`. */
			section?: string
	  }
	| {
			type: 'secret'
			id: string
			title: string
			description: string
			row: SecretSearchRow
	  }
	| {
			type: 'integration'
			id: string
			title: string
			description: string
			config: IntegrationConfig
			relatedPackageSuggestions?: Array<RelatedIntegrationPackageSuggestion>
	  }
	| {
			type: 'mcp-server'
			id: string
			title: string
			description: string
			domain: string
			kodyName: string
			serverName: string
			serverId: string
			instructions: string | null
			usage: string
			tools: Array<{
				name: string
				entityRef: string
				description: string
				toolName: string
				usage: string
			}>
			wrappingPackage: {
				kodyId: string
				name: string
				entityRef: string
			} | null
	  }

export type SearchMatch =
	| {
			type: 'domain'
			name: string
			title: string
			description: string
			capabilityCount: number
			sampleCapabilities: Array<string>
	  }
	| {
			type: 'mcp-server'
			id: string
			title: string
			description: string
			domain: string
			source: 'mcp-server'
			kodyName: string
			serverName: string
			serverId: string
			instructions: string | null
			capabilityCount: number
			sampleCapabilities: Array<string>
			usage: string
			wrappingPackage: {
				kodyId: string
				name: string
				entityRef: string
			} | null
	  }
	| {
			type: 'capability'
			name: string
			title?: string
			description: string
			domain: string
			source?: CapabilitySpec['source']
			mcpServer?: CapabilitySpec['mcpServer']
			inputTypeDefinition?: string
			inputTypeDefinitionTruncated?: boolean
	  }
	| {
			type: 'guide'
			id: string
			title: string
			description: string
			category: 'platform' | 'provider'
			slug: string
			provider: string | null
	  }
	| {
			type: 'package'
			packageId: string
			kodyId: string
			name: string
			title: string
			description: string
			tags: Array<string>
			hasApp: boolean
			hidden: boolean
			readmeSnippet?: {
				path: string
				snippet: string
				truncated: boolean
			} | null
			/**
			 * Present when this ranked hit targets one export contract rather than
			 * the package index. Entity refs use `package:{kodyId}#{exportSubpath}`.
			 */
			exportSubpath?: string
			actionMatches?: Array<PackageActionMatch>
			/**
			 * High-confidence top export hits may inline the call contract
			 * (import + signature/types) so agents can execute without an
			 * entity round-trip. Omitted when top-2 is ambiguous or scores
			 * are weak.
			 */
			exportCallContract?: {
				importSpecifier: string
				usage: string
				executeExample: string
				typeDefinition: string | null
				typeDefinitionTruncated?: boolean
				functions: Array<{
					name: string
					description: string | null
					typeDefinition: string | null
				}>
			}
			/** Present only when the source community listing pin moved past this fork. */
			listingAhead?: true
	  }
	| {
			type: 'integration'
			integrationName: string
			title: string
			description: string
			flow: string
			tokenUrl: string
			apiBaseUrl: string | null
			requiredHosts: Array<string>
			clientId: string
			authorization?: IntegrationConfig['authorization'] | null
			lastAuthFailure?: IntegrationConfig['lastAuthFailure']
	  }
	| {
			type: 'secret'
			name: string
			description: string
	  }
