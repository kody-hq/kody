/** @jsxImportSource @emotion/react */
import { useSyncExternalStore } from 'react'

const subscribe = () => () => {}
const clientSnapshot = () => true
const serverSnapshot = () => false

/** Keep SSR and hydration identical, then display the viewer's local time. */
function LocalTimestamp({
	value,
	dateOnly = false,
}: {
	value: string
	dateOnly?: boolean
}) {
	const hydrated = useSyncExternalStore(
		subscribe,
		clientSnapshot,
		serverSnapshot,
	)
	const date = new Date(
		value.includes('T') ? value : `${value.replace(' ', 'T')}Z`,
	)
	if (Number.isNaN(date.getTime())) return <>{value}</>
	const iso = date.toISOString()
	const text = hydrated
		? dateOnly
			? date.toLocaleDateString()
			: date.toLocaleString()
		: dateOnly
			? iso.slice(0, 10)
			: iso.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')
	return <time dateTime={iso}>{text}</time>
}
export function formatTimestamp(value: string) {
	return <LocalTimestamp value={value} />
}
export function formatTimestampDate(value: string) {
	return <LocalTimestamp value={value} dateOnly />
}
export function formatNullableTimestamp(
	value: string | null,
	fallback = 'Never',
) {
	return value ? <LocalTimestamp value={value} /> : fallback
}
