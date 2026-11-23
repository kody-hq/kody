import type { AppStarterEntry } from '#worker/app-starters/service.ts'
import type { AppStarterManifest } from '#worker/app-starters/manifest.ts'
import {
	escapeMarkdownText,
	formatMarkdownInlineCode,
} from './markdown-safety.ts'

export const makingGreatAppsGuideEntity = 'guide:making_great_apps'

const appNouns = new Set([
	'app',
	'apps',
	'webapp',
	'website',
	'site',
	'dashboard',
	'frontend',
	'ui',
	'pwa',
	'tracker',
	'starter',
	'template',
	'scaffold',
])
const makeVerbs = new Set([
	'make',
	'build',
	'create',
	'new',
	'start',
	'scaffold',
	'starter',
	'template',
	'design',
	'prototype',
	'bootstrap',
])

/** True when the query reads like "make me an app", not like operating one. */
export function isAppCreationSearchQuery(query: string) {
	const tokens = query.toLowerCase().match(/[a-z0-9]+/g) ?? []
	const hasNoun = tokens.some((token) => appNouns.has(token))
	const hasVerb = tokens.some((token) => makeVerbs.has(token))
	return hasNoun && hasVerb
}

type RecommendedStarter = AppStarterEntry & { starter: AppStarterManifest }

export type SearchAppStartersStructured = {
	guide: string
	starters: Array<{
		package: string
		listingId: string
		name: string
		description: string
		whenToUse: string
		capabilities: Array<string>
	}>
}

export function toSearchAppStartersStructured(
	starters: Array<RecommendedStarter>,
): SearchAppStartersStructured {
	return {
		guide: makingGreatAppsGuideEntity,
		starters: starters.map((entry) => ({
			package: entry.packageName,
			listingId: entry.listingId ?? '',
			name: entry.starter.name,
			description: entry.starter.description,
			whenToUse: entry.starter.whenToUse,
			capabilities: entry.starter.capabilities,
		})),
	}
}

export function formatSearchAppStartersMarkdown(
	starters: Array<RecommendedStarter>,
) {
	const lines = [
		'## Making an app',
		'',
		`Start from a recommended starter and read ${formatMarkdownInlineCode(`search({ entity: "${makingGreatAppsGuideEntity}" })`)} first.`,
	]
	if (starters.length > 0) {
		lines.push('')
		for (const entry of starters) {
			lines.push(
				`- **${escapeMarkdownText(entry.starter.name)}** ${formatMarkdownInlineCode(entry.packageName)}: ${escapeMarkdownText(entry.starter.description)} Use when: ${escapeMarkdownText(entry.starter.whenToUse)} · ${formatMarkdownInlineCode(`communityFork({ listing_id: "${entry.listingId ?? ''}" })`)}`,
			)
		}
	}
	return lines.join('\n')
}
