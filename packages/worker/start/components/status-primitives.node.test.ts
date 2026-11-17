import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { Alert } from './alert.tsx'
import { Badge, getBadgeCss } from './badge.tsx'
import { Table } from './table.tsx'

function markup(node: ReactNode) {
	return renderToStaticMarkup(node).replace(
		/<style\b[^>]*>[\s\S]*?<\/style>/g,
		'',
	)
}

test('Badge renders a span and forwards native attributes', () => {
	const html = markup(
		createElement(
			Badge,
			{ tone: 'accent', title: 'Reviewed', 'data-testid': 'badge' } as never,
			'Trusted',
		),
	)
	expect(html).toMatch(/^<span [^>]*title="Reviewed"[^>]*>Trusted<\/span>$/)
	expect(html).toContain('data-testid="badge"')
	expect(html).not.toContain('role=')
})

test('every Badge tone shares one box so adjacent badges line up', () => {
	const box = (css: Record<string, unknown>) => ({
		fontSize: css.fontSize,
		padding: css.padding,
		lineHeight: css.lineHeight,
		borderRadius: css.borderRadius,
	})
	const sharedBox = {
		fontSize: '0.78rem',
		padding: '0.15rem 0.6rem',
		lineHeight: 1.2,
		borderRadius: '999px',
	}
	expect(box(getBadgeCss('neutral'))).toEqual(sharedBox)
	for (const tone of ['accent', 'warning', 'danger'] as const) {
		expect(box(getBadgeCss(tone))).toEqual(sharedBox)
	}
	expect(getBadgeCss()).toEqual(getBadgeCss('neutral'))
	expect(getBadgeCss('accent').color).toBe('var(--color-primary-text)')
	expect(getBadgeCss('warning').color).toBe('var(--color-warning-text)')
	expect(getBadgeCss('danger').color).toBe('var(--color-danger)')
})

test('Alert sets no role unless the caller asks for one', () => {
	expect(markup(createElement(Alert, null, 'Saved'))).toMatch(
		/^<div class="[^"]+">Saved<\/div>$/,
	)
	const error = markup(
		createElement(Alert, { tone: 'error', role: 'alert', id: 'err' }, 'Failed'),
	)
	expect(error).toContain('role="alert"')
	expect(error).toContain('id="err"')
})

test('Table renders a native table so captions and header scopes work', () => {
	const html = markup(
		createElement(
			Table,
			{ 'aria-label': 'Records' },
			createElement('caption', null, 'DNS'),
		),
	)
	expect(html).toMatch(
		/^<table aria-label="Records" class="[^"]+"><caption>DNS<\/caption><\/table>$/,
	)
})

test('Table cell defaults never beat a cell that sets its own alignment', () => {
	const styles = [
		...renderToStaticMarkup(createElement(Table)).matchAll(
			/<style\b[^>]*>([\s\S]*?)<\/style>/g,
		),
	]
		.map((match) => match[1])
		.join('')
	const tableClass = /\.(css-[\w-]+)/.exec(styles)?.[1]
	expect(tableClass).toBeTruthy()
	expect(styles).toContain(`:where(.${tableClass}) :where(th, td){`)
	expect(styles).toContain(
		'padding:var(--spacing-xs) var(--spacing-sm);border-bottom:1px solid var(--color-border)',
	)
	expect(styles).not.toMatch(/\.css-[\w-]+ (th|td)\b/)
})
