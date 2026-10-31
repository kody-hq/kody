import { fail } from './ci/resource-utils.ts'
import { isExecutedDirectly } from './node-runtime.ts'
import {
	isPreviewSeedFlagKey,
	previewSeedFlagAllowlist,
	type PreviewSeedFlagKey,
} from './preview-seed-flag-allowlist.ts'

/** PR label that opts one allowlisted flag into the preview seed step. */
export const previewFlagLabelPrefix = 'preview-flag:'

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
			'Usage: node tools/preview-seed-flags.ts --labels <json-array-of-label-names>',
		)
	}
	return value
}

function main() {
	try {
		const labels = readPreviewSeedFlagLabels(
			readLabelsArg(process.argv.slice(2)),
		)
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
