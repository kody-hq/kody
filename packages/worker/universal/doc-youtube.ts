import { parseYoutubeVideoId } from '#universal/youtube-watch.ts'

/**
 * First-party docs watch block. A guide authors one of these when a video
 * is the lesson for that page:
 *
 * ```md
 * > [!WATCH] https://www.youtube.com/watch?v=xxxxxxxxxxx
 * > Watch: Real video title
 * ```
 *
 * Use `[!WATCH-VERTICAL]` instead of `[!WATCH]` for a 9:16 recording
 * (phone-shot video) so the player keeps the video's shape instead of
 * pillarboxing it in a 16:9 frame.
 *
 * The formatter may wrap that into one blockquote paragraph. The marker
 * and URL stay first; the rest of the block is the caption. The docs
 * renderer turns it into the lite YouTube player. Raw markdown (agents,
 * GitHub) keeps the title and URL as a blockquote. Link-only mentions
 * stay ordinary markdown links and never use this marker.
 */
const watchMarkerRe = /^\[!WATCH(-VERTICAL)?\]\s+(\S+)\s*(.*)$/
const watchLabelPrefixRe = /^Watch:\s+/

export type DocWatchEmbed = {
	videoId: string
	/** Canonical watch page, not the privacy-enhanced embed host. */
	href: string
	/** Visible caption, including the "Watch:" prefix. */
	label: string
	/** Real video title, used for the iframe and play button. */
	title: string
	/** `true` for a `[!WATCH-VERTICAL]` block (9:16 video). */
	vertical: boolean
}

export function docYoutubeWatchUrl(videoId: string): string {
	return `https://www.youtube.com/watch?v=${videoId}`
}

/**
 * Parse one watch block. Accepts the authored `>` lines or marked's
 * unquoted blockquote text.
 */
export function parseDocWatchBlock(raw: string): DocWatchEmbed | null {
	const lines = watchBlockLines(raw)
	if (!lines) return null
	const [markerLine, ...labelLines] = lines
	if (!markerLine) return null
	const marker = watchMarkerRe.exec(markerLine.trim())
	const target = marker?.[2] ?? ''
	if (!/^https?:\/\//i.test(target)) return null
	const videoId = parseYoutubeVideoId(target)
	if (!videoId) return null
	const label = [marker?.[3], ...labelLines]
		.map((line) => line?.trim() ?? '')
		.filter(Boolean)
		.join(' ')
	if (!label) return null
	const title = label.replace(watchLabelPrefixRe, '').trim()
	return {
		videoId,
		href: docYoutubeWatchUrl(videoId),
		label,
		title: title || label,
		vertical: Boolean(marker?.[1]),
	}
}

/** Every valid watch block in a guide body, in source order. */
export function listDocWatchEmbeds(markdown: string): Array<DocWatchEmbed> {
	const embeds: Array<DocWatchEmbed> = []
	for (const raw of watchBlockSources(markdown)) {
		const embed = parseDocWatchBlock(raw)
		if (embed) embeds.push(embed)
	}
	return embeds
}

/**
 * Watch blocks lifted out of a guide body, still authored as blockquotes.
 * Interactive docs replace the prose with a walkthrough, so the page
 * renders this slice above that walkthrough. A following "Also watch"
 * paragraph stays with the player so that link is not dropped with the
 * rest of the body.
 */
export function extractDocWatchMarkdown(markdown: string): string {
	const lines = markdown.replace(/\r\n/g, '\n').split('\n')
	const chunks: Array<string> = []
	let index = 0
	while (index < lines.length) {
		if (!lines[index]?.startsWith('>')) {
			index += 1
			continue
		}
		const start = index
		while (index < lines.length && lines[index]?.startsWith('>')) index += 1
		const raw = lines.slice(start, index).join('\n')
		if (!parseDocWatchBlock(raw)) continue
		while (index < lines.length && (lines[index]?.trim() ?? '') === '') {
			index += 1
		}
		let follow = ''
		if (lines[index]?.startsWith('Also watch')) {
			const followStart = index
			index += 1
			while (index < lines.length) {
				const line = lines[index]
				if (line === undefined || line.trim() === '' || line.startsWith('#')) {
					break
				}
				index += 1
			}
			follow = lines.slice(followStart, index).join('\n')
		}
		chunks.push(follow ? `${raw}\n\n${follow}` : raw)
	}
	return chunks.join('\n\n')
}

function watchBlockSources(markdown: string): Array<string> {
	const lines = markdown.replace(/\r\n/g, '\n').split('\n')
	const blocks: Array<string> = []
	let index = 0
	while (index < lines.length) {
		if (!lines[index]?.startsWith('>')) {
			index += 1
			continue
		}
		const start = index
		while (index < lines.length && lines[index]?.startsWith('>')) index += 1
		blocks.push(lines.slice(start, index).join('\n'))
	}
	return blocks
}

function watchBlockLines(raw: string): Array<string> | null {
	const lines = raw.replace(/\r\n/g, '\n').trim().split('\n')
	if (lines.length === 0 || lines[0] === undefined) return null
	if (lines.every((line) => line.startsWith('>'))) {
		return lines.map((line) => line.replace(/^>\s?/, ''))
	}
	if (lines.some((line) => line.startsWith('>'))) return null
	return lines
}
