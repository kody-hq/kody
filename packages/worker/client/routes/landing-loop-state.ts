import type {
	TranscriptAct,
	TranscriptLine,
	TranscriptScene,
} from './interactive-guide-transcript.ts'

export const landingLoopTeaser = {
	kicker: 'You start on the computer with {coding}.',
	title: 'Ask once',
	user: 'What did my favorite bot ship recently on GitHub?',
} as const

/** Act header plus the first user turn — matches the SSR teaser. */
export const landingLoopTeaserBeatCount = 2

export type LandingLoopToggleLabel = 'Restart' | 'Play' | 'Pause'

/**
 * Header control for the factory loop. Pause is the default — including
 * before the transcript chunk loads — so SSR reserves the combined
 * playing/pause control and first paint does not shift.
 */
export function landingLoopToggleLabel(input: {
	reducedMotion: boolean
	ended: boolean
	paused: boolean
}): LandingLoopToggleLabel | null {
	if (input.reducedMotion) return null
	if (input.ended) return 'Restart'
	if (input.paused) return 'Play'
	return 'Pause'
}

export type LandingLoopPauseReason =
	| 'hover'
	| 'focus'
	| 'explore'
	| 'offscreen'
	| 'manual'
	| 'ended'

type LandingLoopScene = TranscriptScene | 'desk'

export type LandingLoopBeat =
	| {
			kind: 'act'
			id: string
			kicker: string
			title: string
			later?: string
			scene: LandingLoopScene
	  }
	| {
			kind: 'line'
			actId: string
			scene: LandingLoopScene
			line: TranscriptLine
	  }

export type LandingLoopSceneGroup = {
	scene: LandingLoopScene
	beats: Array<LandingLoopBeat>
}

function actScene(act: TranscriptAct): LandingLoopScene {
	return act.scene === 'phone' ? 'phone' : 'desk'
}

export type LandingLoopAdvance = {
	didAdvance: boolean
	ended: boolean
}

export function flattenTranscriptActs(
	acts: ReadonlyArray<TranscriptAct>,
): Array<LandingLoopBeat> {
	const beats: Array<LandingLoopBeat> = []
	for (const act of acts) {
		const scene = actScene(act)
		beats.push({
			kind: 'act',
			id: act.id,
			kicker: act.kicker,
			title: act.title,
			later: act.later,
			scene,
		})
		for (const line of act.lines) {
			beats.push({ kind: 'line', actId: act.id, scene, line })
		}
	}
	return beats
}

function landingLoopBeatActId(beat: LandingLoopBeat) {
	return beat.kind === 'act' ? beat.id : beat.actId
}

export function groupLandingLoopScenes(
	beats: ReadonlyArray<LandingLoopBeat>,
): Array<LandingLoopSceneGroup> {
	const groups: Array<LandingLoopSceneGroup> = []
	for (const beat of beats) {
		const last = groups.at(-1)
		const lastActId = last ? landingLoopBeatActId(last.beats[0]!) : null
		if (last && lastActId === landingLoopBeatActId(beat)) {
			last.beats.push(beat)
			continue
		}
		groups.push({ scene: beat.scene, beats: [beat] })
	}
	return groups
}

export function landingLoopChatScrollShouldExplore(input: {
	autoScrolling: boolean
	userDriven: boolean
	atBottom: boolean
}) {
	return !input.autoScrolling && input.userDriven && !input.atBottom
}

export function landingLoopHoldMs(beat: LandingLoopBeat): number {
	if (beat.kind === 'act') return 1100
	switch (beat.line.role) {
		case 'user':
		case 'agent':
			return Math.min(2200, 500 + beat.line.text.length * 4) + 700
		case 'email':
			return (
				Math.min(
					2200,
					500 + (beat.line.subject.length + beat.line.text.length) * 4,
				) + 700
			)
		case 'tools':
		case 'files':
			return 1500
		default: {
			const exhaustive: never = beat.line
			return exhaustive
		}
	}
}

export function createLandingLoopPlayer(input: {
	beatCount: number
	reducedMotion: boolean
}) {
	const listeners = new Set<() => void>()
	const reasons = new Set<LandingLoopPauseReason>()
	let revealedCount = input.reducedMotion
		? input.beatCount
		: Math.min(landingLoopTeaserBeatCount, input.beatCount)
	let ignorePointerPause = false

	function emit() {
		for (const listener of Array.from(listeners)) listener()
	}

	function isPaused() {
		return input.reducedMotion || reasons.size > 0
	}

	function setReason(reason: LandingLoopPauseReason, on: boolean) {
		const had = reasons.has(reason)
		if (on) reasons.add(reason)
		else reasons.delete(reason)
		if (had === on) return
		emit()
	}

	function clearPlayableReasons() {
		ignorePointerPause = true
		reasons.delete('explore')
		reasons.delete('manual')
		reasons.delete('hover')
		reasons.delete('focus')
	}

	return {
		get revealedCount() {
			return revealedCount
		},
		isPaused,
		pauseReasons(): Array<LandingLoopPauseReason> {
			return [...reasons]
		},
		subscribe(listener: () => void) {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
		setHover(on: boolean) {
			if (!on) {
				ignorePointerPause = false
				setReason('hover', false)
				return
			}
			if (ignorePointerPause) return
			setReason('hover', true)
		},
		setFocus(on: boolean) {
			if (!on) {
				ignorePointerPause = false
				setReason('focus', false)
				return
			}
			if (ignorePointerPause) return
			setReason('focus', true)
		},
		setExplore(on: boolean) {
			setReason('explore', on)
		},
		setOffscreen(on: boolean) {
			setReason('offscreen', on)
		},
		pause() {
			ignorePointerPause = false
			setReason('manual', true)
		},
		end() {
			setReason('ended', true)
		},
		isEnded() {
			return reasons.has('ended')
		},
		play() {
			// Always ignore the hover/focus that follows a Play tap. Mobile
			// often focuses the scrollable chat right after that click.
			clearPlayableReasons()
			emit()
		},
		restart() {
			revealedCount = input.reducedMotion
				? input.beatCount
				: Math.min(landingLoopTeaserBeatCount, input.beatCount)
			clearPlayableReasons()
			reasons.delete('ended')
			emit()
		},
		skipToEnd() {
			revealedCount = input.beatCount
			clearPlayableReasons()
			setReason('ended', true)
		},
		advance(): LandingLoopAdvance {
			if (isPaused() || input.beatCount === 0) {
				return { didAdvance: false, ended: reasons.has('ended') }
			}
			if (revealedCount >= input.beatCount) {
				setReason('ended', true)
				return { didAdvance: false, ended: true }
			}
			revealedCount += 1
			emit()
			return { didAdvance: true, ended: false }
		},
	}
}

export async function waitLandingLoopHold(input: {
	ms: number
	isPaused: () => boolean
	subscribe: (listener: () => void) => () => void
	signal: AbortSignal
}): Promise<boolean> {
	let remaining = input.ms

	function waitFor(kind: 'slice' | 'resume', ms?: number) {
		return new Promise<'sleep' | 'abort' | 'change'>((resolve) => {
			const timer =
				kind === 'slice' && ms != null
					? setTimeout(() => finish('sleep'), ms)
					: null
			function finish(event: 'sleep' | 'abort' | 'change') {
				if (timer != null) clearTimeout(timer)
				input.signal.removeEventListener('abort', onAbort)
				unsubscribe()
				resolve(event)
			}
			function onAbort() {
				finish('abort')
			}
			const unsubscribe = input.subscribe(() => {
				finish('change')
			})
			input.signal.addEventListener('abort', onAbort, { once: true })
			if (input.signal.aborted) finish('abort')
		})
	}

	while (remaining > 0) {
		if (input.signal.aborted) return false
		if (input.isPaused()) {
			const event = await waitFor('resume')
			if (event === 'abort') return false
			continue
		}
		const slice = Math.min(remaining, 200)
		const started = Date.now()
		const event = await waitFor('slice', slice)
		if (event === 'abort') return false
		if (event === 'change') {
			remaining -= Date.now() - started
			continue
		}
		remaining -= slice
	}
	return !input.signal.aborted
}
