import { expect, test } from 'vitest'

import {
	attachHighConfidenceExportCallContract,
	shouldInlineExportCallContract,
} from './search-export-call-contract.ts'
import { type SearchMatch } from './search-format-types.ts'
import { type SearchCandidate } from './search-types.ts'

function makeExportMatch(
	overrides: Partial<Extract<SearchMatch, { type: 'package' }>> = {},
): Extract<SearchMatch, { type: 'package' }> {
	return {
		type: 'package',
		packageId: 'pkg-1',
		kodyId: 'home-controls',
		name: '@kody/home-controls',
		title: '@kody/home-controls setBondAreaShades',
		description: 'Dim bond area shades.',
		tags: ['home'],
		hasApp: false,
		hidden: false,
		exportSubpath: './bond-area-shades',
		actionMatches: [
			{
				subpath: './bond-area-shades',
				description: 'Dim bond area shades.',
				typeDefinition:
					'export declare function setBondAreaShades(params: { level: number }): Promise<void>',
				functions: [
					{
						name: 'setBondAreaShades',
						description: 'Dim bond area shades.',
						typeDefinition:
							'export declare function setBondAreaShades(params: { level: number }): Promise<void>',
					},
				],
				score: 0.9,
				matchedTerms: ['bond', 'shades'],
			},
		],
		...overrides,
	}
}

function makeCandidateFromMatch(
	match: SearchMatch,
	final: number,
): SearchCandidate {
	return {
		match,
		type: match.type,
		id:
			match.type === 'package' && match.exportSubpath
				? `${match.kodyId}#${match.exportSubpath}`
				: match.type === 'package'
					? match.kodyId
					: 'id',
		title: ('title' in match ? match.title : undefined) ?? 'title',
		searchFields: ['title'],
		scoreComponents: {
			base: final,
			lexical: final,
			vector: 0,
			entityMatch: 0,
			providerEntityAffinity: 0,
			actionMatch: 0,
			taskAffinity: 0,
			appAvailability: 0,
			wrapperWorkflow: 0,
			constraint: 0,
			final,
		},
	}
}

function makeRivalExport(
	subpath: string,
	functionName: string,
	score: number,
	overrides: Partial<Extract<SearchMatch, { type: 'package' }>> = {},
) {
	return makeExportMatch({
		exportSubpath: subpath,
		actionMatches: [
			{
				subpath,
				description: null,
				typeDefinition: null,
				functions: [
					{ name: functionName, description: null, typeDefinition: null },
				],
				score,
				matchedTerms: [subpath.replace('./', '')],
			},
		],
		...overrides,
	})
}

test('shouldInlineExportCallContract requires high confidence on post-collapse matches', () => {
	const top = makeExportMatch()
	const weakSecond = makeRivalExport('./other', 'other', 0.2, {
		kodyId: 'other-pkg',
	})
	const rivalExport = makeRivalExport('./curtains', 'setCurtains', 0.8)
	const rankedClear = [
		makeCandidateFromMatch(top, 1.2),
		makeCandidateFromMatch(weakSecond, 0.3),
	]
	const rankedTight = [
		makeCandidateFromMatch(top, 1.0),
		makeCandidateFromMatch(weakSecond, 0.95),
	]
	// Collapse dropped a leading synthesized MCP tool; matches[0] is a weak
	// export that must not inherit the dropped hit's score/gap.
	const droppedCapabilityMatch: SearchMatch = {
		type: 'capability',
		name: 'cap-dropped',
		title: 'Dropped tool',
		description: '',
		domain: 'integrations',
	}
	const rankedPreCollapse = [
		makeCandidateFromMatch(droppedCapabilityMatch, 2.0),
		makeCandidateFromMatch(top, 0.5),
		makeCandidateFromMatch(weakSecond, 0.45),
	]
	const cases: Array<
		[string, Parameters<typeof shouldInlineExportCallContract>[0], boolean]
	> = [
		[
			'clear gap',
			{
				matches: [top, weakSecond],
				rankedCandidates: rankedClear,
				jevOutcome: 'skipped-clear-winner',
				jevMeanConfidence: null,
			},
			true,
		],
		[
			'tight gap',
			{
				matches: [top, weakSecond],
				rankedCandidates: rankedTight,
				jevOutcome: 'skipped-plan',
				jevMeanConfidence: null,
			},
			false,
		],
		[
			'low Jev confidence',
			{
				matches: [top],
				rankedCandidates: rankedClear,
				jevOutcome: 'applied',
				jevMeanConfidence: 0.5,
			},
			false,
		],
		[
			'high Jev confidence',
			{
				matches: [top],
				rankedCandidates: rankedClear,
				jevOutcome: 'applied',
				jevMeanConfidence: 0.85,
			},
			true,
		],
		[
			'rival export in the same package',
			{
				matches: [top, rivalExport],
				rankedCandidates: rankedClear,
				jevOutcome: 'applied',
				jevMeanConfidence: 0.9,
			},
			false,
		],
		[
			'pre-collapse leader dropped',
			{
				matches: [top, weakSecond],
				rankedCandidates: rankedPreCollapse,
				jevOutcome: 'skipped-clear-winner',
				jevMeanConfidence: null,
			},
			false,
		],
	]
	expect(
		cases.map(([name, input]) => [name, shouldInlineExportCallContract(input)]),
	).toEqual(cases.map(([name, , expected]) => [name, expected]))
})

test('attachHighConfidenceExportCallContract inlines import and types', () => {
	const top = makeExportMatch()
	const matches: Array<SearchMatch> = [top]
	const ranked = [makeCandidateFromMatch(top, 1.5)]
	attachHighConfidenceExportCallContract({
		matches,
		rankedCandidates: ranked,
		jevOutcome: 'skipped-small-pool',
		jevMeanConfidence: null,
	})
	expect(top.exportCallContract).toMatchObject({
		importSpecifier: 'kody:@kody/home-controls/bond-area-shades',
		usage: expect.stringContaining('setBondAreaShades'),
		typeDefinition: expect.stringContaining('setBondAreaShades'),
		functions: [expect.objectContaining({ name: 'setBondAreaShades' })],
	})
	expect(top.exportCallContract?.executeExample).toContain('setBondAreaShades')

	const weak: Array<SearchMatch> = [makeExportMatch()]
	attachHighConfidenceExportCallContract({
		matches: weak,
		rankedCandidates: [
			makeCandidateFromMatch(weak[0]!, 0.2),
			makeCandidateFromMatch(makeExportMatch({ kodyId: 'other' }), 0.19),
		],
		jevOutcome: 'skipped-plan',
		jevMeanConfidence: null,
	})
	expect(weak[0]).not.toHaveProperty('exportCallContract')
})
