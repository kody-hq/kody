import { searchWaitingItemCap } from '#universal/connection-trouble.ts'
import type { WaitingItem } from '#universal/waiting.ts'
import {
	escapeMarkdownText,
	formatMarkdownInlineCode,
} from './markdown-safety.ts'

export type SearchWaitingStructured = {
	count: number
	items: Array<{
		id: string
		kind: WaitingItem['kind']
		title: string
		why: string
		doLabel: string
		href: string
		severity: WaitingItem['severity']
	}>
}

function waitingIndexPath(items: Array<WaitingItem>) {
	for (const item of items) {
		const match = /^\/@([^/]+)\/-\//.exec(item.href)
		const slug = match?.[1]
		if (slug) return `/@${slug}/-/waiting`
	}
	return null
}

export function selectSearchWaitingItems(items: Array<WaitingItem>) {
	return items.filter((item) => item.severity !== 'setup')
}

export function formatSearchWaitingMarkdown(input: {
	items: Array<WaitingItem>
	origin: string
	cap?: number
}): string | null {
	const actionable = selectSearchWaitingItems(input.items)
	if (actionable.length === 0) return null
	const cap = input.cap ?? searchWaitingItemCap
	const shown = actionable.slice(0, cap)
	const extra = actionable.length - shown.length
	const origin = input.origin.replace(/\/+$/, '')
	const lines = ['## Waiting', '']
	for (const item of shown) {
		const href = item.href.startsWith('http')
			? item.href
			: `${origin}${item.href}`
		lines.push(
			`- **${escapeMarkdownText(item.title)}** — ${escapeMarkdownText(item.why)} ${escapeMarkdownText(item.doLabel)} · ${formatMarkdownInlineCode(href)}`,
		)
	}
	if (extra > 0) {
		const morePath = waitingIndexPath(shown) ?? waitingIndexPath(actionable)
		const moreHref = morePath ? `${origin}${morePath}` : `${origin}/account`
		lines.push(
			`- ${String(extra)} more · waitingSummary · ${formatMarkdownInlineCode(moreHref)}`,
		)
	}
	return lines.join('\n')
}

export function toSearchWaitingStructured(input: {
	items: Array<WaitingItem>
	origin: string
	cap?: number
}): SearchWaitingStructured | null {
	const actionable = selectSearchWaitingItems(input.items)
	if (actionable.length === 0) return null
	const cap = input.cap ?? searchWaitingItemCap
	const origin = input.origin.replace(/\/+$/, '')
	return {
		count: actionable.length,
		items: actionable.slice(0, cap).map((item) => ({
			id: item.id,
			kind: item.kind,
			title: item.title,
			why: item.why,
			doLabel: item.doLabel,
			href: item.href.startsWith('http') ? item.href : `${origin}${item.href}`,
			severity: item.severity,
		})),
	}
}
