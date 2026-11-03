import { lexicalScore } from '#worker/vectorize/scoring.ts'

import type { SearchEntityPlugin } from '../search-entity-plugin.ts'
import { buildEntityRef, buildSecretUsage } from '../search-format-helpers.ts'
import { buildCandidateBaseScore } from '../search-scoring.ts'

export const secretSearchEntityPlugin = {
	type: 'secret',
	buildDescriptors(input) {
		return input.optionalRows.userSecretRows.map((row) => ({
			type: 'secret',
			id: row.name,
			title: row.name,
			primaryAliases: [row.name],
			secondaryAliases: [row.description],
		}))
	},
	buildCandidates(input) {
		return input.optionalRows.userSecretRows
			.map((row) => {
				const lexical = lexicalScore(
					input.query,
					`${row.name}\n${row.description}`,
				)
				return {
					match: {
						type: 'secret' as const,
						name: row.name,
						description: row.description,
					},
					type: 'secret' as const,
					id: row.name,
					title: row.name,
					searchFields: [row.name, row.description],
					scoreComponents: buildCandidateBaseScore({
						lexical,
					}),
				}
			})
			.filter((candidate) => candidate.scoreComponents.base > 0)
	},
	formatSlimMatch({ match }) {
		return {
			type: 'secret',
			id: match.name,
			entityRef: buildEntityRef(match.name, 'secret'),
			title: match.name,
			description: match.description,
			usage: buildSecretUsage(match.name),
		}
	},
	formatEntityDetail(detail) {
		const lines = [
			`# Secret — \`${detail.row.name}\``,
			'',
			detail.row.description,
			'',
			'## Summary',
			'',
			`- Entity: \`${buildEntityRef(detail.id, 'secret')}\``,
			`- Scope: \`${detail.row.scope}\``,
			`- Updated at: \`${detail.row.updatedAt}\``,
			'',
			'## Usage',
			'',
			`- Placeholder: \`${buildSecretUsage(detail.row.name)}\``,
			'- Use placeholders only in execute-time fetch URL, header, or body fields.',
			'- Do not place the literal placeholder token into visible content such as prompts, comments, issue bodies, logs, or returned strings.',
			'- List secret metadata with `kody.secretList(...)` inside `execute` when needed. Explicit listing includes caller-owned package-scoped metadata with `package_id`; search does not return or rank package-scoped secret references. Using a package secret still requires package context.',
		]
		return {
			markdown: lines.join('\n'),
			structured: {
				kind: 'entity',
				type: 'secret',
				id: detail.id,
				entityRef: buildEntityRef(detail.id, 'secret'),
				title: detail.title,
				description: detail.description,
				usage: buildSecretUsage(detail.row.name),
				scope: detail.row.scope,
				updatedAt: detail.row.updatedAt,
			},
		}
	},
} satisfies SearchEntityPlugin<'secret'>
