import {
	createElement,
	Fragment,
	type ElementType,
	type ReactElement,
	type ReactNode,
} from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { Checkbox, Radio, Switch } from './choice-controls.tsx'
import { Field } from './field.tsx'
import { Input, Select, Textarea } from './input.tsx'

// Loosely typed so props can carry children and data-* attributes like JSX.
const h = createElement as (
	type: ElementType,
	props?: Record<string, unknown> | null,
	...children: ReactNode[]
) => ReactElement

// Emotion streams <style> tags between elements; structure checks skip them.
function markup(node: ReactNode) {
	return renderToStaticMarkup(node).replace(
		/<style\b[^>]*>[\s\S]*?<\/style>/g,
		'',
	)
}

function openingTag(html: string, tag: string) {
	const match = html.match(new RegExp(`<${tag}\\b[^>]*>`))
	if (!match) throw new Error(`<${tag}> missing from ${html}`)
	return match[0]
}

function attribute(tag: string, name: string) {
	return tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1]
}

function describedByIds(html: string) {
	return [...html.matchAll(/<p id="([^"]+)"/g)].map((match) => match[1])
}

test('Field wraps its control in the label and announces the description', () => {
	const html = markup(
		h(
			Field,
			{ label: 'Email', description: 'We never share it.' },
			h(Input, { type: 'email', name: 'email' }),
		),
	)
	expect(html).toMatch(
		/<label[^>]*><span[^>]*>Email<\/span><input[^>]*><\/label>/,
	)
	const input = openingTag(html, 'input')
	expect(attribute(openingTag(html, 'label'), 'for')).toBeUndefined()
	expect(attribute(input, 'id')).toBeUndefined()
	expect(attribute(input, 'aria-describedby')).toBe(
		describedByIds(html).join(' '),
	)
	expect(input).not.toContain('aria-invalid')
	expect(html).toMatch(
		/<p id="[^"]+-description"[^>]*>We never share it\.<\/p>/,
	)
})

test('Field error marks the control invalid and announces the message', () => {
	const html = markup(
		h(
			Field,
			{
				label: 'Name',
				description: 'Shown on your profile.',
				error: 'Name is required.',
			},
			h(Textarea, { name: 'name', 'aria-describedby': 'extra-hint' }),
		),
	)
	const textarea = openingTag(html, 'textarea')
	const [descriptionId, errorId] = describedByIds(html)
	expect(errorId).toMatch(/-error$/)
	expect(attribute(textarea, 'aria-invalid')).toBe('true')
	expect(attribute(textarea, 'aria-describedby')).toBe(
		`${descriptionId} ${errorId} extra-hint`,
	)
	expect(html).toMatch(/<p id="[^"]+-error"[^>]*>Name is required\.<\/p>/)
})

test('Field without description or error renders no ids', () => {
	const html = markup(
		h(
			Field,
			{ label: 'Plan' },
			h(Select, { name: 'plan' }, h('option', { value: 'free' }, 'Free')),
		),
	)
	expect(html).not.toContain(' id=')
	expect(html).not.toContain('aria-describedby')
	expect(html).toMatch(/<label[^>]*><span[^>]*>Plan<\/span><select/)
})

test('controls keep native attributes and explicit ids outside a Field', () => {
	const html = markup(
		h(Input, {
			id: 'search',
			type: 'search',
			'aria-label': 'Search packages',
			placeholder: 'Search',
			'data-testid': 'search',
		}),
	)
	const input = openingTag(html, 'input')
	expect(attribute(input, 'id')).toBe('search')
	expect(attribute(input, 'type')).toBe('search')
	expect(attribute(input, 'aria-label')).toBe('Search packages')
	expect(attribute(input, 'data-testid')).toBe('search')
	expect(input).not.toContain('aria-describedby')
})

test('Checkbox and Radio render native inputs with their roles', () => {
	const html = markup(
		h(
			Fragment,
			null,
			h(
				'label',
				null,
				h(Checkbox, { name: 'all', checked: true, onChange() {} }),
				' All',
			),
			h(
				'label',
				null,
				h(Radio, { name: 'mode', value: 'a', defaultChecked: true }),
				' A',
			),
		),
	)
	expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*checked=""/)
	expect(html).toMatch(/<input[^>]*type="radio"[^>]*checked=""/)
})

test('a mixed Checkbox is not reported as checked before hydration', () => {
	const html = markup(
		h(Checkbox, {
			'aria-label': 'Select all',
			checked: 'mixed',
			onChange() {},
		}),
	)
	expect(openingTag(html, 'input')).not.toContain('checked=""')
})

test('Switch is a button with the switch role and checked state', () => {
	const on = markup(
		h(Switch, {
			'aria-label': 'Notifications',
			checked: true,
			onCheckedChange() {},
		}),
	)
	const off = markup(
		h(Switch, {
			'aria-label': 'Notifications',
			checked: false,
			onCheckedChange() {},
			disabled: true,
		}),
	)
	const onTag = openingTag(on, 'button')
	const offTag = openingTag(off, 'button')
	expect(attribute(onTag, 'type')).toBe('button')
	expect(attribute(onTag, 'role')).toBe('switch')
	expect(attribute(onTag, 'aria-checked')).toBe('true')
	expect(attribute(offTag, 'aria-checked')).toBe('false')
	expect(offTag).toContain('disabled=""')
})

test('Switch inside a Field is labelled by the field label', () => {
	const html = markup(
		h(
			Field,
			{ label: 'Email me updates' },
			h(Switch, { checked: false, onCheckedChange() {} }),
		),
	)
	expect(html).toMatch(
		/<label[^>]*><span[^>]*>Email me updates<\/span><button[^>]*role="switch"/,
	)
})
