/** @jsxImportSource @emotion/react */
import type { ComponentProps, JSX } from 'react'
import { SiteLink } from './site-link.tsx'
import {
	getButtonCss,
	type ButtonStyleOptions,
} from '#universal/styles/style-primitives.ts'

type ButtonElementProps = ButtonStyleOptions &
	ComponentProps<'button'> & { href?: undefined }

type ButtonLinkProps = ButtonStyleOptions &
	ComponentProps<typeof SiteLink> & { href: string }

export type ButtonProps = ButtonElementProps | ButtonLinkProps

/**
 * The one button. Renders a `<button>`, or a `SiteLink` when given `href`
 * (pass `reloadDocument` for a plain document navigation). Extra `css`
 * composes after the shared look, for layout only.
 */
export function Button(props: ButtonLinkProps): JSX.Element
export function Button(props: ButtonElementProps): JSX.Element
export function Button(props: ButtonProps) {
	if (props.href !== undefined) {
		const { variant, size, iconOnly, mobileFullWidth, ...linkProps } = props
		return (
			<SiteLink
				css={getButtonCss({ variant, size, iconOnly, mobileFullWidth })}
				{...linkProps}
			/>
		)
	}
	const { variant, size, iconOnly, mobileFullWidth, ...buttonProps } = props
	return (
		<button
			css={getButtonCss({ variant, size, iconOnly, mobileFullWidth })}
			{...buttonProps}
		/>
	)
}
