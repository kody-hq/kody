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
} from '#universal/styles/style-primitives.ts'

type FieldControlContext = {
	describedBy: string | undefined
	invalid: boolean
}

// In a grid row with a taller sibling, keep the control at its own height.
const fieldStackCss = { ...fieldCss, alignContent: 'start' } as const

const FieldContext = createContext<FieldControlContext | null>(null)

export type FieldProps = Omit<ComponentProps<'div'>, 'children'> & {
	label: ReactNode
	/** Help text, announced with the control through `aria-describedby`. */
	description?: ReactNode
	/** Marks the control invalid and announces the message with it. */
	error?: ReactNode
	/** The control: `Input`, `Textarea`, `Select`, or a custom control that calls `useFieldControl`. */
	children: ReactNode
}

/**
 * Labelled form field. The label wraps the control, so it is labelled without
 * ids; description and error are wired through `aria-describedby`.
 */
export function Field({
	label,
	description,
	error,
	children,
	...props
}: FieldProps) {
	// Redact's useId counts in render order, which streamed boundaries can
	// reorder between server and client, so ids exist only where ARIA needs them.
	const id = useId()
	const descriptionId = description ? `${id}-description` : undefined
	const errorId = error ? `${id}-error` : undefined
	const describedBy =
		[descriptionId, errorId].filter(Boolean).join(' ') || undefined
	return (
		<div css={fieldStackCss} {...props}>
			<label css={fieldStackCss}>
				<span css={fieldLabelCss}>{label}</span>
				<FieldContext value={{ describedBy, invalid: Boolean(error) }}>
					{children}
				</FieldContext>
			</label>
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
 * so a control outside a field keeps its own.
 */
export function useFieldControl(props: {
	'aria-describedby'?: string
	'aria-invalid'?: ComponentProps<'input'>['aria-invalid']
}) {
	const field = use(FieldContext)
	return {
		'aria-describedby':
			[field?.describedBy, props['aria-describedby']]
				.filter(Boolean)
				.join(' ') || undefined,
		'aria-invalid':
			props['aria-invalid'] ?? (field?.invalid ? true : undefined),
	}
}
