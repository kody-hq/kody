import { Fragment, type ReactNode } from 'react'

/** A row detail line: parts joined with ` · `, keeping JSX parts as elements. */
export function DetailParts({ parts }: { parts: Array<ReactNode> }) {
	return parts.map((part, index) => (
		<Fragment key={index}>
			{index > 0 ? ' · ' : null}
			{part}
		</Fragment>
	))
}
