/** @jsxImportSource @emotion/react */
import type { ComponentProps, HTMLInputTypeAttribute } from 'react'
import { useFieldControl } from './field.tsx'
import {
	getFieldControlCss,
	getSelectControlCss,
	getTextareaControlCss,
	type FieldControlStyleOptions,
} from '#universal/styles/style-primitives.ts'

type TextInputType = Exclude<
	HTMLInputTypeAttribute,
	| 'checkbox'
	| 'radio'
	| 'hidden'
	| 'file'
	| 'range'
	| 'color'
	| 'button'
	| 'submit'
	| 'reset'
	| 'image'
>

export type InputProps = Omit<ComponentProps<'input'>, 'size' | 'type'> &
	FieldControlStyleOptions & { type?: TextInputType }

/** Text-like input. Use `Checkbox`, `Radio`, or `Button` for the other types. */
export function Input({ size, background, ...props }: InputProps) {
	const fieldProps = useFieldControl(props)
	return (
		<input
			data-field-ring
			css={getFieldControlCss({ size, background })}
			{...props}
			{...fieldProps}
		/>
	)
}

export type TextareaProps = ComponentProps<'textarea'> &
	FieldControlStyleOptions

export function Textarea({ size, background, ...props }: TextareaProps) {
	const fieldProps = useFieldControl(props)
	return (
		<textarea
			data-field-ring
			css={getTextareaControlCss({ size, background })}
			{...props}
			{...fieldProps}
		/>
	)
}

export type SelectProps = Omit<ComponentProps<'select'>, 'size'> &
	FieldControlStyleOptions

/** Native select with the field look. Never render an unstyled `<select>`. */
export function Select({ size, background, ...props }: SelectProps) {
	const fieldProps = useFieldControl(props)
	return (
		<select
			data-field-ring
			css={getSelectControlCss({ size, background })}
			{...props}
			{...fieldProps}
		/>
	)
}
