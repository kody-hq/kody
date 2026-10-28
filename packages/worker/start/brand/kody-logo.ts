import {
	kodyMarkOutlinedLeftEyePathD,
	kodyMarkOutlinedNosePathD,
	kodyMarkOutlinedRightEyePathD,
	kodyMarkOutlinedRingPathD,
	kodyMarkPathD,
	kodyMarkPathTransform,
	kodyMarkViewBox,
} from './kody-mark-path.ts'

/**
 * Full Kody logo: the koala mark plus the "Kody" wordmark, laid out exactly
 * like the site header `brandCss` (34px mark, 0.7rem gap, Bricolage Grotesque
 * 700 at 28px/1 with -0.01em tracking, vertically centered).
 *
 * Coordinates are in those header CSS pixels. The wordmark is outlined from
 * `public/fonts/bricolage-grotesque-latin.woff2` instanced at wght 700 and
 * opsz 28 (what the browser picks at 28px), so the files never depend on the
 * font being installed.
 */
const kodyLogoHeight = 34
const kodyLogoWidth = 123.76
export const kodyLogoViewBox = `0 0 ${kodyLogoWidth} ${kodyLogoHeight}`

/** Natural width÷height of the logo viewBox. */
export const kodyLogoAspectRatio = kodyLogoWidth / kodyLogoHeight

/** "Kody" outlined in Bricolage Grotesque, in logo viewBox units. */
export const kodyWordmarkPathD =
	'M59.104 26.24L59.104 7.76L63.136 7.76L63.136 15.992Q64.564 15.432 65.796 14.536Q67.028 13.64 67.98 12.534Q68.932 11.428 69.604 10.196Q70.276 8.964 70.584 7.76L75.176 7.76Q74.812 9.188 74.028 10.546Q73.244 11.904 72.18 13.108Q71.116 14.312 69.884 15.25Q68.652 16.188 67.336 16.72L67.336 17.084Q68.708 17.084 69.758 17.392Q70.808 17.7 71.592 18.33Q72.376 18.96 72.95 19.884Q73.524 20.808 73.972 22.012L75.456 26.24L70.892 26.24L69.94 22.796Q69.548 21.452 68.932 20.654Q68.316 19.856 67.322 19.478Q66.328 19.1 64.76 19.1L63.136 19.1L63.136 26.24ZM83.548 26.632Q81.336 26.632 79.656 25.75Q77.976 24.868 77.024 23.146Q76.072 21.424 76.072 18.848Q76.072 16.272 77.038 14.55Q78.004 12.828 79.698 11.988Q81.392 11.148 83.52 11.148Q85.732 11.148 87.412 12.016Q89.092 12.884 90.044 14.606Q90.996 16.328 90.996 18.904Q90.996 21.536 90.016 23.258Q89.036 24.98 87.342 25.806Q85.648 26.632 83.548 26.632ZM83.66 23.636Q84.724 23.636 85.452 23.118Q86.18 22.6 86.558 21.592Q86.936 20.584 86.936 19.128Q86.936 17.588 86.544 16.51Q86.152 15.432 85.368 14.858Q84.584 14.284 83.436 14.284Q82.4 14.284 81.644 14.788Q80.888 15.292 80.51 16.3Q80.132 17.308 80.132 18.792Q80.132 21.144 81.07 22.39Q82.008 23.636 83.66 23.636ZM98.752 26.632Q96.932 26.632 95.574 25.694Q94.216 24.756 93.46 23.02Q92.704 21.284 92.704 18.848Q92.704 16.552 93.376 14.83Q94.048 13.108 95.35 12.142Q96.652 11.176 98.556 11.176Q99.984 11.176 100.964 11.722Q101.944 12.268 102.574 13.318Q103.204 14.368 103.54 15.88L104.128 15.88Q103.96 14.956 103.806 14.074Q103.652 13.192 103.554 12.408Q103.456 11.624 103.456 11.008L103.456 6.332L107.516 6.332L107.516 19.324L107.516 26.24L104.128 26.24L104.128 21.928L103.624 21.928Q103.316 23.496 102.672 24.546Q102.028 25.596 101.048 26.114Q100.068 26.632 98.752 26.632ZM100.096 23.356Q100.964 23.356 101.594 22.964Q102.224 22.572 102.644 21.942Q103.064 21.312 103.274 20.57Q103.484 19.828 103.484 19.128L103.484 18.68Q103.484 18.092 103.33 17.504Q103.176 16.916 102.896 16.37Q102.616 15.824 102.196 15.39Q101.776 14.956 101.23 14.704Q100.684 14.452 100.04 14.452Q99.06 14.452 98.36 15.026Q97.66 15.6 97.282 16.594Q96.904 17.588 96.904 18.904Q96.904 20.22 97.296 21.228Q97.688 22.236 98.402 22.796Q99.116 23.356 100.096 23.356ZM116.112 31.196Q115.02 31.196 113.886 31Q112.752 30.804 111.744 30.384Q110.736 29.964 110.008 29.32L111.128 25.764Q112.024 26.716 113.354 27.164Q114.684 27.612 115.944 27.612Q117.428 27.612 118.422 27.01Q119.416 26.408 119.92 25.176Q120.424 23.944 120.48 22.124L120.648 19.548L120.088 19.548Q119.836 21.424 119.206 22.614Q118.576 23.804 117.61 24.364Q116.644 24.924 115.328 24.924Q113.732 24.924 112.64 24.112Q111.548 23.3 111.016 21.676Q110.484 20.052 110.484 17.672L110.484 11.54L114.516 11.54L114.516 16.692Q114.516 19.268 115.09 20.416Q115.664 21.564 116.896 21.564Q117.54 21.564 118.058 21.214Q118.576 20.864 118.94 20.192Q119.304 19.52 119.514 18.554Q119.724 17.588 119.724 16.328L119.724 11.54L123.756 11.54L123.756 22.292Q123.756 23.972 123.462 25.386Q123.168 26.8 122.566 27.878Q121.964 28.956 121.054 29.698Q120.144 30.44 118.912 30.818Q117.68 31.196 116.112 31.196Z'

const [markX, markY, markWidth, markHeight] = kodyMarkViewBox
	.split(' ')
	.map(Number) as [number, number, number, number]
// The header renders the mark at `round(34 × aspect)` wide, so `meet`
// scaling leaves a hair of vertical inset. Reproduce it so the wordmark
// sits where it does on the site.
const headerMarkWidth = Math.round(kodyLogoHeight * (markWidth / markHeight))
const markScale = Math.min(
	headerMarkWidth / markWidth,
	kodyLogoHeight / markHeight,
)
const markOffsetY = (kodyLogoHeight - markHeight * markScale) / 2
const kodyLogoMarkTransform = `translate(0 ${round(markOffsetY, 4)}) scale(${round(markScale, 8)}) translate(${-markX} ${-markY})`

function round(value: number, digits: number) {
	const factor = 10 ** digits
	return Math.round(value * factor) / factor
}

/**
 * Dark-mode logo: solid mark + wordmark in white. There is no solid black
 * logo; light surfaces use {@link kodyLogoOutlinedSvgMarkup}.
 */
export function kodyLogoSvgMarkup(fill = '#ffffff'): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${kodyLogoViewBox}" role="img" aria-label="Kody">
  <g transform="${kodyLogoMarkTransform}">
    <path fill="${fill}" fill-rule="evenodd" transform="${kodyMarkPathTransform}" d="${kodyMarkPathD}"/>
  </g>
  <path fill="${fill}" d="${kodyWordmarkPathD}"/>
</svg>
`
}

/** Light-mode logo: outlined filled-path mark + wordmark. */
export function kodyLogoOutlinedSvgMarkup(fill = '#000000'): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${kodyLogoViewBox}" role="img" aria-label="Kody">
  <g transform="${kodyLogoMarkTransform}">
    <path fill="${fill}" fill-rule="evenodd" transform="${kodyMarkPathTransform}" d="${kodyMarkOutlinedRingPathD}"/>
    <path fill="${fill}" transform="${kodyMarkPathTransform}" d="${kodyMarkOutlinedLeftEyePathD}"/>
    <path fill="${fill}" transform="${kodyMarkPathTransform}" d="${kodyMarkOutlinedRightEyePathD}"/>
    <path fill="${fill}" transform="${kodyMarkPathTransform}" d="${kodyMarkOutlinedNosePathD}"/>
  </g>
  <path fill="${fill}" d="${kodyWordmarkPathD}"/>
</svg>
`
}
