/** @jsxImportSource @emotion/react */
import { dismissOpenPopoverPanel } from '#client/popover-open.ts'
import { useEffect, useId, useRef, useState } from 'react'
import { colors, radius, shadows, spacing } from '#universal/styles/tokens.ts'
import {
	fieldLabelCss,
	getSelectCss,
	visuallyHiddenCss,
} from '#universal/styles/style-primitives.ts'
import { renderIcon } from './icon.tsx'

export type ComboboxOption = {
	id: string
	label: string
	keywords?: Array<string>
}
type ComboboxProps = {
	id: string
	label: string
	hideLabel?: boolean
	placeholder?: string
	value: string
	options: Array<ComboboxOption>
	disabled?: boolean
	onChange: (value: string) => void
}

export function Combobox(props: ComboboxProps) {
	const listId = useId()
	const input = useRef<HTMLInputElement>(null)
	const list = useRef<HTMLDivElement>(null)
	const label = props.value
		? (props.options.find((option) => option.id === props.value)?.label ?? '')
		: ''
	const [external, setExternal] = useState(label)
	const [draft, setDraft] = useState(label)
	const [open, setOpen] = useState(false)
	const [query, setQuery] = useState('')
	const [active, setActive] = useState(0)
	if (external !== label) {
		setExternal(label)
		setDraft(label)
		setQuery('')
		setActive(0)
	}
	const normalized = query.toLocaleLowerCase()
	const options = props.options.filter((option) =>
		[
			option.label,
			...option.label.split(/[^\p{L}\p{N}]+/u).slice(1),
			...(option.keywords ?? []),
		].some((value) => value.toLocaleLowerCase().startsWith(normalized)),
	)
	const activeOption =
		options[Math.min(active, Math.max(options.length - 1, 0))]
	useEffect(() => {
		const panel = list.current
		const field = input.current
		if (!panel || !field) return
		if (!open || props.disabled) {
			dismissOpenPopoverPanel(panel)
			return
		}
		panel.showPopover()
		function position() {
			if (!panel || !field) return
			const rect = field.getBoundingClientRect()
			panel.style.left = `${rect.left}px`
			panel.style.width = `${rect.width}px`
			const available = window.innerHeight - rect.bottom
			panel.style.maxHeight = `${Math.min(280, Math.max(140, available - 8))}px`
			panel.style.top = `${available < 140 ? Math.max(8, rect.top - Math.min(panel.scrollHeight, 280)) : rect.bottom + 4}px`
		}
		position()
		window.addEventListener('resize', position)
		window.addEventListener('scroll', position, true)
		return () => {
			window.removeEventListener('resize', position)
			window.removeEventListener('scroll', position, true)
			dismissOpenPopoverPanel(panel)
		}
	}, [open, props.disabled, options.length])
	useEffect(() => {
		if (open && activeOption)
			document
				.getElementById(`${listId}-${activeOption.id}`)
				?.scrollIntoView({ block: 'nearest' })
	}, [open, activeOption, listId])
	function choose(option: ComboboxOption) {
		setDraft(option.label)
		setQuery('')
		setOpen(false)
		props.onChange(option.id)
	}
	return (
		<div css={{ display: 'grid', gap: spacing.xs, minWidth: 0 }}>
			<label
				htmlFor={props.id}
				css={props.hideLabel ? visuallyHiddenCss : fieldLabelCss}
			>
				{props.label}
			</label>
			<input
				ref={input}
				id={props.id}
				data-field-ring
				role="combobox"
				aria-expanded={open}
				aria-controls={listId}
				aria-autocomplete="list"
				aria-activedescendant={
					open && activeOption ? `${listId}-${activeOption.id}` : undefined
				}
				disabled={props.disabled}
				value={draft}
				placeholder={props.placeholder}
				autoComplete="off"
				css={{ ...getSelectCss(), cursor: 'text' }}
				onFocus={() => {
					setOpen(true)
					setQuery('')
				}}
				onChange={(event) => {
					setDraft(event.currentTarget.value)
					setQuery(event.currentTarget.value)
					setActive(0)
					setOpen(true)
				}}
				onBlur={() => {
					const exact = props.options.find((option) => option.label === draft)
					if (exact) choose(exact)
					else {
						setDraft(label)
						setQuery('')
						setOpen(false)
					}
				}}
				onKeyDown={(event) => {
					if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
						event.preventDefault()
						setOpen(true)
						setActive((index) =>
							Math.max(
								0,
								Math.min(
									options.length - 1,
									index + (event.key === 'ArrowDown' ? 1 : -1),
								),
							),
						)
					} else if (open && (event.key === 'Home' || event.key === 'End')) {
						event.preventDefault()
						setActive(
							event.key === 'Home' ? 0 : Math.max(options.length - 1, 0),
						)
					} else if (open && event.key === 'Enter') {
						event.preventDefault()
						if (activeOption) choose(activeOption)
					} else if (event.key === 'Escape') {
						event.preventDefault()
						setOpen(false)
						setDraft(label)
						setQuery('')
					}
				}}
			/>
			<div
				ref={list}
				id={listId}
				popover="manual"
				role="listbox"
				aria-label={props.label}
				css={{
					position: 'fixed',
					inset: 'auto',
					margin: 0,
					boxSizing: 'border-box',
					padding: spacing.xs,
					border: `1px solid ${colors.border}`,
					borderRadius: radius.md,
					boxShadow: shadows.md,
					background: colors.surface,
					color: colors.text,
					overflowY: 'auto',
					zIndex: 1000,
				}}
			>
				{options.map((option, index) => (
					<button
						key={option.id}
						id={`${listId}-${option.id}`}
						role="option"
						aria-selected={option.id === props.value}
						type="button"
						tabIndex={-1}
						onMouseDown={(event) => event.preventDefault()}
						onMouseMove={() => setActive(index)}
						onClick={() => choose(option)}
						css={{
							display: 'flex',
							alignItems: 'center',
							gap: spacing.sm,
							width: '100%',
							border: 0,
							borderRadius: radius.sm,
							padding: spacing.sm,
							textAlign: 'left',
							font: 'inherit',
							cursor: 'pointer',
							background:
								activeOption?.id === option.id
									? colors.primarySoft
									: 'transparent',
							color: colors.text,
						}}
					>
						<span
							aria-hidden="true"
							css={{
								width: '1rem',
								visibility: option.id === props.value ? 'visible' : 'hidden',
							}}
						>
							{renderIcon('check', { size: '1rem' })}
						</span>
						{option.label}
					</button>
				))}
			</div>
		</div>
	)
}
