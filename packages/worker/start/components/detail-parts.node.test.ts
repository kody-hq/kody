import { createElement, Fragment } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { DetailParts } from './detail-parts.tsx'
import { formatTimestampDate } from './local-timestamp.tsx'

test('detail lines render timestamp parts as dates, not [object Object]', () => {
	const expires = createElement(
		Fragment,
		null,
		'Expires ',
		formatTimestampDate('2026-11-09T12:00:00.000Z'),
	)
	const html = renderToStaticMarkup(
		createElement(DetailParts, {
			parts: ['2 uses', expires, 'Created by you'],
		}),
	)
	expect(html).toBe(
		'2 uses · Expires <time dateTime="2026-11-09T12:00:00.000Z">2026-11-09</time> · Created by you',
	)
})
