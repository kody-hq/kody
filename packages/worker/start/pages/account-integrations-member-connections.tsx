/** @jsxImportSource @emotion/react */
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useState } from 'react'
import { useParams } from '@tanstack/react-router'
import { SiteLink } from '../components/site-link.tsx'
import { settleConnectionResources } from '../connection-resource-settlement.ts'
import { useMatchedPageScope } from '../use-matched-page-scope.ts'
import { formatTimestampDate } from '../components/local-timestamp.tsx'
import { buildConnectOauthHref } from '#universal/oauth-connect.ts'
import {
	type AccountOauthAppListItem,
	type OrgAppMemberConnection,
	type OrgAppMemberConnectionsData,
} from '#universal/loader-data.ts'
import { colors, spacing } from '#universal/styles/tokens.ts'
import {
	descriptionCss,
	getPillButtonCss,
	insetCardCss,
	sectionTitleCss,
} from '#universal/styles/style-primitives.ts'
import {
	dangerButtonCss,
	oauthAppTitle,
} from './account-integrations-shared.ts'
import {
	loadOrgAppMemberConnectionsFn,
	revokeOrgAppMemberConnectionFn,
} from '#start/server/org-member-connections'

function memberName(connection: OrgAppMemberConnection) {
	return (
		connection.memberDisplayName?.trim() ||
		connection.memberUsername ||
		'A member'
	)
}

/**
 * Members' own accounts connected through this org OAuth app (ADR 0068
 * amendment 2026-10-29): connect yours, disconnect yours, and for admins,
 * see and revoke everyone's. Metadata only; tokens never reach the page.
 */
export function OrgAppMemberConnections(props: {
	app: AccountOauthAppListItem
}) {
	const { orgSlug } = useParams({ strict: false }) as { orgSlug?: string }
	const appSlug = props.app.slug
	const queryClient = useQueryClient()
	const { actorKey } = useMatchedPageScope()
	const [data, setData] = useState<OrgAppMemberConnectionsData | null>(null)
	const [message, setMessage] = useState<string | null>(null)
	const [armed, setArmed] = useState<string | null>(null)
	const [revoking, setRevoking] = useState<string | null>(null)
	const reload = useCallback(async () => {
		if (!orgSlug) return
		try {
			setData(
				await loadOrgAppMemberConnectionsFn({ data: { orgSlug, appSlug } }),
			)
		} catch (error) {
			setMessage(
				error instanceof Error ? error.message : 'Unable to load connections.',
			)
		}
	}, [orgSlug, appSlug])
	useEffect(() => {
		void reload()
	}, [reload])
	if (!orgSlug || !data?.teamOrg) return null
	if (!data.canConnectOwn && !data.own && !data.canManage) return null
	const title = oauthAppTitle(props.app)

	async function revoke(connection: OrgAppMemberConnection) {
		if (!orgSlug) return
		if (armed !== connection.credentialId) {
			setArmed(connection.credentialId)
			return
		}
		setArmed(null)
		setRevoking(connection.credentialId)
		setMessage(null)
		try {
			const result = await revokeOrgAppMemberConnectionFn({
				data: { orgSlug, credentialId: connection.credentialId },
			})
			setMessage(
				result.upstream === 'revoked' || result.upstream === 'already_invalid'
					? `Removed ${connection.yours ? 'your' : `${memberName(connection)}'s`} connection and revoked it with the provider.`
					: `Removed ${connection.yours ? 'your' : `${memberName(connection)}'s`} connection. The provider did not confirm the revoke, so it may still list this app under the account's authorized apps.`,
			)
			await Promise.all([
				reload(),
				// The page header counts the app's connections.
				settleConnectionResources(queryClient, actorKey, orgSlug, [
					'loadIntegrationsPage',
				]),
			])
		} catch (error) {
			setMessage(
				error instanceof Error
					? error.message
					: 'Unable to revoke that connection.',
			)
		} finally {
			setRevoking(null)
		}
	}

	function revokeButton(connection: OrgAppMemberConnection) {
		const verb = connection.yours ? 'Disconnect' : 'Revoke'
		const confirming = armed === connection.credentialId
		return (
			<button
				type="button"
				data-testid="revoke-member-connection"
				css={dangerButtonCss}
				disabled={revoking === connection.credentialId}
				onBlur={() => setArmed(null)}
				onClick={() => void revoke(connection)}
				aria-label={`${confirming ? `Confirm ${verb.toLowerCase()}` : verb} ${connection.yours ? 'your' : `${memberName(connection)}'s`} ${title} connection`}
			>
				{revoking === connection.credentialId
					? `${verb === 'Revoke' ? 'Revoking' : 'Disconnecting'}…`
					: confirming
						? `Confirm ${verb.toLowerCase()}`
						: verb}
			</button>
		)
	}

	function row(connection: OrgAppMemberConnection) {
		return (
			<li
				key={connection.credentialId}
				css={{
					...insetCardCss,
					display: 'flex',
					flexWrap: 'wrap',
					alignItems: 'center',
					justifyContent: 'space-between',
					gap: spacing.sm,
					listStyle: 'none',
				}}
			>
				<div css={{ display: 'grid', gap: spacing.xs }}>
					<strong>
						{connection.yours ? 'You' : memberName(connection)}
						{connection.memberUsername && !connection.yours
							? ` (@${connection.memberUsername})`
							: null}
					</strong>
					<span css={descriptionCss}>
						{connection.accountLabel ? `${connection.accountLabel} · ` : null}
						Connected {formatTimestampDate(connection.connectedAt)}
					</span>
				</div>
				{revokeButton(connection)}
			</li>
		)
	}

	const others = data.connections.filter((connection) => !connection.yours)
	return (
		<section
			css={{ display: 'grid', gap: spacing.sm }}
			data-testid="org-app-member-connections"
		>
			<h3 css={sectionTitleCss}>Members' own accounts</h3>
			<p css={descriptionCss}>
				Members can connect their own {title} account through this app. Each
				connection belongs to the member and works only in this org, only in
				their own runs. Admins can see and revoke it, but never use it or read
				its tokens. Leaving the org removes it.
			</p>
			{data.own ? (
				<ul css={{ display: 'grid', gap: spacing.sm, margin: 0, padding: 0 }}>
					{row(data.own)}
				</ul>
			) : data.canConnectOwn ? (
				<SiteLink
					href={buildConnectOauthHref({
						name: appSlug,
						appSlug,
						orgSlug,
						mode: 'personal',
					})}
					css={{
						...getPillButtonCss({ size: 'sm' }),
						display: 'inline-flex',
						justifySelf: 'start',
						textDecoration: 'none',
					}}
				>
					Connect your own account
				</SiteLink>
			) : null}
			{data.canManage ? (
				others.length === 0 ? (
					<p css={descriptionCss}>
						No other member has connected their own account yet.
					</p>
				) : (
					<ul
						css={{ display: 'grid', gap: spacing.sm, margin: 0, padding: 0 }}
						aria-label="Members' own connections"
					>
						{others.map(row)}
					</ul>
				)
			) : null}
			{message ? (
				<p role="status" css={{ ...descriptionCss, color: colors.text }}>
					{message}
				</p>
			) : null}
		</section>
	)
}
