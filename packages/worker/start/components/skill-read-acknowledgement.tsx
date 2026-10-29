import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { recordSkillPageRead } from '#start/server/skills'

export function SkillReadAcknowledgement({
	orgSlug,
	receipt,
	identity,
}: {
	identity: string
	orgSlug: string
	receipt: string | null
}) {
	return receipt ? (
		<Acknowledge key={identity} orgSlug={orgSlug} receipt={receipt} />
	) : null
}
function Acknowledge({
	orgSlug,
	receipt,
}: {
	orgSlug: string
	receipt: string
}) {
	const [eventId] = useState(() => crypto.randomUUID())
	const [error, setError] = useState(false)
	const [retry, setRetry] = useState(0)
	const client = useQueryClient()
	useEffect(() => {
		let active = true
		void recordSkillPageRead({ data: { orgSlug, receipt, eventId } })
			.then(() => {
				if (active) setError(false)
				void client.invalidateQueries({
					predicate: (query) =>
						query.queryKey[2] === 'loadSkillsPage' ||
						query.queryKey[2] === 'loadOrgOverview',
					refetchType: 'none',
				})
			})
			.catch(() => {
				if (active) setError(true)
			})
		return () => {
			active = false
		}
	}, [receipt, orgSlug, eventId, retry, client])
	return error ? (
		<p role="status">
			This read couldn't be recorded.{' '}
			<button type="button" onClick={() => setRetry((n) => n + 1)}>
				Retry
			</button>
		</p>
	) : null
}
