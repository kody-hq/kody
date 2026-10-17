/** @jsxImportSource @emotion/react */
import { publicAsset } from '../public-assets.ts'
/** @jsxRuntime automatic */
import { identityIconMonogramLetter } from '#universal/identity-icon-leaf.ts'
import { getLogoWellCss } from '#universal/styles/style-primitives.ts'
import { colors } from '#universal/styles/tokens.ts'

type IdentityIconMarkSize = 'card' | 'starter' | 'detail'

type IdentityIconMarkProps = {
	name: string
	iconUrl: string | null
	size: IdentityIconMarkSize
	testId?: string
}

const iconWellBySize = {
	card: { size: '2.4rem', radius: '10px', borderWidth: '1px' },
	starter: { size: '3.2rem', radius: '12px', borderWidth: '1px' },
	detail: { size: '3.6rem', radius: '14px', borderWidth: '1.5px' },
} as const

/**
 * Repo/package list mark: fitted icon when a URL exists, otherwise a
 * monogram from the repo or package leaf name.
 */
export function IdentityIconMark(props: IdentityIconMarkProps) {
	const { name, iconUrl, size, testId } = props
	const well = iconWellBySize[size]
	const isDetail = size === 'detail'
	return (
		<span
			css={{
				...getLogoWellCss(well),
				display: 'block',
			}}
			data-testid={testId ?? `identity-icon-mark-${size}`}
		>
			{iconUrl ? (
				<img
					src={publicAsset(iconUrl)}
					alt=""
					aria-hidden="true"
					width={isDetail ? 88 : 56}
					height={isDetail ? 88 : 56}
					loading={isDetail ? 'eager' : 'lazy'}
					css={{
						display: 'block',
						width: '100%',
						height: '100%',
						objectFit: 'contain',
					}}
				/>
			) : (
				<span
					css={{
						display: 'grid',
						placeItems: 'center',
						width: '100%',
						height: '100%',
						color: colors.text,
						fontWeight: 700,
						fontSize: isDetail ? '1.35rem' : '1rem',
						lineHeight: 1,
					}}
					aria-hidden="true"
				>
					{identityIconMonogramLetter(name)}
				</span>
			)}
		</span>
	)
}
