import { createElement as h, Fragment } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { Checkbox, Radio, Switch } from './choice-controls.tsx'
import { Field } from './field.tsx'
import { Input, Select, Textarea } from './input.tsx'

function openingTag(html: string, tag: string) {
	const match = html.match(new RegExp(`<${tag}\\b[^>]*>`))
	if (!match) throw new Error(`<${tag}> missing from ${html}`)
	return match[0]
}

function attribute(tag: string, name: string) {
	return tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1]
}

test('Field labels its control and announces the description', () => {
	const html = renderToStaticMarkup(
		h(
			Field,
			{ label: 'Email', description: 'We never share it.', controlId: 'email' },
			h(Input, { type: 'email', name: 'email' }),
		),
	)
	const input = openingTag(html, 'input')
	const label = openingTag(html, 'label')
	expect(attribute(label, 'for')).toBe('email')
	expect(attribute(input, 'id')).toBe('email')
	expect(attribute(input, 'aria-describedby')).toBe('email-description')
	expect(input).not.toContain('aria-invalid')
	expect(html).toMatch(
		/<p id="email-description"[^>]*>We never share it\.<\/p>/,
	)
})

test('Field error marks the control invalid and announces the message', () => {
	const html = renderToStaticMarkup(
		h(
			Field,
			{
				label: 'Name',
				description: 'Shown on your profile.',
				error: 'Name is required.',
				controlId: 'name',
			},
			h(Textarea, { name: 'name', 'aria-describedby': 'extra-hint' }),
		),
	)
	const textarea = openingTag(html, 'textarea')
	expect(attribute(textarea, 'aria-invalid')).toBe('true')
	expect(attribute(textarea, 'aria-describedby')).toBe(
		'name-description name-error extra-hint',
	)
	expect(html).toMatch(/<p id="name-error"[^>]*>Name is required\.<\/p>/)
})

test('Field generates a stable id when none is given', () => {
	const html = renderToStaticMarkup(
		h(
			Field,
			{ label: 'Plan' },
			h(Select, { name: 'plan' }, h('option', { value: 'free' }, 'Free')),
		),
	)
	const select = openingTag(html, 'select')
	const label = openingTag(html, 'label')
	expect(attribute(select, 'id')).toBeTruthy()
	expect(attribute(label, 'for')).toBe(attribute(select, 'id'))
})

test('controls keep native attributes and explicit ids outside a Field', () => {
	const html = renderToStaticMarkup(
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
	const html = renderToStaticMarkup(
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
	const html = renderToStaticMarkup(
		h(Checkbox, {
			'aria-label': 'Select all',
			checked: 'mixed',
			onChange() {},
		}),
	)
	expect(openingTag(html, 'input')).not.toContain('checked=""')
})

test('Switch is a button with the switch role and checked state', () => {
	const on = renderToStaticMarkup(
		h(Switch, {
			'aria-label': 'Notifications',
			checked: true,
			onCheckedChange() {},
		}),
	)
	const off = renderToStaticMarkup(
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
	const html = renderToStaticMarkup(
		h(
			Field,
			{ label: 'Email me updates', controlId: 'updates' },
			h(Switch, { checked: false, onCheckedChange() {} }),
		),
	)
	expect(attribute(openingTag(html, 'button'), 'id')).toBe('updates')
	expect(attribute(openingTag(html, 'label'), 'for')).toBe('updates')
})
