/** @jsxImportSource @emotion/react */
import {
	createContext,
	use,
	useId,
	type ComponentProps,
	type ReactNode,
} from 'react'
import {
	fieldCss,
	fieldDescriptionCss,
	fieldErrorCss,
	fieldLabelCss,
	fieldLabelRowCss,
} from '#universal/styles/style-primitives.ts'

type FieldControlContext = {
	id: string
	describedBy: string | undefined
	invalid: boolean
}

const FieldContext = createContext<FieldControlContext | null>(null)

export type FieldProps = Omit<ComponentProps<'div'>, 'children'> & {
	label: ReactNode
	/** Quiet action on the label row, such as a "Forgot password?" link. */
	labelAction?: ReactNode
	/** Help text, announced with the control through `aria-describedby`. */
	description?: ReactNode
	/** Marks the control invalid and announces the message with it. */
	error?: ReactNode
	/** The control: `Input`, `Textarea`, `Select`, or a custom control that calls `useFieldControl`. */
	children: ReactNode
	/** Id for the control; generated when omitted. */
	controlId?: string
}

/**
 * Labelled form field. Wires the label, description, and error to the
 * control it wraps so the control never ships unlabelled or with
 * unannounced help text.
 */
export function Field({
	label,
	labelAction,
	description,
	error,
	children,
	controlId,
	...props
}: FieldProps) {
	const generatedId = useId()
	const id = controlId ?? generatedId
	const descriptionId = description ? `${id}-description` : undefined
	const errorId = error ? `${id}-error` : undefined
	const describedBy =
		[descriptionId, errorId].filter(Boolean).join(' ') || undefined
	const labelElement = (
		<label htmlFor={id} css={fieldLabelCss}>
			{label}
		</label>
	)
	return (
		<div css={fieldCss} {...props}>
			{labelAction ? (
				<div css={fieldLabelRowCss}>
					{labelElement}
					{labelAction}
				</div>
			) : (
				labelElement
			)}
			<FieldContext value={{ id, describedBy, invalid: Boolean(error) }}>
				{children}
			</FieldContext>
			{description ? (
				<p id={descriptionId} css={fieldDescriptionCss}>
					{description}
				</p>
			) : null}
			{error ? (
				<p id={errorId} css={fieldErrorCss}>
					{error}
				</p>
			) : null}
		</div>
	)
}

/**
 * Props a control spreads to join its enclosing `Field`. Explicit props win,
 * so a control outside a field, or one with its own `id`, keeps them.
 */
export function useFieldControl(props: {
	id?: string
	'aria-describedby'?: string
	'aria-invalid'?: ComponentProps<'input'>['aria-invalid']
}) {
	const field = use(FieldContext)
	return {
		id: props.id ?? field?.id,
		'aria-describedby':
			[field?.describedBy, props['aria-describedby']]
				.filter(Boolean)
				.join(' ') || undefined,
		'aria-invalid':
			props['aria-invalid'] ?? (field?.invalid ? true : undefined),
	}
}
