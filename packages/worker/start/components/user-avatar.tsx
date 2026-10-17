/** @jsxImportSource @emotion/react */
/** @jsxRuntime automatic */
import { type CSSObject } from '@emotion/react'
import { colors, radius, typography } from '#universal/styles/tokens.ts'

/**
 * Single pixel size, or a pair that this component owns in its own `css()`
 * layer. Caller descendant rules cannot shrink the face , every `css()` class
 * gets `@layer rmx.<class>`, and this component registers after its caller.
 */
export type UserAvatarSize =
	| number
	| {
			narrow: number
			wide: number
			/** Default 821 matches the site-header hamburger / profile stack. */
			wideMinWidth?: number
	  }

export type UserAvatarProps = {
	displayName: string
	avatarUrl: string | null
	size: UserAvatarSize
	testId?: string
	/**
	 * `well` is the redesign's avatar well , page surface behind a hairline
	 * ring, initials in the display face and the accent colour. It has to be a
	 * variant rather than something a caller layers on from a wrapper: every
	 * `css()` class gets its own `@layer rmx.<class>`, and this component's
	 * class is registered after its caller's, so a caller's descendant rule
	 * silently loses to whatever is declared here.
	 */
	variant?: 'plain' | 'well'
}

function intrinsicUserAvatarSize(size: UserAvatarSize) {
	return typeof size === 'number' ? size : size.wide
}

function avatarFaceSizeCss(input: {
	size: UserAvatarSize
	well: boolean
}): CSSObject {
	const fontFactor = input.well ? 0.36 : 0.4
	const minFont = input.well ? 11 : 12
	const fontPx = (px: number) =>
		`${Math.max(minFont, Math.round(px * fontFactor))}px`

	if (typeof input.size === 'number') {
		return {
			width: `${input.size}px`,
			height: `${input.size}px`,
			fontSize: fontPx(input.size),
		}
	}

	const minWidth = input.size.wideMinWidth ?? 821
	return {
		width: `${input.size.narrow}px`,
		height: `${input.size.narrow}px`,
		fontSize: fontPx(input.size.narrow),
		[`@media (min-width: ${minWidth}px)`]: {
			width: `${input.size.wide}px`,
			height: `${input.size.wide}px`,
			fontSize: fontPx(input.size.wide),
		},
	}
}

export function UserAvatar(props: UserAvatarProps) {
	// Props must be read inside the render function so updates (for example
	// the account page swapping the avatar after an upload) re-render.

	const { displayName, avatarUrl, size, testId, variant } = props
	const initial = displayName.trim().charAt(0).toUpperCase() || '?'
	const well = variant === 'well'
	const intrinsic = intrinsicUserAvatarSize(size)
	const sizeStyle = {
		...avatarFaceSizeCss({ size, well }),
		borderRadius: radius.full,
		flexShrink: '0',
		boxSizing: 'border-box' as const,
		...(well ? { border: `1px solid ${colors.border}` } : {}),
	}
	const fill = well ? colors.surface : colors.primarySoftest

	return avatarUrl ? (
		<img
			src={avatarUrl}
			alt=""
			width={intrinsic}
			height={intrinsic}
			data-testid={testId}
			css={{
				...sizeStyle,
				objectFit: 'cover',
				display: 'block',
				backgroundColor: fill,
			}}
		/>
	) : (
		<span
			aria-hidden="true"
			data-testid={testId}
			css={{
				...sizeStyle,
				display: 'inline-flex',
				alignItems: 'center',
				justifyContent: 'center',
				backgroundColor: fill,
				color: well ? colors.primaryText : colors.textMuted,
				fontFamily: well ? typography.fontFamilyDisplay : undefined,
				fontWeight: well ? 700 : typography.fontWeight.semibold,
				lineHeight: 1,
				userSelect: 'none',
			}}
		>
			{initial}
		</span>
	)
}
