/** @jsxImportSource @emotion/react */
import type { ComponentProps } from 'react'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'

type AlertTone = 'info' | 'error'

const alertCss = {
	margin: 0,
	padding: spacing.md,
	borderRadius: radius.md,
	borderWidth: '1px',
	borderStyle: 'solid',
	fontSize: typography.fontSize.sm,
}

const toneCss = {
	info: {
		borderColor: colors.primary,
		backgroundColor: colors.primarySoftest,
		color: colors.text,
	},
	error: {
		borderColor: colors.error,
		backgroundColor:
			'color-mix(in srgb, var(--color-danger) 8%, var(--color-surface))',
		color: colors.error,
	},
} satisfies Record<AlertTone, object>

export type AlertProps = ComponentProps<'div'> & { tone?: AlertTone }

/**
 * A boxed message. It sets no role: pass `role="alert"` for an error that
 * appears after a user action, `role="status"` for a polite update, and
 * nothing for a message that is part of the page from the start.
 */
export function Alert({ tone = 'info', ...props }: AlertProps) {
	return <div {...props} css={[alertCss, toneCss[tone]]} />
}
