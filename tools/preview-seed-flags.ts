import { fail } from './ci/resource-utils.ts'
import { isExecutedDirectly } from './node-runtime.ts'
import {
	isPreviewSeedFlagKey,
	previewSeedFlagAllowlist,
	type PreviewSeedFlagKey,
} from './preview-seed-flag-allowlist.ts'
import { parsePlanName, planNames, type PlanName } from '#universal/plans.ts'

/** PR label that opts one allowlisted flag into the preview seed step. */
export const previewFlagLabelPrefix = 'preview-flag:'

/** PR label that seeds the preview user's personal org on one plan. */
export const previewPlanLabelPrefix = 'preview-plan:'

/**
 * PR label that seeds the `preview-team` team org (seed user Owner, member
 * account Member). Opt-in because a second org makes MCP OAuth ask for an
 * org, so default preview smokes keep a single-org seed user.
 */
export const previewTeamOrgLabel = 'preview-seed:team-org'
export const previewTeamOrgSlug = 'preview-team'

export function previewSeedTeamOrgFromLabels(labels: ReadonlyArray<string>) {
	return labels.includes(previewTeamOrgLabel) ? previewTeamOrgSlug : null
}

export class PreviewSeedFlagError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'PreviewSeedFlagError'
	}
}

/**
 * Flags to pass to `seed-test-data.ts --enable-flag` from PR labels such as
 * `preview-flag:execution-contexts`. Unrelated labels are ignored. A
 * `preview-flag:` label whose key is missing from the committed allowlist
 * throws so the seed step fails closed.
 */
export function previewSeedFlagKeysFromLabels(
	labels: ReadonlyArray<string>,
): Array<PreviewSeedFlagKey> {
	const keys: Array<PreviewSeedFlagKey> = []
	for (const label of labels) {
		if (!label.startsWith(previewFlagLabelPrefix)) continue
		const key = label.slice(previewFlagLabelPrefix.length).trim()
		if (!key || !isPreviewSeedFlagKey(key)) {
			throw new PreviewSeedFlagError(
				`PR label ${JSON.stringify(label)} is not an allowlisted preview seed flag. Allowed keys: ${previewSeedFlagAllowlist.join(', ')}.`,
			)
		}
		if (!keys.includes(key)) keys.push(key)
	}
	return keys
}

/**
 * Plan for the preview seed user's personal org from a `preview-plan:<plan>`
 * label, or `free` without one, so removing the label resets the plan on the
 * next seed. Unknown plans and conflicting labels fail closed.
 */
export function previewSeedPlanFromLabels(
	labels: ReadonlyArray<string>,
): PlanName {
	const plans = new Set<PlanName>()
	for (const label of labels) {
		if (!label.startsWith(previewPlanLabelPrefix)) continue
		const plan = parsePlanName(
			label.slice(previewPlanLabelPrefix.length).trim(),
		)
		if (!plan) {
			throw new PreviewSeedFlagError(
				`PR label ${JSON.stringify(label)} is not a plan. Use one of: ${planNames.join(', ')}.`,
			)
		}
		plans.add(plan)
	}
	if (plans.size > 1) {
		throw new PreviewSeedFlagError(
			`Only one ${previewPlanLabelPrefix} label is allowed; found ${[...plans].join(', ')}.`,
		)
	}
	return [...plans][0] ?? 'free'
}

export function readPreviewSeedFlagLabels(labelsJson: string): Array<string> {
	let parsed: unknown
	try {
		parsed = JSON.parse(labelsJson)
	} catch {
		throw new PreviewSeedFlagError(
			'Preview seed flag labels must be a JSON array of label names.',
		)
	}
	if (
		!Array.isArray(parsed) ||
		parsed.some((label) => typeof label !== 'string')
	) {
		throw new PreviewSeedFlagError(
			'Preview seed flag labels must be a JSON array of label names.',
		)
	}
	return parsed
}

function readLabelsArg(argv: Array<string>) {
	const index = argv.indexOf('--labels')
	const value = index === -1 ? undefined : argv[index + 1]
	if (!value) {
		fail(
			'Usage: node tools/preview-seed-flags.ts --labels <json-array-of-label-names> [--plan|--team-org]',
		)
	}
	return value
}

function main() {
	try {
		const argv = process.argv.slice(2)
		const labels = readPreviewSeedFlagLabels(readLabelsArg(argv))
		if (argv.includes('--plan')) {
			process.stdout.write(`${previewSeedPlanFromLabels(labels)}\n`)
			return
		}
		if (argv.includes('--team-org')) {
			const slug = previewSeedTeamOrgFromLabels(labels)
			if (slug) process.stdout.write(`${slug}\n`)
			return
		}
		const keys = previewSeedFlagKeysFromLabels(labels)
		if (keys.length > 0) {
			process.stdout.write(`${keys.join('\n')}\n`)
		}
	} catch (error) {
		if (error instanceof PreviewSeedFlagError) fail(error.message)
		throw error
	}
}

if (isExecutedDirectly(import.meta.url)) {
	main()
}
