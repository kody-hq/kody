import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { docsNav } from '#universal/docs-nav.ts'
import {
	experimentAudienceFlagKeys,
	notSelfServeExperimentFlags,
	selfServeExperiments,
} from './experiments.ts'
import { featureFlagDefinitions } from './registry.ts'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))

test('every experiments-audience flag is in the self-serve registry or says why not', () => {
	const listed = new Set<string>(selfServeExperiments.map((e) => e.flagKey))
	const missing = experimentAudienceFlagKeys().filter(
		(key) => !listed.has(key) && !notSelfServeExperimentFlags[key],
	)
	expect(missing).toEqual([])
})

test('every self-serve experiment names a real flag that is off by default', () => {
	for (const experiment of selfServeExperiments) {
		const definition = featureFlagDefinitions.find(
			(flag) => flag.key === experiment.flagKey,
		)
		expect({
			id: experiment.id,
			defaultEnabled: definition?.defaultEnabled,
		}).toEqual({
			id: experiment.id,
			defaultEnabled: false,
		})
	}
	const ids = selfServeExperiments.map((e) => e.id)
	expect(new Set(ids).size).toBe(ids.length)
})

test('every self-serve experiment has a served guide, a nav entry, and a docs/use page', () => {
	const navSlugs = new Set(
		docsNav.flatMap((section) => section.items.map((item) => item.slug)),
	)
	for (const experiment of selfServeExperiments) {
		const slug = experiment.docsSlug
		expect({
			slug,
			guide: existsSync(`${repoRoot}docs/guides/${slug}.md`),
			use: existsSync(`${repoRoot}docs/use/${slug}.md`),
			nav: navSlugs.has(slug),
		}).toEqual({ slug, guide: true, use: true, nav: true })
	}
})
