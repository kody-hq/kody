import {
	kodyMarkViewBox,
	kodyMarkPathTransform,
	kodyMarkOutlinedOuterPathD,
	kodyMarkOutlinedLeftEyePathD,
	kodyMarkOutlinedRightEyePathD,
	kodyMarkOutlinedNosePathD,
} from '../brand/kody-mark-path.ts'

export function LoadingIndicator({
	label = 'Loading',
	inline = false,
}: {
	label?: string
	inline?: boolean
}) {
	return (
		<span
			role="status"
			aria-label={label}
			className={inline ? 'kody-loading kody-loading-inline' : 'kody-loading'}
		>
			{inline ? (
				<span className="kody-loading-ring" aria-hidden="true" />
			) : (
				<svg
					aria-hidden="true"
					viewBox={kodyMarkViewBox}
					className="kody-loading-mark"
				>
					<g
						transform={kodyMarkPathTransform}
						fill="none"
						stroke="currentColor"
						strokeWidth="18"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						{[
							kodyMarkOutlinedOuterPathD,
							kodyMarkOutlinedLeftEyePathD,
							kodyMarkOutlinedRightEyePathD,
							kodyMarkOutlinedNosePathD,
						].map((d, index) => (
							<path key={index} d={d} pathLength="1" />
						))}
					</g>
				</svg>
			)}
		</span>
	)
}
