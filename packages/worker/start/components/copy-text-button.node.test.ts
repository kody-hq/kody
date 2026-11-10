import { createElement, Fragment, useId } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { CopyTextButton } from './copy-text-button.tsx'

function IdSink() {
	useId()
	return null
}

function copyButtonStart(html: string) {
	const start = html.match(/<button\b[^>]*>/)?.[0]
	if (!start) throw new Error(`Copy button missing from ${html}`)
	return start
}

test('copy button markup does not shift when earlier useId calls change', () => {
	const button = createElement(CopyTextButton, {
		value: 'kody_at_example',
		ariaLabel: 'Copy token',
	})
	const without = renderToStaticMarkup(button)
	const withEarlierIds = renderToStaticMarkup(
		createElement(
			Fragment,
			null,
			createElement(IdSink),
			createElement(IdSink),
			createElement(IdSink),
			createElement(IdSink),
			createElement(IdSink),
			button,
		),
	)
	expect(copyButtonStart(without)).toBe(copyButtonStart(withEarlierIds))
	expect(without).toContain('role="status"')
	expect(withEarlierIds).toContain('role="status"')
})
