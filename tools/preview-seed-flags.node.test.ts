import { expect, test } from 'vitest'

import {
	previewSeedFlagKeysFromLabels,
	readPreviewSeedFlagLabels,
} from './preview-seed-flags.ts'

test('preview-flag labels become allowlisted seed flag keys', () => {
	expect(
		previewSeedFlagKeysFromLabels([
			'friction',
			'preview-flag:execution-contexts',
			'preview-flag:demo-indicator',
			'preview-flag:execution-contexts',
		]),
	).toEqual(['execution-contexts', 'demo-indicator'])
	expect(previewSeedFlagKeysFromLabels(['bug'])).toEqual([])
})

test('a preview-flag label outside the allowlist fails closed', () => {
	expect(() =>
		previewSeedFlagKeysFromLabels(['preview-flag:mcp-skills-extension']),
	).toThrow(/not an allowlisted preview seed flag/)
	expect(() => previewSeedFlagKeysFromLabels(['preview-flag:'])).toThrow(
		/not an allowlisted preview seed flag/,
	)
	expect(() =>
		previewSeedFlagKeysFromLabels(['preview-flag:not-a-flag']),
	).toThrow(/not an allowlisted preview seed flag/)
})

test('label JSON must be an array of strings', () => {
	expect(readPreviewSeedFlagLabels('["preview-flag:demo-indicator"]')).toEqual([
		'preview-flag:demo-indicator',
	])
	expect(() => readPreviewSeedFlagLabels('null')).toThrow(
		/JSON array of label names/,
	)
	expect(() => readPreviewSeedFlagLabels('{')).toThrow(
		/JSON array of label names/,
	)
	expect(() => readPreviewSeedFlagLabels('[1]')).toThrow(
		/JSON array of label names/,
	)
})
