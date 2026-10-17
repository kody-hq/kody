/** @jsxImportSource react */
/** @jsxRuntime automatic */
import { type ReactNode } from 'react'

/**
 * Inner paths from Iconic (https://iconic.app) SVG icons.
 * 24×24 bounding box, 1.5px stroke. Cropping lives in `icon.tsx`.
 */
import { type IconName } from '#universal/icon-names.ts'
export type { IconName } from '#universal/icon-names.ts'

export const iconGlyphs = {
	home: () => (
		<>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M6.75024 19.2502H17.2502C18.3548 19.2502 19.2502 18.3548 19.2502 17.2502V9.75025L12.0002 4.75024L4.75024 9.75025V17.2502C4.75024 18.3548 5.64568 19.2502 6.75024 19.2502Z"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M9.74963 15.7493C9.74963 14.6447 10.6451 13.7493 11.7496 13.7493H12.2496C13.3542 13.7493 14.2496 14.6447 14.2496 15.7493V19.2493H9.74963V15.7493Z"
			/>
		</>
	),
	clock: () => (
		<>
			<circle
				cx="12"
				cy="12"
				r="7.25"
				stroke="currentColor"
				strokeWidth="1.5"
			/>
			<path stroke="currentColor" strokeWidth="1.5" d="M12 8V12L14 14" />
		</>
	),
	link: () => (
		<>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M16.75 13.25L18 12C19.6569 10.3431 19.6569 7.65685 18 6V6C16.3431 4.34315 13.6569 4.34315 12 6L10.75 7.25"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M7.25 10.75L6 12C4.34315 13.6569 4.34315 16.3431 6 18V18C7.65685 19.6569 10.3431 19.6569 12 18L13.25 16.75"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M14.25 9.75L9.75 14.25"
			/>
		</>
	),
	box: () => (
		<>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M4.75 8L12 4.75L19.25 8L12 11.25L4.75 8Z"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M4.75 16L12 19.25L19.25 16"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M19.25 8V16"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M4.75 8V16"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M12 11.5V19"
			/>
		</>
	),
	share: () => (
		<>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M9.25 4.75H6.75C5.64543 4.75 4.75 5.64543 4.75 6.75V17.25C4.75 18.3546 5.64543 19.25 6.75 19.25H17.25C18.3546 19.25 19.25 18.3546 19.25 17.25V14.75"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M19.25 9.25V4.75H14.75"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M19 5L11.75 12.25"
			/>
		</>
	),
	wallet: () => (
		<>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M19.25 8.25V17.25C19.25 18.3546 18.3546 19.25 17.25 19.25H6.75C5.64543 19.25 4.75 18.3546 4.75 17.25V6.75"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				d="M16.5 13C16.5 13.2761 16.2761 13.5 16 13.5C15.7239 13.5 15.5 13.2761 15.5 13C15.5 12.7239 15.7239 12.5 16 12.5C16.2761 12.5 16.5 12.7239 16.5 13Z"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M17.25 8.25H6.5C5.5335 8.25 4.75 7.4665 4.75 6.5C4.75 5.5335 5.5335 4.75 6.5 4.75H15.25C16.3546 4.75 17.25 5.64543 17.25 6.75V8.25ZM17.25 8.25H19.25"
			/>
		</>
	),
	chart: () => (
		<>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M4.75 6.75C4.75 5.64543 5.64543 4.75 6.75 4.75H17.25C18.3546 4.75 19.25 5.64543 19.25 6.75V17.25C19.25 18.3546 18.3546 19.25 17.25 19.25H6.75C5.64543 19.25 4.75 18.3546 4.75 17.25V6.75Z"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M8.75 15.25V9.75"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M15.25 15.25V9.75"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M12 15.25V12.75"
			/>
		</>
	),
	'trending-up': () => (
		<>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M4.75 11.25L10.25 5.75"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M5.75 19.2502H6.25C6.80229 19.2502 7.25 18.8025 7.25 18.2502V15.75C7.25 15.1977 6.80229 14.75 6.25 14.75H5.75C5.19772 14.75 4.75 15.1977 4.75 15.75V18.2502C4.75 18.8025 5.19772 19.2502 5.75 19.2502Z"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M11.75 19.2502H12.25C12.8023 19.2502 13.25 18.8025 13.25 18.2502V12.75C13.25 12.1977 12.8023 11.75 12.25 11.75H11.75C11.1977 11.75 10.75 12.1977 10.75 12.75V18.2502C10.75 18.8025 11.1977 19.2502 11.75 19.2502Z"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M17.75 19.2502H18.25C18.8023 19.2502 19.25 18.8025 19.25 18.2502V5.75C19.25 5.19772 18.8023 4.75 18.25 4.75H17.75C17.1977 4.75 16.75 5.19772 16.75 5.75V18.2502C16.75 18.8025 17.1977 19.2502 17.75 19.2502Z"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M11.25 8.25V4.75H7.75"
			/>
		</>
	),
	briefcase: () => (
		<>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M4.75 9.75C4.75 8.64543 5.64543 7.75 6.75 7.75H17.25C18.3546 7.75 19.25 8.64543 19.25 9.75V17.25C19.25 18.3546 18.3546 19.25 17.25 19.25H6.75C5.64543 19.25 4.75 18.3546 4.75 17.25V9.75Z"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M8.75 7.5V6.75C8.75 5.64543 9.64543 4.75 10.75 4.75H13.25C14.3546 4.75 15.25 5.64543 15.25 6.75V7.5"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M5 13.25H19"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M8.75 11.75V14.25"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M15.25 11.75V14.25"
			/>
		</>
	),
	refresh: () => (
		<>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M11.25 4.75L8.75 7L11.25 9.25"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M12.75 19.25L15.25 17L12.75 14.75"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M9.75 7H13.25C16.5637 7 19.25 9.68629 19.25 13V13.25"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M14.25 17H10.75C7.43629 17 4.75 14.3137 4.75 11V10.75"
			/>
		</>
	),
	cloud: () => (
		<>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M4.75 14C4.75 15.7949 6.20507 17.25 8 17.25H16C17.7949 17.25 19.25 15.7949 19.25 14C19.25 12.2869 17.9246 10.8834 16.2433 10.759C16.1183 8.5239 14.2663 6.75 12 6.75C9.73368 6.75 7.88168 8.5239 7.75672 10.759C6.07542 10.8834 4.75 12.2869 4.75 14Z"
			/>
		</>
	),
	key: () => (
		<>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M15 13.25C17.3472 13.25 19.25 11.3472 19.25 9C19.25 6.65279 17.3472 4.75 15 4.75C12.6528 4.75 10.75 6.65279 10.75 9C10.75 9.31012 10.7832 9.61248 10.8463 9.90372L4.75 16V19.25H8L8.75 18.5V16.75H10.5L11.75 15.5V13.75H13.5L14.0963 13.1537C14.3875 13.2168 14.6899 13.25 15 13.25Z"
			/>
			<path
				stroke="currentColor"
				d="M16.5 8C16.5 8.27614 16.2761 8.5 16 8.5C15.7239 8.5 15.5 8.27614 15.5 8C15.5 7.72386 15.7239 7.5 16 7.5C16.2761 7.5 16.5 7.72386 16.5 8Z"
			/>
		</>
	),
	plug: () => (
		<>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M18.2813 12.0313L11.9687 5.7187C11.4896 5.23964 10.6829 5.36557 10.3726 5.96785L6.75 13L11 17.25L18.0321 13.6274C18.6344 13.3171 18.7604 12.5104 18.2813 12.0313Z"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M4.75 19.25L8.5 15.5"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M13.75 7.25L16.25 4.75"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M16.75 10.25L19.25 7.75"
			/>
		</>
	),
	server: () => (
		<>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M4.75 5.75C4.75 5.19772 5.19772 4.75 5.75 4.75H18.25C18.8023 4.75 19.25 5.19772 19.25 5.75V9.25C19.25 9.80228 18.8023 10.25 18.25 10.25H5.75C5.19771 10.25 4.75 9.80228 4.75 9.25V5.75Z"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M4.75 14.75C4.75 14.1977 5.19772 13.75 5.75 13.75H18.25C18.8023 13.75 19.25 14.1977 19.25 14.75V18.25C19.25 18.8023 18.8023 19.25 18.25 19.25H5.75C5.19771 19.25 4.75 18.8023 4.75 18.25V14.75Z"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M16.25 5V10"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M16.25 14V19"
			/>
		</>
	),
	book: () => (
		<>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M19.25 5.75C19.25 5.19772 18.8023 4.75 18.25 4.75H14C12.8954 4.75 12 5.64543 12 6.75V19.25L12.8284 18.4216C13.5786 17.6714 14.596 17.25 15.6569 17.25H18.25C18.8023 17.25 19.25 16.8023 19.25 16.25V5.75Z"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M4.75 5.75C4.75 5.19772 5.19772 4.75 5.75 4.75H10C11.1046 4.75 12 5.64543 12 6.75V19.25L11.1716 18.4216C10.4214 17.6714 9.40401 17.25 8.34315 17.25H5.75C5.19772 17.25 4.75 16.8023 4.75 16.25V5.75Z"
			/>
		</>
	),
	mail: () => (
		<>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M4.75 7.75C4.75 6.64543 5.64543 5.75 6.75 5.75H17.25C18.3546 5.75 19.25 6.64543 19.25 7.75V16.25C19.25 17.3546 18.3546 18.25 17.25 18.25H6.75C5.64543 18.25 4.75 17.3546 4.75 16.25V7.75Z"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M5.5 6.5L12 12.25L18.5 6.5"
			/>
		</>
	),
	users: () => (
		<>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M5.78168 19.25H13.2183C13.7828 19.25 14.227 18.7817 14.1145 18.2285C13.804 16.7012 12.7897 14 9.5 14C6.21031 14 5.19605 16.7012 4.88549 18.2285C4.773 18.7817 5.21718 19.25 5.78168 19.25Z"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M15.75 14C17.8288 14 18.6802 16.1479 19.0239 17.696C19.2095 18.532 18.5333 19.25 17.6769 19.25H16.75"
			/>
			<circle
				cx="9.5"
				cy="7.5"
				r="2.75"
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M14.75 10.25C16.2688 10.25 17.25 9.01878 17.25 7.5C17.25 5.98122 16.2688 4.75 14.75 4.75"
			/>
		</>
	),
	'pie-chart': () => (
		<>
			<circle
				cx="12"
				cy="12"
				r="7.25"
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M11.75 5V10.25C11.75 11.3546 12.6454 12.25 13.75 12.25H19"
			/>
		</>
	),
	'user-cross': () => (
		<>
			<circle
				cx="12"
				cy="8"
				r="3.25"
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M12.25 19.25H6.94953C5.77004 19.25 4.88989 18.2103 5.49085 17.1954C6.36247 15.7234 8.23935 14 12.25 14"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M19.25 19.25L15.75 15.75"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M15.75 19.25L19.25 15.75"
			/>
		</>
	),
	flag: () => (
		<>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M5.75 19.25L5.75 13.25M5.75 13.25L5.75 5.75C5.75 5.75 8.5 3.5 12 5.75C15.5 8 18.25 5.75 18.25 5.75L18.25 13.25C18.25 13.25 15.5 15.5 12 13.25C8.5 11 5.75 13.25 5.75 13.25Z"
			/>
		</>
	),
	announcement: () => (
		<>
			<path
				stroke="currentColor"
				strokeWidth="1.5"
				d="M19.25 10C19.25 12.7289 17.85 15.25 16.5 15.25C15.15 15.25 13.75 12.7289 13.75 10C13.75 7.27106 15.15 4.75 16.5 4.75C17.85 4.75 19.25 7.27106 19.25 10Z"
			/>
			<path
				stroke="currentColor"
				strokeWidth="1.5"
				d="M16.5 15.25C16.5 15.25 8 13.5 7 13.25C6 13 4.75 11.6893 4.75 10C4.75 8.31066 6 7 7 6.75C8 6.5 16.5 4.75 16.5 4.75"
			/>
			<path
				stroke="currentColor"
				strokeWidth="1.5"
				d="M6.75 13.5V17.25C6.75 18.3546 7.64543 19.25 8.75 19.25H9.25C10.3546 19.25 11.25 18.3546 11.25 17.25V14.5"
			/>
		</>
	),
	globe: () => (
		<>
			<circle
				cx="12"
				cy="12"
				r="7.25"
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M15.25 12C15.25 16.5 13.2426 19.25 12 19.25C10.7574 19.25 8.75 16.5 8.75 12C8.75 7.5 10.7574 4.75 12 4.75C13.2426 4.75 15.25 7.5 15.25 12Z"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M5 12H12H19"
			/>
		</>
	),
	photo: () => (
		<>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M4.75 16L7.49619 12.5067C8.2749 11.5161 9.76453 11.4837 10.5856 12.4395L13 15.25M10.915 12.823C11.9522 11.5037 13.3973 9.63455 13.4914 9.51294C13.4947 9.50859 13.4979 9.50448 13.5013 9.50017C14.2815 8.51598 15.7663 8.48581 16.5856 9.43947L19 12.25M6.75 19.25H17.25C18.3546 19.25 19.25 18.3546 19.25 17.25V6.75C19.25 5.64543 18.3546 4.75 17.25 4.75H6.75C5.64543 4.75 4.75 5.64543 4.75 6.75V17.25C4.75 18.3546 5.64543 19.25 6.75 19.25Z"
			/>
		</>
	),
	code: () => (
		<>
			<rect
				width="14.5"
				height="14.5"
				x="4.75"
				y="4.75"
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				rx="2"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M8.75 10.75L11.25 13L8.75 15.25"
			/>
		</>
	),
	shield: () => (
		<>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M12 4.75L4.75001 8C4.75001 8 4.00001 19.25 12 19.25C20 19.25 19.25 8 19.25 8L12 4.75Z"
			/>
		</>
	),
	'warning-triangle': () => (
		<>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M4.9522 16.3536L10.2152 5.85658C10.9531 4.38481 13.0539 4.3852 13.7913 5.85723L19.0495 16.3543C19.7156 17.6841 18.7487 19.25 17.2613 19.25H6.74007C5.25234 19.25 4.2854 17.6835 4.9522 16.3536Z"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="2"
				d="M12 10V12"
			/>
			<circle cx="12" cy="16" r="1" fill="currentColor" />
		</>
	),
	message: () => (
		<>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M12 18.25C15.5 18.25 19.25 16.5 19.25 12C19.25 7.5 15.5 5.75 12 5.75C8.5 5.75 4.75 7.5 4.75 12C4.75 13.0298 4.94639 13.9156 5.29123 14.6693C5.50618 15.1392 5.62675 15.6573 5.53154 16.1651L5.26934 17.5635C5.13974 18.2547 5.74527 18.8603 6.43651 18.7307L9.64388 18.1293C9.896 18.082 10.1545 18.0861 10.4078 18.1263C10.935 18.2099 11.4704 18.25 12 18.25Z"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				d="M9.5 12C9.5 12.2761 9.27614 12.5 9 12.5C8.72386 12.5 8.5 12.2761 8.5 12C8.5 11.7239 8.72386 11.5 9 11.5C9.27614 11.5 9.5 11.7239 9.5 12Z"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				d="M12.5 12C12.5 12.2761 12.2761 12.5 12 12.5C11.7239 12.5 11.5 12.2761 11.5 12C11.5 11.7239 11.7239 11.5 12 11.5C12.2761 11.5 12.5 11.7239 12.5 12Z"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				d="M15.5 12C15.5 12.2761 15.2761 12.5 15 12.5C14.7239 12.5 14.5 12.2761 14.5 12C14.5 11.7239 14.7239 11.5 15 11.5C15.2761 11.5 15.5 11.7239 15.5 12Z"
			/>
		</>
	),
	inbox: () => (
		<>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M19.25 11.75L17.6644 6.20056C17.4191 5.34195 16.6344 4.75 15.7414 4.75H8.2586C7.36564 4.75 6.58087 5.34196 6.33555 6.20056L4.75 11.75"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M10.2142 12.3689C9.95611 12.0327 9.59467 11.75 9.17085 11.75H4.75V17.25C4.75 18.3546 5.64543 19.25 6.75 19.25H17.25C18.3546 19.25 19.25 18.3546 19.25 17.25V11.75H14.8291C14.4053 11.75 14.0439 12.0327 13.7858 12.3689C13.3745 12.9046 12.7276 13.25 12 13.25C11.2724 13.25 10.6255 12.9046 10.2142 12.3689Z"
			/>
		</>
	),
	'arrow-left': () => (
		<>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M10.25 6.75L4.75 12L10.25 17.25"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M19.25 12H5"
			/>
		</>
	),
	'chevron-right': () => (
		<>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M10.75 8.75L14.25 12L10.75 15.25"
			/>
		</>
	),
	'chevron-down': () => (
		<>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M15.25 10.75L12 14.25L8.75 10.75"
			/>
		</>
	),
	'chevron-left': () => (
		<>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M13.25 8.75L9.75 12L13.25 15.25"
			/>
		</>
	),
	'chevron-up': () => (
		<>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M15.25 14.25L12 10.75L8.75 14.25"
			/>
		</>
	),
	folder: () => (
		<>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M19.25 17.25V9.75C19.25 8.64543 18.3546 7.75 17.25 7.75H4.75V17.25C4.75 18.3546 5.64543 19.25 6.75 19.25H17.25C18.3546 19.25 19.25 18.3546 19.25 17.25Z"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M13.5 7.5L12.5685 5.7923C12.2181 5.14977 11.5446 4.75 10.8127 4.75H6.75C5.64543 4.75 4.75 5.64543 4.75 6.75V11"
			/>
		</>
	),
	file: () => (
		<>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M7.75 19.25H16.25C17.3546 19.25 18.25 18.3546 18.25 17.25V9L14 4.75H7.75C6.64543 4.75 5.75 5.64543 5.75 6.75V17.25C5.75 18.3546 6.64543 19.25 7.75 19.25Z"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M18 9.25H13.75V5"
			/>
		</>
	),
	search: () => (
		<>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M19.25 19.25L15.5 15.5M4.75 11C4.75 7.54822 7.54822 4.75 11 4.75C14.4518 4.75 17.25 7.54822 17.25 11C17.25 14.4518 14.4518 17.25 11 17.25C7.54822 17.25 4.75 14.4518 4.75 11Z"
			/>
		</>
	),
	edit: () => (
		<>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M4.75 19.25L9 18.25L18.2929 8.95711C18.6834 8.56658 18.6834 7.93342 18.2929 7.54289L16.4571 5.70711C16.0666 5.31658 15.4334 5.31658 15.0429 5.70711L5.75 15L4.75 19.25Z"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M19.25 19.25H13.75"
			/>
		</>
	),
	check: () => (
		<>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M5.75 12.8665L8.33995 16.4138C9.15171 17.5256 10.8179 17.504 11.6006 16.3715L18.25 6.75"
			/>
		</>
	),
	close: () => (
		<>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M17.25 6.75L6.75 17.25"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M6.75 6.75L17.25 17.25"
			/>
		</>
	),
	plus: () => (
		<>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M12 5.75V18.25"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M18.25 12L5.75 12"
			/>
		</>
	),
	play: () => (
		<>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M18.25 12L5.75 5.75V18.25L18.25 12Z"
			/>
		</>
	),
	pause: () => (
		<>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M15.25 6.75V17.25"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M8.75 6.75V17.25"
			/>
		</>
	),
	information: () => (
		<>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="2"
				d="M12 13V15"
			/>
			<circle cx="12" cy="9" r="1" fill="currentColor" />
			<circle
				cx="12"
				cy="12"
				r="7.25"
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
			/>
		</>
	),
	user: () => (
		<>
			<circle
				cx="12"
				cy="8"
				r="3.25"
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M6.8475 19.25H17.1525C18.2944 19.25 19.174 18.2681 18.6408 17.2584C17.8563 15.7731 16.068 14 12 14C7.93201 14 6.14367 15.7731 5.35924 17.2584C4.82597 18.2681 5.70558 19.25 6.8475 19.25Z"
			/>
		</>
	),
	lock: () => (
		<>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M5.75 11.75C5.75 11.1977 6.19772 10.75 6.75 10.75H17.25C17.8023 10.75 18.25 11.1977 18.25 11.75V17.25C18.25 18.3546 17.3546 19.25 16.25 19.25H7.75C6.64543 19.25 5.75 18.3546 5.75 17.25V11.75Z"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M7.75 10.5V10.3427C7.75 8.78147 7.65607 7.04125 8.74646 5.9239C9.36829 5.2867 10.3745 4.75 12 4.75C13.6255 4.75 14.6317 5.2867 15.2535 5.9239C16.3439 7.04125 16.25 8.78147 16.25 10.3427V10.5"
			/>
		</>
	),
	'lock-unlocked': () => (
		<>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M5.75 11.75C5.75 11.1977 6.19772 10.75 6.75 10.75H17.25C17.8023 10.75 18.25 11.1977 18.25 11.75V17.25C18.25 18.3546 17.3546 19.25 16.25 19.25H7.75C6.64543 19.25 5.75 18.3546 5.75 17.25V11.75Z"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M7.75 10.5V9.84343C7.75 8.61493 7.70093 7.29883 8.42416 6.30578C8.99862 5.51699 10.0568 4.75 12 4.75C14 4.75 15.25 6.25 15.25 6.25"
			/>
		</>
	),
	menu: () => (
		<>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M4.75 5.75H19.25"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M4.75 18.25H19.25"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M4.75 12H19.25"
			/>
		</>
	),
	copy: () => (
		<>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M6.5 15.25V15.25C5.5335 15.25 4.75 14.4665 4.75 13.5V6.75C4.75 5.64543 5.64543 4.75 6.75 4.75H13.5C14.4665 4.75 15.25 5.5335 15.25 6.5V6.5"
			/>
			<rect
				width="10.5"
				height="10.5"
				x="8.75"
				y="8.75"
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				rx="2"
			/>
		</>
	),
	'dots-horizontal': () => (
		<>
			<path
				fill="currentColor"
				d="M13 12C13 12.5523 12.5523 13 12 13C11.4477 13 11 12.5523 11 12C11 11.4477 11.4477 11 12 11C12.5523 11 13 11.4477 13 12Z"
			/>
			<path
				fill="currentColor"
				d="M9 12C9 12.5523 8.55228 13 8 13C7.44772 13 7 12.5523 7 12C7 11.4477 7.44772 11 8 11C8.55228 11 9 11.4477 9 12Z"
			/>
			<path
				fill="currentColor"
				d="M17 12C17 12.5523 16.5523 13 16 13C15.4477 13 15 12.5523 15 12C15 11.4477 15.4477 11 16 11C16.5523 11 17 11.4477 17 12Z"
			/>
		</>
	),
	target: () => (
		<>
			<circle
				cx="12"
				cy="12"
				r="7.25"
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
			/>
			<circle
				cx="12"
				cy="12"
				r="4.25"
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
			/>
			<circle
				cx="12"
				cy="12"
				r="1.25"
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
			/>
		</>
	),
	redo: () => (
		<>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M14.75 4.75L19.25 9L14.75 13.25"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M19.25 9H8.75C6.54086 9 4.75 10.7909 4.75 13V19.25"
			/>
		</>
	),
	star: () => (
		<>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M12 4.75L13.75 10.25H19.25L14.75 13.75L16.25 19.25L12 15.75L7.75 19.25L9.25 13.75L4.75 10.25H10.25L12 4.75Z"
			/>
		</>
	),
	heart: () => (
		<>
			<path
				fillRule="evenodd"
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M11.995 7.23319C10.5455 5.60999 8.12832 5.17335 6.31215 6.65972C4.49599 8.14609 4.2403 10.6312 5.66654 12.3892L11.995 18.25L18.3235 12.3892C19.7498 10.6312 19.5253 8.13046 17.6779 6.65972C15.8305 5.18899 13.4446 5.60999 11.995 7.23319Z"
				clipRule="evenodd"
			/>
		</>
	),
	eye: () => (
		<>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M19.25 12C19.25 13 17.5 18.25 12 18.25C6.5 18.25 4.75 13 4.75 12C4.75 11 6.5 5.75 12 5.75C17.5 5.75 19.25 11 19.25 12Z"
			/>
			<circle
				cx="12"
				cy="12"
				r="2.25"
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
			/>
		</>
	),
	'git-fork': () => (
		<>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M9.25 7C9.25 8.24264 8.24264 9.25 7 9.25C5.75736 9.25 4.75 8.24264 4.75 7C4.75 5.75736 5.75736 4.75 7 4.75C8.24264 4.75 9.25 5.75736 9.25 7Z"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M19.25 7C19.25 8.24264 18.2426 9.25 17 9.25C15.7574 9.25 14.75 8.24264 14.75 7C14.75 5.75736 15.7574 4.75 17 4.75C18.2426 4.75 19.25 5.75736 19.25 7Z"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M14.25 17C14.25 18.2426 13.2426 19.25 12 19.25C10.7574 19.25 9.75 18.2426 9.75 17C9.75 15.7574 10.7574 14.75 12 14.75C13.2426 14.75 14.25 15.7574 14.25 17Z"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M6.75 9.5V10.25C6.75 11.3546 7.64543 12.25 8.75 12.25H12M17.25 9.5V10.25C17.25 11.3546 16.3546 12.25 15.25 12.25H12M12 12.25V14.5"
			/>
		</>
	),
	'link-break': () => (
		<>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M17.75 12.25L18 12C19.6569 10.3431 19.6569 7.65685 18 6C16.3431 4.34314 13.6569 4.34314 12 6L11.75 6.25"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M6.24996 11.75L5.99996 12C4.34311 13.6569 4.34311 16.3431 5.99996 18C7.65682 19.6569 10.3431 19.6569 12 18L12.25 17.75"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M8.25 4.75V6.25"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M15.75 17.75V19.25"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M6.25 8.25H4.75"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M19.25 15.75H17.75"
			/>
		</>
	),
	clipboard: () => (
		<>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M9 6.75H7.75C6.64543 6.75 5.75 7.64543 5.75 8.75V17.25C5.75 18.3546 6.64543 19.25 7.75 19.25H16.25C17.3546 19.25 18.25 18.3546 18.25 17.25V8.75C18.25 7.64543 17.3546 6.75 16.25 6.75H15"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M14 8.25H10C9.44772 8.25 9 7.80228 9 7.25V5.75C9 5.19772 9.44772 4.75 10 4.75H14C14.5523 4.75 15 5.19772 15 5.75V7.25C15 7.80228 14.5523 8.25 14 8.25Z"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M9.75 12.25H14.25"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M9.75 15.25H14.25"
			/>
		</>
	),
	'arrow-up-right': () => (
		<>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M17.25 15.25V6.75H8.75"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M17 7L6.75 17.25"
			/>
		</>
	),
	'two-checkmarks': () => (
		<>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="m5.75 12.464 2.833 2.786c1.417-4.179 4.667-6.5 4.667-6.5m5 0s-4.25 2.321-5.667 6.5l-1.102-1.083"
			/>
		</>
	),
} as const satisfies Record<IconName, () => ReactNode>
