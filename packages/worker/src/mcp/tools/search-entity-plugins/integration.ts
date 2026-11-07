import { deterministicEmbedding } from '#worker/vectorize/embedding.ts'
import { cosineSimilarity, lexicalScore } from '#worker/vectorize/scoring.ts'
import type { IntegrationConfig } from '#mcp/capabilities/integrations/integration-shared.ts'
import { toJoinedIntegrationConfig } from '#worker/integrations/service.ts'

import type { SearchEntityPlugin } from '../search-entity-plugin.ts'
import {
	escapeMarkdownText,
	formatMarkdownInlineCode,
} from '../markdown-safety.ts'
import {
	buildEntityRef,
	buildIntegrationUsage,
	formatOneLineSentence,
} from '../search-format-helpers.ts'
import { buildCandidateBaseScore } from '../search-scoring.ts'
import { extractSearchTokens } from '../understand-search-query.ts'

function describeIntegration(input: {
	description: string
	flow: IntegrationConfig['flow']
}) {
	return (
		input.description.trim() ||
		`Saved OAuth integration configuration (${input.flow} flow).`
	)
}

export function buildIntegrationSearchDocument(input: {
	integrationName: string
	description: string
	config: IntegrationConfig
}): string {
	return [
		input.integrationName,
		input.description,
		input.config.tokenUrl,
		input.config.apiBaseUrl ?? '',
		input.config.flow,
		input.config.authorization?.authorizeUrl ?? '',
		...(input.config.authorization?.scopes ?? []),
		...(input.config.requiredHosts ?? []),
	]
		.filter((value) => value.trim().length > 0)
		.join('\n')
}

export const integrationSearchEntityPlugin = {
	type: 'integration',
	buildDescriptors(input) {
		return input.optionalRows.userIntegrationRows.map((entry) => {
			const { connection } = entry
			const config = toJoinedIntegrationConfig(entry)
			return {
				type: 'integration' as const,
				id: connection.name,
				title: connection.name,
				primaryAliases: [connection.name],
				secondaryAliases: [
					connection.description,
					config.apiBaseUrl ?? '',
					config.tokenUrl,
					config.flow,
				],
				tertiaryAliases: [
					...(config.requiredHosts ?? []),
					...(config.apiBaseUrl ? extractSearchTokens(config.apiBaseUrl) : []),
				],
			}
		})
	},
	buildCandidates(input) {
		return input.optionalRows.userIntegrationRows
			.map((entry) => {
				const { connection } = entry
				const config = toJoinedIntegrationConfig(entry)
				const description = describeIntegration({
					description: connection.description,
					flow: config.flow,
				})
				const document = buildIntegrationSearchDocument({
					integrationName: connection.name,
					description,
					config,
				})
				const lexical = lexicalScore(input.query, document)
				const vector = cosineSimilarity(
					input.queryEmbedding,
					deterministicEmbedding(document),
				)
				return {
					match: {
						type: 'integration' as const,
						integrationName: connection.name,
						title: connection.name,
						description,
						flow: config.flow,
						tokenUrl: config.tokenUrl,
						apiBaseUrl: config.apiBaseUrl ?? null,
						requiredHosts: config.requiredHosts ?? [],
						clientId: config.clientId,
						authorization: config.authorization ?? null,
						lastAuthFailure: config.lastAuthFailure,
					},
					type: 'integration' as const,
					id: connection.name,
					title: connection.name,
					searchFields: [
						connection.name,
						connection.description,
						config.flow,
						config.apiBaseUrl ?? '',
						config.tokenUrl,
						config.authorization?.authorizeUrl ?? '',
						...(config.authorization?.scopes ?? []),
						...(config.requiredHosts ?? []),
					],
					scoreComponents: buildCandidateBaseScore({
						lexical,
						vector,
					}),
				}
			})
			.filter((candidate) => candidate.scoreComponents.base > 0)
	},
	formatSlimMatch({ match }) {
		return {
			type: 'integration',
			id: match.integrationName,
			entityRef: buildEntityRef(match.integrationName, 'integration'),
			name: match.integrationName,
			title: match.title,
			description: match.description,
			usage: buildIntegrationUsage(match.integrationName),
			flow: match.flow,
			tokenUrl: match.tokenUrl,
			apiBaseUrl: match.apiBaseUrl,
			requiredHosts: match.requiredHosts,
			clientId: match.clientId,
			authorization: match.authorization ?? null,
			nextStep: (() => {
				const failure = match.lastAuthFailure
				if (!failure) {
					return `Inspect integration detail with search({ entity: "integration:${match.integrationName}" }), then smoke-test with createAuthenticatedFetch('${match.integrationName}'). Do not persist tokens with secretSet or secretSetMany.`
				}
				if (failure.reconnectable) {
					return `${failure.why} ${failure.doLabel} at ${failure.reconnectHref}.`
				}
				return `${failure.why} ${failure.doLabel} at ${failure.accountHref}.`
			})(),
		}
	},
	formatEntityDetail(detail) {
		const requiredHosts = detail.config.requiredHosts ?? []
		const authorization = detail.config.authorization ?? null
		const relatedPackageSuggestions = detail.relatedPackageSuggestions ?? []
		const lines = [
			`# Integration — \`${detail.config.name}\``,
			'',
			detail.description,
			'',
			'## Summary',
			'',
			`- Entity: \`${buildEntityRef(detail.id, 'integration')}\``,
			`- Flow: \`${detail.config.flow}\``,
			`- Token URL: \`${detail.config.tokenUrl}\``,
			`- API base URL: ${detail.config.apiBaseUrl ? `\`${detail.config.apiBaseUrl}\`` : 'none'}`,
			`- Required hosts: ${requiredHosts.length > 0 ? requiredHosts.map((host) => `\`${host}\``).join(', ') : 'none'}`,
			`- Authorize URL: ${authorization ? `\`${authorization.authorizeUrl}\`` : 'none'}`,
			`- Scopes: ${authorization && authorization.scopes.length > 0 ? authorization.scopes.map((scope) => `\`${scope}\``).join(', ') : 'none'}`,
			'',
			'## Read this integration',
			'',
			`- \`${buildIntegrationUsage(detail.config.name)}\``,
			'- `kody.integrationList({})`',
			'',
			'## Credentials',
			'',
			`- Client ID: \`${detail.config.clientId}\``,
			`- Access and refresh tokens live on this connection. Call \`createAuthenticatedFetch('${detail.config.name}')\` or \`integrationTokenRefresh\`. Do not read or write them with \`secretSet\`, \`secretSetMany\`, or \`secretList\`.`,
		]
		if (detail.config.lastAuthFailure) {
			const failure = detail.config.lastAuthFailure
			const href = failure.reconnectable
				? failure.reconnectHref
				: failure.accountHref
			lines.push(
				'',
				failure.reconnectable ? '## Needs you' : '## Connection trouble',
				'',
				escapeMarkdownText(failure.why),
				'',
				`${escapeMarkdownText(failure.doLabel)} at ${formatMarkdownInlineCode(href)}.`,
			)
		}
		if (authorization) {
			const nonReconnectableFailure =
				detail.config.lastAuthFailure &&
				!detail.config.lastAuthFailure.reconnectable
			lines.push(
				'',
				'## OAuth authorization metadata',
				'',
				`- Scope separator: ${authorization.scopeSeparator ? `\`${authorization.scopeSeparator}\`` : 'default single space'}`,
				`- Extra authorize params: ${
					Object.keys(authorization.extraAuthorizeParams ?? {}).length > 0
						? Object.entries(authorization.extraAuthorizeParams ?? {})
								.map(([key, value]) => `\`${key}=${value}\``)
								.join(', ')
						: 'none'
				}`,
				'',
				nonReconnectableFailure
					? `Open \`/account/integrations/${encodeURIComponent(detail.config.name).replaceAll('.', '%2E')}\` while the provider limit clears; reconnecting usually does not help. Kody derives the provider authorize URL from the saved integration metadata plus the current client credentials when a reconnect is needed.`
					: `Reconnect with \`/connect/oauth?provider=${encodeURIComponent(detail.config.name)}\`; Kody derives the provider authorize URL from the saved integration metadata plus the current client credentials.`,
			)
		}
		if (relatedPackageSuggestions.length > 0) {
			lines.push(
				'',
				'## Related packages',
				'',
				'Integrations store auth config. Packages are the agent API for this provider — inspect or fork one of these instead of treating the integration alone as the end state.',
				'',
			)
			for (const suggestion of relatedPackageSuggestions) {
				if (suggestion.source === 'user') {
					lines.push(
						`- **user** ${formatMarkdownInlineCode(suggestion.kodyId)} (${formatMarkdownInlineCode(suggestion.name)}) — ${escapeMarkdownText(formatOneLineSentence(suggestion.description))} Entity: ${formatMarkdownInlineCode(suggestion.entityRef)}`,
					)
					continue
				}
				const trustLabel = suggestion.trusted
					? 'community (trusted)'
					: 'community'
				lines.push(
					`- **${trustLabel}** ${formatMarkdownInlineCode(suggestion.kodyId)} (${formatMarkdownInlineCode(suggestion.name)}) — ${escapeMarkdownText(formatOneLineSentence(suggestion.description))} Listing: ${formatMarkdownInlineCode(suggestion.listingId)} · ${formatMarkdownInlineCode(suggestion.publicUrl)}`,
				)
			}
		}
		return {
			markdown: lines.join('\n'),
			structured: {
				kind: 'entity',
				type: 'integration',
				id: detail.id,
				entityRef: buildEntityRef(detail.id, 'integration'),
				title: detail.title,
				description: detail.description,
				usage: buildIntegrationUsage(detail.config.name),
				flow: detail.config.flow,
				tokenUrl: detail.config.tokenUrl,
				apiBaseUrl: detail.config.apiBaseUrl ?? null,
				clientId: detail.config.clientId,
				requiredHosts,
				authorization,
				...(relatedPackageSuggestions.length > 0
					? { relatedPackageSuggestions }
					: {}),
			},
		}
	},
} satisfies SearchEntityPlugin<'integration'>
