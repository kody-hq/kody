import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'

const blockingImpacts = new Set(['critical', 'serious'])

/** Blocking (critical/serious) WCAG 2.1 AA violations, one readable line each. */
export async function findAxeViolations(
	page: Page,
	options: { include?: string; exclude?: string } = {},
) {
	const axe = new AxeBuilder({ page }).withTags([
		'wcag2a',
		'wcag2aa',
		'wcag21a',
		'wcag21aa',
	])
	if (options.include) axe.include(options.include)
	if (options.exclude) axe.exclude(options.exclude)
	const results = await axe.analyze()
	return results.violations
		.filter(
			(violation) =>
				violation.impact != null && blockingImpacts.has(violation.impact),
		)
		.map((violation) => {
			const targets = violation.nodes
				.slice(0, 5)
				.map((node) => node.target.join(' '))
				.join(', ')
			const more =
				violation.nodes.length > 5
					? ` (+${violation.nodes.length - 5} more)`
					: ''
			return `${violation.id} (${violation.impact}): ${violation.help}. Elements: ${targets}${more}. ${violation.helpUrl}`
		})
}

export type FocusStop = {
	description: string
	hasIndicator: boolean
	onScreen: boolean
}

/** `truncated` is the stop limit when the tab order had not wrapped by then. */
export type FocusSweep = { stops: FocusStop[]; truncated: number | null }

/**
 * Tab through the page (or one container) the way a keyboard user would and
 * record every stop. A stop fails when nothing visibly changes while it has
 * focus (outline, box-shadow, border, or background on the element or its two
 * nearest ancestors), or when focus lands on something with no size. Each
 * element's focused look is compared with its look after focus moves on, so
 * no blur handlers run. Transitions are switched off for the sweep.
 */
export async function sweepFocus(
	page: Page,
	options: { within?: string; maxStops?: number } = {},
): Promise<FocusSweep> {
	await page.evaluate((within) => {
		const style = document.createElement('style')
		style.dataset.uiVerify = ''
		style.textContent =
			'*, *::before, *::after { transition: none !important; }'
		document.head.appendChild(style)
		;(document.activeElement as HTMLElement | null)?.blur()
		const container = within ? document.querySelector(within) : null
		if (container) {
			const marker = document.createElement('span')
			marker.tabIndex = -1
			container.insertBefore(marker, container.firstChild)
			marker.focus()
			marker.remove()
		}
	}, options.within ?? null)
	const stops: FocusStop[] = []
	const maxStops = options.maxStops ?? 80
	for (let index = 0; index <= maxStops; index++) {
		if (index < maxStops) await page.keyboard.press('Tab')
		const step = await page.evaluate(
			({ within, last }) => {
				type Pending = {
					element: HTMLElement
					focused: string
					description: string
					onScreen: boolean
				}
				const state = window as unknown as {
					__uiVerifyFocus?: { pending: Pending | null; seen: Set<Element> }
				}
				state.__uiVerifyFocus ??= { pending: null, seen: new Set() }
				const sweep = state.__uiVerifyFocus
				const element = document.activeElement as HTMLElement | null
				const container = within ? document.querySelector(within) : null
				const wrapped =
					!element ||
					element === document.body ||
					sweep.seen.has(element) ||
					(container !== null && !container.contains(element))
				if (last) element?.blur()
				// The indicator may sit on a wrapper (focus-within) or on a
				// descendant such as the active option of an
				// aria-activedescendant listbox, so read a little of both.
				const read = (element: HTMLElement) =>
					[
						element,
						element.parentElement,
						element.parentElement?.parentElement,
						...Array.from(element.querySelectorAll('*')).slice(0, 60),
					]
						.filter((node): node is HTMLElement => node instanceof HTMLElement)
						.map((node) => {
							const style = getComputedStyle(node)
							return [
								style.outlineStyle === 'none'
									? 'none'
									: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`,
								style.boxShadow,
								style.borderColor,
								style.backgroundColor,
							].join('|')
						})
						.join(';')
				const finished = sweep.pending
					? {
							description: sweep.pending.description,
							onScreen: sweep.pending.onScreen,
							hasIndicator:
								read(sweep.pending.element) !== sweep.pending.focused,
						}
					: null
				sweep.pending = null
				if (last || wrapped) {
					delete state.__uiVerifyFocus
					document.querySelector('style[data-ui-verify]')?.remove()
					return { finished, done: true, truncated: !wrapped }
				}
				sweep.seen.add(element)
				if (element.tagName !== 'IFRAME') {
					const rect = element.getBoundingClientRect()
					const name = (
						element.getAttribute('aria-label') ??
						element.getAttribute('title') ??
						element.textContent ??
						''
					)
						.replace(/\s+/g, ' ')
						.trim()
						.slice(0, 60)
					const role = element.getAttribute('role')
					const testId = element.dataset.testid
					sweep.pending = {
						element,
						focused: read(element),
						onScreen: rect.width > 0 && rect.height > 0,
						description: `<${element.tagName.toLowerCase()}${role ? ` role="${role}"` : ''}${testId ? ` data-testid="${testId}"` : ''}> ${name ? `"${name}"` : '(no text)'}`,
					}
				}
				return { finished, done: false, truncated: false }
			},
			{ within: options.within ?? null, last: index === maxStops },
		)
		if (step.finished) stops.push(step.finished)
		if (step.done) return { stops, truncated: step.truncated ? maxStops : null }
	}
	return { stops, truncated: null }
}

export function describeFocusProblems({ stops, truncated }: FocusSweep) {
	const problems = stops.flatMap((stop) => {
		const problems: string[] = []
		if (!stop.hasIndicator)
			problems.push(`${stop.description}: no visible focus indicator`)
		if (!stop.onScreen)
			problems.push(`${stop.description}: receives focus but has no size`)
		return problems
	})
	if (truncated !== null)
		problems.push(
			`stopped after ${truncated} focus stops before the tab order wrapped; the rest of the page was not checked. Pass a higher maxStops to sweepFocus for this target.`,
		)
	return problems
}
