/** @jsxImportSource @emotion/react */
import { useEffect, useState } from 'react'
import { SiteLink } from '../components/site-link.tsx'
import { getPillButtonCss } from '#universal/styles/style-primitives.ts'
import { colors } from '#universal/styles/tokens.ts'
import { noticeCardCss } from './account-management-components.tsx'

export type GuestBannerInfo = {
	phase: 'active' | 'hold'
	claimUrl: string
	fullAccessUntil: string
	deleteAt: string
}

function formatGuestTimeLeft(ms: number) {
	if (ms <= 0) return 'less than a minute'
	const totalMinutes = Math.max(1, Math.floor(ms / 60_000))
	const days = Math.floor(totalMinutes / (60 * 24))
	const hours = Math.floor((totalMinutes % (60 * 24)) / 60)
	const minutes = totalMinutes % 60
	if (days > 0) return `${days}d ${hours}h`
	if (hours > 0) return `${hours}h ${minutes}m`
	return `${minutes}m`
}

export function formatGuestDate(iso: string) {
	return new Intl.DateTimeFormat('en-US', {
		timeZone: 'America/Denver',
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
	}).format(new Date(iso))
}

function useNow(intervalMs = 30_000) {
	const [now, setNow] = useState(() => Date.now())
	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), intervalMs)
		return () => clearInterval(id)
	}, [intervalMs])
	return now
}

function claimPath(claimUrl: string) {
	try {
		return new URL(claimUrl).pathname
	} catch {
		return claimUrl
	}
}

/** Countdown and Claim button shown across the dashboard for guests. */
export function GuestBanner(props: { guest: GuestBannerInfo }) {
	const { guest } = props
	const now = useNow()
	const active =
		guest.phase === 'active' && Date.parse(guest.fullAccessUntil) > now
	const title = active
		? `Guest account: ${formatGuestTimeLeft(Date.parse(guest.fullAccessUntil) - now)} of full access left`
		: 'Guest account: read-only'
	const body = active
		? `Claim it before ${formatGuestDate(guest.fullAccessUntil)} MT to keep everything. Your connected agents keep working.`
		: `Full access ended. You can still look around, but saving changes and running code need a claimed account. Claim it before ${formatGuestDate(guest.deleteAt)} MT or it is deleted.`
	return (
		<section
			aria-label="Guest account"
			data-guest-banner={active ? 'active' : 'hold'}
			css={{
				...noticeCardCss,
				display: 'flex',
				alignItems: 'center',
				flexWrap: 'wrap',
				gap: '0.9rem 1.2rem',
				padding: '0.9rem 1.2rem',
				marginBottom: '1.25rem',
				...(active ? null : { borderColor: colors.warning }),
			}}
		>
			<div css={{ flex: 1, minWidth: '14rem' }}>
				<h2
					suppressHydrationWarning
					css={{
						margin: 0,
						fontSize: '1rem',
						fontWeight: 700,
						lineHeight: 1.35,
					}}
				>
					{title}
				</h2>
				<p
					suppressHydrationWarning
					css={{
						margin: '0.2rem 0 0',
						color: colors.textMuted,
						fontSize: '0.9rem',
						lineHeight: 1.5,
					}}
				>
					{body}
				</p>
			</div>
			<SiteLink href={claimPath(guest.claimUrl)} css={getPillButtonCss()}>
				Claim account
			</SiteLink>
		</section>
	)
}
