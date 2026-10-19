import { expect, test } from 'vitest'
import { isGhPrEditForbidden, mergeRecapBody } from './upsert-recap-block.mjs'

const startMarker = '<!-- system-recap:start -->'
const endMarker = '<!-- system-recap:end -->'

test('mergeRecapBody replaces an existing recap and appends when missing', () => {
	const block = `${startMarker}\nnew\n${endMarker}`
	const replaced = mergeRecapBody(
		`intro\n${startMarker}\nold\n${endMarker}\nfooter\n`,
		block,
	)
	expect(replaced.hasExistingBlock).toBe(true)
	expect(replaced.nextBody).toBe(`intro\n${block}\nfooter\n`)

	const appended = mergeRecapBody('intro\n', block)
	expect(appended.hasExistingBlock).toBe(false)
	expect(appended.nextBody).toBe(`intro\n\n${block}\n`)
})

test('isGhPrEditForbidden recognizes the Cloud Agent GraphQL denial', () => {
	expect(
		isGhPrEditForbidden(
			new Error(
				'GraphQL: Resource not accessible by integration (updatePullRequest)',
			),
		),
	).toBe(true)
	expect(isGhPrEditForbidden(new Error('HTTP 401 Bad credentials'))).toBe(false)
})
