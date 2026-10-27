import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bytesToBase64 } from '@kody-internal/shared/base64.ts'
import {
	landingOrbitAgents,
	type LandingOrbitAgentIcon,
} from '#universal/landing-agent-orbit.ts'
import { getOgPalette, type OgTheme } from '#worker/og/palette.ts'

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '../../public')
const publicOgDir = join(publicDir, 'og')
const publicIconsDir = join(publicDir, 'images', 'icons')
const publicBrandDir = join(publicDir, 'images', 'brand')

const AGENT_ICON_IDS = landingOrbitAgents.map((agent) => agent.icon)

type AgentIconSvgById = Record<LandingOrbitAgentIcon, string>

type OgBinaryAssetCache = {
	bricolageGrotesqueLatin700: ArrayBuffer
	wixMadeforTextLatin400: ArrayBuffer
	kodyPatternDarkDataUri: string
	kodyPatternLightDataUri: string
	kodyBaseDataUri: string
	kodyPrimitivesLanternDataUri: string
	kodyDiscordDataUri: string
	kodyMarkSolidSvg: string
	kodyMarkOutlinedSvg: string
	agentIconSvgs: AgentIconSvgById
}

let cache: OgBinaryAssetCache | null = null

export type OgAssetsFetcher = { fetch: (request: Request) => Promise<Response> }

function readOgAssetFile(name: string): Uint8Array {
	return readFileSync(join(publicOgDir, name))
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer
}

function bytesToPngDataUri(bytes: Uint8Array): string {
	return `data:image/png;base64,${bytesToBase64(bytes)}`
}

function tintSvgFills(svg: string, color: string): string {
	return svg.replace(/fill="[^"]*"/gi, `fill="${color}"`)
}

function svgToDataUri(svg: string): string {
	return `data:image/svg+xml;base64,${bytesToBase64(
		new TextEncoder().encode(svg),
	)}`
}

function loadAgentIconSvgs(): AgentIconSvgById {
	const agentIconSvgs = {} as AgentIconSvgById
	for (const icon of AGENT_ICON_IDS) {
		agentIconSvgs[icon] = readFileSync(
			join(publicIconsDir, `${icon}.svg`),
			'utf8',
		)
	}
	return agentIconSvgs
}

function ensureCache(): OgBinaryAssetCache {
	if (cache) return cache
	cache = {
		bricolageGrotesqueLatin700: toArrayBuffer(
			readOgAssetFile('bricolage-grotesque-latin-700.ttf'),
		),
		wixMadeforTextLatin400: toArrayBuffer(
			readOgAssetFile('wix-madefor-text-latin-400.ttf'),
		),
		kodyPatternDarkDataUri: bytesToPngDataUri(
			readOgAssetFile('kody-pattern-dark.png'),
		),
		kodyPatternLightDataUri: bytesToPngDataUri(
			readOgAssetFile('kody-pattern-light.png'),
		),
		// Same pixels as `images/hero/kody-base-640.webp` (PNG for Satori).
		kodyBaseDataUri: bytesToPngDataUri(readOgAssetFile('kody-base.png')),
		// Rest pose of the layered homepage lantern (PNG for Satori).
		kodyPrimitivesLanternDataUri: bytesToPngDataUri(
			readOgAssetFile('kody-primitives-lantern.png'),
		),
		kodyDiscordDataUri: bytesToPngDataUri(readOgAssetFile('kody-discord.png')),
		kodyMarkSolidSvg: readFileSync(
			join(publicBrandDir, 'kody-mark-white.svg'),
			'utf8',
		),
		kodyMarkOutlinedSvg: readFileSync(
			join(publicBrandDir, 'kody-mark-outlined.svg'),
			'utf8',
		),
		agentIconSvgs: loadAgentIconSvgs(),
	}
	return cache
}

/** Test hook: clears the per-process OG binary asset cache. */
export function resetOgBinaryAssetsCache() {
	cache = null
}

export async function ensureOgBinaryAssetsReady(_input?: {
	assets?: OgAssetsFetcher
}): Promise<void> {
	ensureCache()
}

export function getBricolageGrotesqueLatin700FontData(): ArrayBuffer {
	return ensureCache().bricolageGrotesqueLatin700
}

export function getWixMadeforTextLatin400FontData(): ArrayBuffer {
	return ensureCache().wixMadeforTextLatin400
}

export function getKodyPatternDataUri(theme: 'light' | 'dark'): string {
	const loaded = ensureCache()
	return theme === 'light'
		? loaded.kodyPatternLightDataUri
		: loaded.kodyPatternDarkDataUri
}

export function getKodyBaseDataUri(): string {
	return ensureCache().kodyBaseDataUri
}

export function getKodyPrimitivesLanternDataUri(): string {
	return ensureCache().kodyPrimitivesLanternDataUri
}

export function getLandingAgentIconDataUri(
	icon: LandingOrbitAgentIcon,
	theme: OgTheme,
): string {
	const svg = ensureCache().agentIconSvgs[icon]
	return svgToDataUri(tintSvgFills(svg, getOgPalette(theme).text))
}

export function getKodyDiscordDataUri(): string {
	return ensureCache().kodyDiscordDataUri
}

/** Node twin of `getKodyMarkDataUri` in `og-binary-assets.ts`. */
export function getKodyMarkDataUri(theme: OgTheme): string {
	const loaded = ensureCache()
	const svg =
		theme === 'light' ? loaded.kodyMarkOutlinedSvg : loaded.kodyMarkSolidSvg
	return svgToDataUri(tintSvgFills(svg, getOgPalette(theme).text))
}
