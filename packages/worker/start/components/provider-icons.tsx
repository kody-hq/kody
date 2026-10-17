/** @jsxImportSource @emotion/react */
import { publicAsset } from '../public-assets.ts'
import { type JSX } from 'react'
import { getLogoWellCss } from '#universal/styles/style-primitives.ts'

/**
 * Inline official brand marks for social login providers, integration
 * suggestions, and onboarding Step 2 MCP chooser cards. Inlined as SVG (no
 * external assets) so they server-render with the buttons. Paths are the
 * vendor mark (Simple Icons / official brand kit) — do not invent lookalikes.
 */
const defaultIconSize = '1.25em'

function renderGitHubIcon(size: string) {
	return (
		<svg
			viewBox="0 0 16 16"
			width={size}
			height={size}
			aria-hidden="true"
			fill="currentColor"
		>
			<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
		</svg>
	)
}

function renderGoogleIcon(size: string) {
	return (
		<svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
			<path
				fill="#4285F4"
				d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z"
			/>
			<path
				fill="#34A853"
				d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24z"
			/>
			<path
				fill="#FBBC05"
				d="M5.27 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.98-3.09z"
			/>
			<path
				fill="#EA4335"
				d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09c.95-2.85 3.6-4.96 6.73-4.96z"
			/>
		</svg>
	)
}

function renderXIcon(size: string) {
	// Official 24×24 X mark sits in ~2.25 units of canvas padding, so it
	// reads smaller than edge-to-edge marks (Notion, Linear). Crop to the
	// glyph so the 1.75rem chip well fills like those.
	return (
		<svg
			viewBox="1.25 2.25 20.3 19.5"
			width={size}
			height={size}
			aria-hidden="true"
			fill="currentColor"
		>
			<path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
		</svg>
	)
}

function renderSlackIcon(size: string) {
	return (
		<svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
			<path
				fill="#E01E5A"
				d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522z"
			/>
			<path
				fill="#36C5F0"
				d="M8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521z"
			/>
			<path
				fill="#2EB67D"
				d="M18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522zm-1.27 0a2.528 2.528 0 0 1-2.522 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.164 0a2.528 2.528 0 0 1 2.522 2.522z"
			/>
			<path
				fill="#ECB22E"
				d="M15.165 18.956a2.528 2.528 0 0 1 2.522 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522zm0-1.27a2.527 2.527 0 0 1-2.52-2.521 2.527 2.527 0 0 1 2.52-2.521h6.313A2.528 2.528 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.521z"
			/>
		</svg>
	)
}

function renderSpotifyIcon(size: string) {
	return (
		<svg
			viewBox="0 0 24 24"
			width={size}
			height={size}
			aria-hidden="true"
			fill="#1DB954"
		>
			<path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
		</svg>
	)
}

function renderNotionIcon(size: string) {
	return (
		<svg
			viewBox="0 0 24 24"
			width={size}
			height={size}
			aria-hidden="true"
			fill="currentColor"
		>
			<path d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z" />
		</svg>
	)
}

function renderLinearIcon(size: string) {
	return (
		<svg
			viewBox="0 0 24 24"
			width={size}
			height={size}
			aria-hidden="true"
			fill="#5E6AD2"
		>
			<path d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z" />
		</svg>
	)
}

function renderDiscordIcon(size: string) {
	// Clyde sits with more padding than the other 24×24 marks, so crop the
	// viewBox so it optically matches GitHub/Google/X at the same size.
	return (
		<svg
			viewBox="0 2.25 24 19.5"
			width={size}
			height={size}
			aria-hidden="true"
			fill="#5865F2"
		>
			<path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
		</svg>
	)
}

function renderAsanaIcon(size: string) {
	return (
		<svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
			<circle cx="12" cy="6.4" r="3.15" fill="#F06A6A" />
			<circle cx="7.15" cy="16.35" r="3.15" fill="#F06A6A" />
			<circle cx="16.85" cy="16.35" r="3.15" fill="#F06A6A" />
		</svg>
	)
}

function renderSentryIcon(size: string) {
	return (
		<svg
			viewBox="0 0 24 24"
			width={size}
			height={size}
			aria-hidden="true"
			fill="#362D59"
		>
			<path d="M13.91 2.505c-.873-1.448-2.972-1.448-3.844 0L6.904 7.92a15.478 15.478 0 0 1 8.53 12.811h-2.221A13.301 13.301 0 0 0 5.784 9.814l-2.926 5.06a7.65 7.65 0 0 1 4.435 5.848H2.194a.365.365 0 0 1-.298-.534l1.413-2.402a5.16 5.16 0 0 0-1.614-.913L.296 19.275a2.182 2.182 0 0 0 .812 2.999 2.24 2.24 0 0 0 1.086.288h6.983a9.322 9.322 0 0 0-3.845-8.318l1.11-1.922a11.47 11.47 0 0 1 4.95 10.24h5.915a17.242 17.242 0 0 0-7.885-15.28l2.244-3.845a.37.37 0 0 1 .504-.13c.255.14 9.75 16.708 9.928 16.9a.365.365 0 0 1-.327.543h-2.287c.029.612.029 1.223 0 1.831h2.297a2.206 2.206 0 0 0 1.922-3.31z" />
		</svg>
	)
}

function renderCanvaIcon(size: string) {
	return (
		<svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
			<circle cx="32" cy="32" r="32" fill="#00C4CC" />
			<path
				fill="#fff"
				d="M45.6 43.1c-1.7 2.3-3.9 4.7-6.8 6.5-2.8 1.8-6 3.2-9.8 3.2-3.5 0-6.4-1.8-8-3.3-2.4-2.3-3.7-5.6-4.1-8.7-1.2-9.6 4.7-22.3 13.8-27.8 2.1-1.3 4.4-1.9 6.6-1.9 4.4 0 7.7 3.1 8.1 6.9.4 3.4-.9 6.3-4.7 8.2-1.9 1-2.9.9-3.2.5-.2-.3-.1-.8.3-1.1 3.5-2.9 3.6-5.3 3.2-8.7-.3-2.2-1.7-3.6-3.3-3.6-6.9 0-16.9 15.5-15.5 26.7.5 4.4 3.2 9.5 8.8 9.5 1.8 0 3.8-.5 5.5-1.4 3.9-2 5.6-3.4 7.9-6.6.3-.4.6-.9.9-1.3.2-.4.6-.5.9-.5.3 0 .7.3.7.8 0 .3-.1.9-.5 1.4-.4.8-.7 1.4-1.1 1.8z"
			/>
		</svg>
	)
}

function renderAtlassianIcon(size: string) {
	return (
		<svg
			viewBox="0 0 24 24"
			width={size}
			height={size}
			aria-hidden="true"
			fill="#1868DB"
		>
			<path d="M7.12 11.084a.683.683 0 00-1.16.126L.075 22.974a.703.703 0 00.63 1.018h8.19a.678.678 0 00.63-.39c1.767-3.65.696-9.203-2.406-12.52zM11.434.386a15.515 15.515 0 00-.906 15.317l3.95 7.9a.703.703 0 00.628.388h8.19a.703.703 0 00.63-1.017L12.63.38a.664.664 0 00-1.196.006z" />
		</svg>
	)
}

function renderStripeIcon(size: string) {
	return (
		<svg
			viewBox="0 0 24 24"
			width={size}
			height={size}
			aria-hidden="true"
			fill="#635BFF"
		>
			<path d="M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.594-7.305h.003z" />
		</svg>
	)
}

function renderDropboxIcon(size: string) {
	return (
		<svg
			viewBox="0 0 24 24"
			width={size}
			height={size}
			aria-hidden="true"
			fill="#0061FF"
		>
			<path d="M6 1.807L0 5.629l6 3.822 6.001-3.822L6 1.807zM18 1.807l-6 3.822 6 3.822 6-3.822-6-3.822zM0 13.274l6 3.822 6.001-3.822L6 9.452l-6 3.822zM18 9.452l-6 3.822 6 3.822 6-3.822-6-3.822zM6 18.371l6.001 3.822 6-3.822-6-3.822L6 18.371z" />
		</svg>
	)
}

function renderGroupMeIcon(size: string) {
	return (
		<svg
			viewBox="0 0 24 24"
			width={size}
			height={size}
			aria-hidden="true"
			fill="#00AFF0"
		>
			<path d="M11.1597 6.57419H12.8398V8.16898H11.1597V6.57419ZM18.1997 0H5.80011C3.14898 0 1 2.03979 1 4.55577V16.3243C1 18.8402 3.14898 20.88 5.80011 20.88H9.92715L11.9786 24L14.0306 20.88H18.1997C20.8506 20.88 23 18.8402 23 16.3243V4.55574C23 2.03976 20.8506 0 18.1997 0ZM7.56833 8.16895H9.34755V6.57416H7.56833V4.85447H9.34755V3.16587H11.1597V4.85447H12.8398V3.16587H14.6519V4.85447H16.4308V6.57416H14.6519V8.16895H16.4308V9.88852H14.6519V11.5772H12.8398V9.88852H11.1597V11.5772H9.34755V9.88852H7.56833V8.16895ZM20.3122 13.4321C20.3122 13.4321 17.9202 17.708 12.2406 17.708C12.1619 17.708 12.0843 17.707 12.007 17.7057C11.9299 17.707 11.8522 17.708 11.7737 17.708C6.09416 17.708 3.70211 13.4321 3.70211 13.4321C3.70211 13.4321 3.54729 13.1536 3.54729 12.8534C3.53754 12.6368 3.64915 12.3263 3.9421 12.1433C4.105 12.0417 4.259 11.9914 4.40179 11.9757C5.08566 11.9069 5.48202 12.3295 5.80794 12.8121C6.16788 13.3447 8.24445 15.678 12.007 15.7672C15.7698 15.678 17.8464 13.3447 18.2063 12.8121C18.5322 12.3295 18.9429 11.9062 19.6125 11.9757C19.7553 11.9914 19.9094 12.0417 20.0722 12.1433C20.3652 12.3263 20.4792 12.5839 20.469 12.8532C20.446 13.2494 20.3122 13.4321 20.3122 13.4321Z" />
		</svg>
	)
}

function renderLinkedInIcon(size: string) {
	return (
		<svg
			viewBox="0 0 24 24"
			width={size}
			height={size}
			aria-hidden="true"
			fill="#0A66C2"
		>
			<path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
		</svg>
	)
}

function renderProductHuntIcon(size: string) {
	return (
		<svg
			viewBox="0 0 24 24"
			width={size}
			height={size}
			aria-hidden="true"
			fill="#DA552F"
		>
			<path d="M13.604 8.4h-3.405V12h3.405c.995 0 1.801-.806 1.801-1.801 0-.993-.805-1.799-1.801-1.799zM12 0C5.372 0 0 5.372 0 12s5.372 12 12 12 12-5.372 12-12S18.628 0 12 0zm1.604 14.4h-3.405V18H7.801V6h5.804c2.319 0 4.2 1.88 4.2 4.199 0 2.321-1.881 4.201-4.201 4.201z" />
		</svg>
	)
}

function renderTelegramIcon(size: string) {
	return (
		<svg
			viewBox="0 0 24 24"
			width={size}
			height={size}
			aria-hidden="true"
			fill="#26A5E4"
		>
			<path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
		</svg>
	)
}

function renderTeslaIcon(size: string) {
	return (
		<svg
			viewBox="0 0 24 24"
			width={size}
			height={size}
			aria-hidden="true"
			fill="#CC0000"
		>
			<path d="M12 5.362l2.475-3.026s4.245.09 8.471 2.054c-1.082 1.636-3.231 2.438-3.231 2.438-.146-1.439-1.154-1.79-4.354-1.79L12 24 8.619 5.034c-3.18 0-4.188.354-4.335 1.792 0 0-2.146-.795-3.229-2.43C5.28 2.431 9.525 2.34 9.525 2.34L12 5.362l-.004.002H12v-.002zm0-3.899c3.415-.03 7.326.528 11.328 2.28.535-.968.672-1.395.672-1.395C19.625.612 15.528.015 12 0 8.472.015 4.375.61 0 2.349c0 0 .195.525.672 1.396C4.674 1.989 8.585 1.435 12 1.46v.003z" />
		</svg>
	)
}

function renderTwitchIcon(size: string) {
	return (
		<svg
			viewBox="0 0 24 24"
			width={size}
			height={size}
			aria-hidden="true"
			fill="#9146FF"
		>
			<path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z" />
		</svg>
	)
}

function renderXeroIcon(size: string) {
	return (
		<svg
			viewBox="0 0 24 24"
			width={size}
			height={size}
			aria-hidden="true"
			fill="#13B5EA"
		>
			<path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm6.585 14.655c-1.485 0-2.69-1.206-2.69-2.689 0-1.485 1.207-2.691 2.69-2.691 1.485 0 2.69 1.207 2.69 2.691s-1.207 2.689-2.69 2.689zM7.53 14.644c-.099 0-.192-.041-.267-.116l-2.043-2.04-2.052 2.047c-.069.068-.16.108-.258.108-.202 0-.368-.166-.368-.368 0-.099.04-.191.111-.263l2.04-2.05-2.038-2.047c-.075-.069-.113-.162-.113-.261 0-.203.166-.366.368-.366.098 0 .188.037.258.105l2.055 2.048 2.048-2.045c.069-.071.162-.108.26-.108.211 0 .375.165.375.366 0 .098-.029.188-.104.258l-2.056 2.055 2.055 2.051c.068.069.104.16.104.258 0 .202-.165.368-.365.368h-.01zm8.017-4.591c-.796.101-.882.476-.882 1.404v2.787c0 .202-.165.366-.366.366-.203 0-.367-.165-.368-.366v-4.53c0-.204.16-.366.362-.366.166 0 .316.125.346.289.27-.209.6-.317.93-.317h.105c.195 0 .359.165.359.368 0 .201-.164.352-.375.359 0 0-.09 0-.164.008l.053-.002zm-3.091 2.205H8.625c0 .019.003.037.006.057.02.105.045.211.083.31.194.531.765 1.275 1.829 1.29.33-.003.631-.086.9-.229.21-.12.391-.271.525-.428.045-.058.09-.112.12-.168.18-.229.405-.186.54-.083.164.135.18.391.045.57l-.016.016c-.21.27-.435.495-.689.66-.255.164-.525.284-.811.345-.33.09-.645.104-.975.06-1.095-.135-2.01-.93-2.28-2.01-.06-.21-.09-.42-.09-.645 0-.855.421-1.695 1.125-2.205.885-.615 2.085-.66 3-.075.63.405 1.035 1.021 1.185 1.771.075.419-.21.794-.734.81l.068-.046zm6.129-2.223c-1.064 0-1.931.865-1.931 1.931 0 1.064.866 1.931 1.931 1.931s1.931-.867 1.931-1.931c0-1.065-.866-1.933-1.931-1.933v.002zm0 2.595c-.367 0-.666-.297-.666-.666 0-.367.3-.665.666-.665.367 0 .667.299.667.665 0 .369-.3.667-.667.666zm-8.04-2.603c-.91 0-1.672.623-1.886 1.466v.03h3.776c-.203-.855-.973-1.494-1.891-1.494v-.002z" />
		</svg>
	)
}

function renderZoomIcon(size: string) {
	// Official mark is the wide "Zoom" wordmark in a 24×24 canvas — only
	// ~5.5 units tall. Crop the empty vertical padding and meet-fit width
	// so it spans the well like other chips without overflowing.
	return (
		<svg
			viewBox="0 9.25 24 5.5"
			width={size}
			height={size}
			preserveAspectRatio="xMidYMid meet"
			aria-hidden="true"
			fill="currentColor"
		>
			<path d="M5.033 14.649H.743a.74.74 0 0 1-.686-.458.74.74 0 0 1 .16-.808L3.19 10.41H1.06A1.06 1.06 0 0 1 0 9.35h3.957c.301 0 .57.18.686.458a.74.74 0 0 1-.161.808L1.51 13.59h2.464c.585 0 1.06.475 1.06 1.06zM24 11.338c0-1.14-.927-2.066-2.066-2.066-.61 0-1.158.265-1.537.686a2.061 2.061 0 0 0-1.536-.686c-1.14 0-2.066.926-2.066 2.066v3.311a1.06 1.06 0 0 0 1.06-1.06v-2.251a1.004 1.004 0 0 1 2.013 0v2.251c0 .586.474 1.06 1.06 1.06v-3.311a1.004 1.004 0 0 1 2.012 0v2.251c0 .586.475 1.06 1.06 1.06zM16.265 12a2.728 2.728 0 1 1-5.457 0 2.728 2.728 0 0 1 5.457 0zm-1.06 0a1.669 1.669 0 1 0-3.338 0 1.669 1.669 0 0 0 3.338 0zm-4.82 0a2.728 2.728 0 1 1-5.458 0 2.728 2.728 0 0 1 5.457 0zm-1.06 0a1.669 1.669 0 1 0-3.338 0 1.669 1.669 0 0 0 3.338 0z" />
		</svg>
	)
}

const knownProviderIconIds = [
	'asana',
	'atlassian',
	'canva',
	'discord',
	'dropbox',
	'github',
	'google',
	'groupme',
	'linear',
	'linkedin',
	'notion',
	'producthunt',
	'sentry',
	'slack',
	'spotify',
	'stripe',
	'telegram',
	'tesla',
	'twitch',
	'x',
	'xero',
	'zoom',
] as const

type ProviderIconId = (typeof knownProviderIconIds)[number]

const providerIconRenderers: Record<
	ProviderIconId,
	(size: string) => JSX.Element
> = {
	asana: renderAsanaIcon,
	atlassian: renderAtlassianIcon,
	canva: renderCanvaIcon,
	discord: renderDiscordIcon,
	dropbox: renderDropboxIcon,
	github: renderGitHubIcon,
	google: renderGoogleIcon,
	groupme: renderGroupMeIcon,
	linear: renderLinearIcon,
	linkedin: renderLinkedInIcon,
	notion: renderNotionIcon,
	producthunt: renderProductHuntIcon,
	sentry: renderSentryIcon,
	slack: renderSlackIcon,
	spotify: renderSpotifyIcon,
	stripe: renderStripeIcon,
	telegram: renderTelegramIcon,
	tesla: renderTeslaIcon,
	twitch: renderTwitchIcon,
	x: renderXIcon,
	xero: renderXeroIcon,
	zoom: renderZoomIcon,
}

export function ProviderIcon(props: {
	providerId: string
	/** Icon box size; inline-with-text usages should pass `1em`. */
	size?: string
}) {
	return (
		providerIconRenderers[props.providerId as ProviderIconId]?.(
			props.size ?? defaultIconSize,
		) ?? null
	)
}

/**
 * Display priority for a provider mark: explicit upload, operator-curated
 * catalog mark, auto-fetched favicon, then the letter fallback.
 * Login and onboarding still use the official inline ProviderIcon set.
 */
function resolveProviderMarkSource(input: {
	logoPath?: string | null
	autoLogoPath?: string | null
	catalogLogoPath?: string | null
}): 'upload' | 'favicon' | 'catalog' | 'letter' {
	if (input.logoPath?.trim()) return 'upload'
	if (input.catalogLogoPath?.trim()) return 'catalog'
	if (input.autoLogoPath?.trim()) return 'favicon'
	return 'letter'
}

/**
 * Provider identity for connect / integration headers: uploaded logo,
 * operator catalog mark, auto-favicon, or a letter fallback. Always sits
 * on the white logo well so dark marks stay readable in dark mode.
 */
export function ProviderMark(props: {
	providerKey: string
	label: string
	logoPath?: string | null
	autoLogoPath?: string | null
	catalogLogoPath?: string | null
	host?: string | null
	size?: string
}) {
	const { label, logoPath, autoLogoPath, catalogLogoPath } = props
	const wellSize = props.size ?? '3rem'
	const source = resolveProviderMarkSource({
		logoPath,
		autoLogoPath,
		catalogLogoPath,
	})
	const letter = label.trim().charAt(0).toUpperCase() || '?'
	const imagePath =
		source === 'upload'
			? logoPath
			: source === 'favicon'
				? autoLogoPath
				: catalogLogoPath
	return (
		<span
			aria-hidden="true"
			data-testid="provider-mark"
			data-source={source}
			css={{
				...getLogoWellCss({
					size: wellSize,
					radius: '0',
				}),
				fontWeight: 700,
				fontSize: `calc(${wellSize} * 0.42)`,
				lineHeight: 1,
			}}
		>
			{source === 'letter' ? (
				letter
			) : (
				<img
					src={publicAsset(imagePath ?? '')}
					alt=""
					width={40}
					height={40}
					css={{
						display: 'block',
						width: '70%',
						height: '70%',
						objectFit: 'contain' as const,
					}}
				/>
			)}
		</span>
	)
}
