/** @jsxImportSource @emotion/react */
import {
	createContext,
	use,
	type ComponentProps,
	type HTMLInputTypeAttribute,
} from 'react'
import { useFieldControl } from './field.tsx'
import {
	getFieldControlCss,
	getInputAddonCss,
	getInputGroupControlCss,
	getInputGroupCss,
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
	const group = use(InputGroupContext)
	return (
		<input
			data-field-ring
			css={
				group
					? getInputGroupControlCss(group)
					: getFieldControlCss({ size, background })
			}
			{...props}
			{...fieldProps}
		/>
	)
}

const InputGroupContext = createContext<FieldControlStyleOptions | null>(null)

export type InputGroupProps = ComponentProps<'span'> & FieldControlStyleOptions

/**
 * Joins an `InputAddon` and an `Input` into one control: one border, rounded
 * outer corners, square inner corners, and a focus ring around the whole
 * group. Set `size` and `background` here; the `Input` inside follows them.
 */
export function InputGroup({ size, background, ...props }: InputGroupProps) {
	return (
		<InputGroupContext value={{ size, background }}>
			<span css={getInputGroupCss({ size, background })} {...props} />
		</InputGroupContext>
	)
}

/** Static text at the start of an `InputGroup`, such as `kody.codes/@`. */
export function InputAddon(props: ComponentProps<'span'>) {
	const group = use(InputGroupContext)
	return <span css={getInputAddonCss(group ?? {})} {...props} />
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
