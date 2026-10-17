/** @jsxImportSource @emotion/react */

/** @jsxRuntime automatic */
import { type CSSObject } from '@emotion/react'

import { renderIcon, type IconName } from './icon.tsx'
import { colors } from '#universal/styles/tokens.ts'

export type PackageStatusSignifier = {
	kind: 'package' | 'repo' | 'private' | 'unpublished'
	name: IconName
	title: string
}

export type PackageStatusSignifiersInput = {
	isPrivate: boolean
	isListed: boolean
	/**
	 * Same grammar as the repositories list (`profile-content` box/folder).
	 * Defaults to true so existing package chrome callers stay package-shaped.
	 */
	hasPackage?: boolean
}

/**
 * Small icon + native tooltip, same grammar as the repositories list
 * package / webhook / job / app signifiers. Package/Repo marks mirror the
 * list. Private is the lock. Not published is only for unlisted public
 * packages — plain repos and private packages skip that mark.
 */
export function listPackageStatusSignifiers(
	input: PackageStatusSignifiersInput,
): Array<PackageStatusSignifier> {
	const hasPackage = input.hasPackage !== false
	const signifiers: Array<PackageStatusSignifier> = hasPackage
		? [{ kind: 'package' as const, name: 'box' as const, title: 'Package' }]
		: [{ kind: 'repo' as const, name: 'folder' as const, title: 'Repo' }]
	if (input.isPrivate) {
		signifiers.push({ kind: 'private', name: 'lock', title: 'Private' })
		return signifiers
	}
	if (hasPackage && !input.isListed) {
		signifiers.push({
			kind: 'unpublished',
			name: 'file',
			title: 'Not published',
		})
	}
	return signifiers
}

export function renderPackageStatusSignifiers(
	input: PackageStatusSignifiersInput,
) {
	const signifiers = listPackageStatusSignifiers(input)
	if (signifiers.length === 0) return null
	return (
		<span
			data-testid="package-visibility-badge"
			data-visibility={input.isPrivate ? 'private' : 'public'}
			css={signifiersCss}
		>
			{signifiers.map((signifier) => (
				<span
					key={signifier.kind}
					title={signifier.title}
					data-signifier={signifier.kind}
					css={signifierCss}
				>
					{renderIcon(signifier.name, {
						size: '0.95em',
						title: signifier.title,
					})}
				</span>
			))}
		</span>
	)
}

const signifiersCss = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: '0.3rem',
	flex: 'none',
	color: colors.textMuted,
} satisfies CSSObject

const signifierCss = {
	display: 'inline-flex',
	alignItems: 'center',
	lineHeight: 0,
} satisfies CSSObject
