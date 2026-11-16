/** @jsxImportSource @emotion/react */
import { useEffect, useRef, type ComponentProps, type Ref } from 'react'
import { useFieldControl } from './field.tsx'
import { colors, radius } from '#universal/styles/tokens.ts'
import { choiceControlCss } from '#universal/styles/style-primitives.ts'

export type CheckboxProps = Omit<
	ComponentProps<'input'>,
	'type' | 'checked'
> & {
	/** `'mixed'` shows the indeterminate state of a partly selected group. */
	checked?: boolean | 'mixed'
}

export function Checkbox({ checked, ref, ...props }: CheckboxProps) {
	const innerRef = useRef<HTMLInputElement>(null)
	useEffect(() => {
		if (innerRef.current) innerRef.current.indeterminate = checked === 'mixed'
	}, [checked])
	const fieldProps = useFieldControl(props)
	return (
		<input
			ref={mergeRefs(innerRef, ref)}
			type="checkbox"
			css={choiceControlCss}
			checked={checked === undefined ? undefined : checked === true}
			{...props}
			{...fieldProps}
		/>
	)
}

export type RadioProps = Omit<ComponentProps<'input'>, 'type'>

export function Radio(props: RadioProps) {
	const fieldProps = useFieldControl(props)
	return (
		<input type="radio" css={choiceControlCss} {...props} {...fieldProps} />
	)
}

export type SwitchProps = Omit<
	ComponentProps<'button'>,
	'role' | 'type' | 'onChange' | 'value'
> & {
	checked: boolean
	onCheckedChange: (checked: boolean) => void
}

/**
 * On/off toggle that applies immediately. Renders `role="switch"` on a
 * button, so Space and Enter toggle it. Give it an accessible name with
 * `aria-label`, `aria-labelledby`, or a `Field` label.
 */
export function Switch({
	checked,
	onCheckedChange,
	onClick,
	...props
}: SwitchProps) {
	const fieldProps = useFieldControl(props)
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			css={switchCss}
			onClick={(event) => {
				onClick?.(event)
				if (!event.defaultPrevented) onCheckedChange(!checked)
			}}
			{...props}
			{...fieldProps}
		/>
	)
}

function mergeRefs<T>(...refs: Array<Ref<T> | undefined>) {
	return (value: T | null) => {
		for (const ref of refs) {
			if (typeof ref === 'function') ref(value)
			else if (ref) ref.current = value
		}
	}
}

const switchCss = {
	appearance: 'none' as const,
	flex: 'none',
	width: '2.75rem',
	height: '1.55rem',
	padding: 0,
	// oxlint-disable-next-line kody-custom/no-raw-button-style -- a switch track is a pill by convention, not a button shape
	borderRadius: radius.full,
	border: `1px solid ${colors.border}`,
	background: colors.surface,
	position: 'relative' as const,
	cursor: 'pointer',
	transition: 'background-color 120ms ease, border-color 120ms ease',
	'&::after': {
		content: '""',
		position: 'absolute' as const,
		top: '0.15rem',
		left: '0.15rem',
		width: '1.15rem',
		height: '1.15rem',
		borderRadius: radius.full,
		background: colors.textMuted,
		transition: 'transform 120ms ease, background-color 120ms ease',
	},
	'&[aria-checked="true"]': {
		background: colors.primarySoft,
		borderColor: colors.primary,
	},
	'&[aria-checked="true"]::after': {
		transform: 'translateX(1.15rem)',
		background: colors.primary,
	},
	'&:disabled': {
		opacity: 0.55,
		cursor: 'not-allowed',
	},
	'@media (prefers-reduced-motion: reduce)': {
		transition: 'none',
		'&::after': { transition: 'none' },
	},
}
