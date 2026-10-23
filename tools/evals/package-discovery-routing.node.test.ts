import { expect, test } from 'vitest'
import {
	actionSchema,
	loadPackageDiscoveryEval,
	scorePackageDiscoveryTranscript,
	transcriptSchema,
} from './package-discovery-routing.ts'

const createPassingTranscript = (): unknown => {
	const evalSet = loadPackageDiscoveryEval()
	return {
		schemaVersion: 1 as const,
		evalName: 'package-discovery-routing' as const,
		host: 'cursor' as const,
		model: 'test-model',
		runAt: '2026-07-14T21:00:00.000Z',
		results: evalSet.cases.map((evalCase) => {
			const entityId = `fixture:${evalCase.id}`
			const searchCall = {
				callId: `search:${evalCase.id}`,
				action: 'search' as const,
				toolName: 'search' as const,
				status: 'succeeded' as const,
				input: { query: evalCase.prompt },
				output: { result: 'captured search output' },
				match:
					evalCase.expected.route === 'existing'
						? ({
								kind: 'exact-reusable' as const,
								entityId,
							} as const)
						: ({ kind: 'no-exact-reusable' as const } as const),
			}
			const terminalAction = evalCase.expected.terminalAction
			const terminalCall =
				terminalAction === 'invoke-existing'
					? ({
							callId: `execute:${evalCase.id}`,
							action: terminalAction,
							toolName: 'execute' as const,
							status: 'succeeded' as const,
							input: {
								code: `import ${JSON.stringify(entityId)}`,
							},
							output: { result: 'captured invocation output' },
							targetEntityId: entityId,
						} as const)
					: ({
							callId: `execute:${evalCase.id}`,
							action: terminalAction,
							toolName: 'execute' as const,
							status: 'succeeded' as const,
							input: {
								code:
									terminalAction === 'author-package'
										? 'await kody.packageSave({})'
										: evalCase.id === 'schedule-single-reminder'
											? "await workflows.create({ runAt: '2026-07-15T16:00:00.000Z', code: 'export default async function main() {}' })"
											: 'return await kody.valueList({})',
							},
							output: { result: 'captured execution output' },
						} as const)
			const searchCalls =
				evalCase.expected.route === 'existing'
					? [
							{
								...searchCall,
								callId: `${searchCall.callId}:query`,
								match: { kind: 'no-exact-reusable' as const },
							},
							{
								...searchCall,
								callId: `${searchCall.callId}:entity`,
								input: { entity: entityId },
							},
						]
					: [searchCall]
			return {
				caseId: evalCase.id,
				outcome: 'completed' as const,
				events: [...searchCalls, terminalCall],
			}
		}),
	}
}

function getByCaseId<T extends { caseId: string }>(
	items: ReadonlyArray<T>,
	caseId: string,
): T {
	const item = items.find((candidate) => candidate.caseId === caseId)
	if (!item) throw new Error(`Expected fixture for ${caseId}.`)
	return item
}

function requireCompletedResult(
	transcript: ReturnType<typeof transcriptSchema.parse>,
	caseId: string,
) {
	const result = getByCaseId(transcript.results, caseId)
	if (result.outcome !== 'completed') {
		throw new Error(`Expected a completed fixture for ${caseId}.`)
	}
	return result
}

const freshTranscript = () => transcriptSchema.parse(createPassingTranscript())
const score = (transcript: ReturnType<typeof freshTranscript>) =>
	scorePackageDiscoveryTranscript(loadPackageDiscoveryEval(), transcript)
const errorsFor = (report: ReturnType<typeof score>, caseId: string) =>
	getByCaseId(report.cases, caseId).errors
const authorBrief = 'author-reusable-scheduled-brief'
const passingTotals = { passed: 8, failed: 0, skipped: 0, total: 8 }

function executeEvent<Action extends string>(
	callId: string,
	action: Action,
	code: string,
	output: Record<string, unknown>,
) {
	return {
		callId,
		action,
		toolName: 'execute' as const,
		status: 'succeeded' as const,
		input: { code },
		output,
	}
}

test('scorer accepts exact traces and reports two passes per route', () => {
	const report = score(freshTranscript())
	expect(report.ok).toBe(true)
	expect(report.totals).toEqual(passingTotals)
	for (const [route, routeScore] of Object.entries(report.byRoute)) {
		const expectedPassCount = route === 'existing' ? 2 : 3
		expect(routeScore).toEqual({
			passed: expectedPassCount,
			failed: 0,
			skipped: 0,
			total: expectedPassCount,
		})
	}
})

test('scorer rejects wrong targets, duplicates, payload drift, skips, and cardinality breaches', () => {
	const transcript = freshTranscript()
	const existingResult = requireCompletedResult(
		transcript,
		'reuse-recurring-email-drafter',
	)
	const oneOffResult = requireCompletedResult(
		transcript,
		'one-off-saved-automation-count',
	)
	const controlledResult = getByCaseId(
		transcript.results,
		'schedule-single-reminder',
	)
	const noTraceResult = requireCompletedResult(
		transcript,
		'schedule-simple-recurring-reminder',
	)

	const invocation = existingResult.events.find(
		(event) => event.action === 'invoke-existing',
	)
	if (!invocation || invocation.action !== 'invoke-existing') {
		throw new Error('Expected an existing-result invocation fixture.')
	}
	invocation.targetEntityId = 'fixture:wrong-target'
	oneOffResult.events.splice(1, 0, {
		callId: `execute:${oneOffResult.caseId}:wrong`,
		action: 'author-package',
		toolName: 'execute',
		status: 'failed',
		input: { code: 'await kody.packageSave({})' },
		output: { error: 'failed' },
	})
	transcript.results.splice(transcript.results.indexOf(controlledResult), 1, {
		caseId: controlledResult.caseId,
		outcome: 'skipped-no-eligible-match',
		note: 'incorrect skip',
	})
	noTraceResult.events = []

	const invalidReport = score(transcript)
	expect(invalidReport.ok).toBe(false)
	expect(invalidReport.totals.failed).toBe(4)
	expect(errorsFor(invalidReport, 'reuse-recurring-email-drafter')).toContain(
		'invocation target does not match the discovered entity',
	)
	expect(errorsFor(invalidReport, 'one-off-saved-automation-count')).toEqual(
		expect.arrayContaining([
			'extraneous action author-package',
			'trace contains a failed tool call',
		]),
	)
	expect(errorsFor(invalidReport, 'schedule-single-reminder')).toContain(
		'controlled-inventory case cannot be skipped',
	)
	expect(
		errorsFor(invalidReport, 'schedule-simple-recurring-reminder'),
	).toEqual(
		expect.arrayContaining([
			'first action must be search',
			'missing required action author-package',
		]),
	)
	expect(actionSchema.safeParse('explain-only').success).toBe(false)

	const duplicateTranscript = freshTranscript()
	const scheduleResult = requireCompletedResult(
		duplicateTranscript,
		'schedule-single-reminder',
	)
	const scheduleEvent = scheduleResult.events[1]
	if (!scheduleEvent || scheduleEvent.action !== 'execute-one-off') {
		throw new Error('Expected a deferred workflow event fixture.')
	}
	scheduleResult.events.push({
		...scheduleEvent,
		callId: `${scheduleEvent.callId}:duplicate`,
	})
	const duplicateReport = score(duplicateTranscript)
	expect(duplicateReport.ok).toBe(false)
	expect(duplicateReport.totals.failed).toBe(1)
	expect(errorsFor(duplicateReport, 'schedule-single-reminder')).toContain(
		'expected exactly 1 execute-one-off action, received 2',
	)
	expect(duplicateReport.byRoute['execute-one-off']).toEqual({
		passed: 2,
		failed: 1,
		skipped: 0,
		total: 3,
	})

	const consistentTranscript = freshTranscript()
	const authoringResult = requireCompletedResult(
		consistentTranscript,
		authorBrief,
	)
	const authoringEvent = authoringResult.events.at(-1)
	if (!authoringEvent || authoringEvent.action !== 'author-package') {
		throw new Error('Expected an authoring event fixture.')
	}
	authoringEvent.input = {
		code: 'await kody.codingGuideGet({}); await kody.packageSave({})',
	}
	authoringResult.events.splice(-1, 0, {
		...authoringEvent,
		action: 'inspect-authoring-guidance',
	})
	expect(score(consistentTranscript).ok).toBe(true)

	for (const mismatch of ['input', 'output'] as const) {
		const mismatchedTranscript = structuredClone(consistentTranscript)
		const lastEvent = requireCompletedResult(
			mismatchedTranscript,
			authorBrief,
		).events.at(-1)!
		if (mismatch === 'input') {
			lastEvent.input = { code: 'await kody.packageSave({})' }
		} else {
			lastEvent.output = { result: 'different output' }
		}
		const report = score(mismatchedTranscript)
		expect(report.ok).toBe(false)
		expect(errorsFor(report, authorBrief)).toContain(
			'execute:author-reusable-scheduled-brief has inconsistent input or output payloads',
		)
	}

	const readOnlyTranscript = freshTranscript()
	requireCompletedResult(readOnlyTranscript, authorBrief).events.splice(
		-1,
		0,
		...Array.from({ length: 3 }, (_, index) =>
			executeEvent(
				`author-inspect-${index}`,
				'inspect-authoring-guidance' as const,
				'await kody.codingGuideGet({})',
				{ guide: 'captured' },
			),
		),
	)
	expect(errorsFor(score(readOnlyTranscript), authorBrief)).toContain(
		'read-only actions may appear at most 3 times, received 4',
	)

	const authoringTranscript = freshTranscript()
	const authoringLimitResult = requireCompletedResult(
		authoringTranscript,
		authorBrief,
	)
	authoringLimitResult.events = [
		authoringLimitResult.events[0]!,
		...Array.from({ length: 9 }, (_, index) =>
			executeEvent(
				`author-mutation-${index}`,
				'author-package' as const,
				'await kody.packageSave({})',
				{ saved: true },
			),
		),
	]
	expect(errorsFor(score(authoringTranscript), authorBrief)).toContain(
		'author-package action may appear at most 8 times, received 9',
	)
})

test('scorer accepts git-lane, two-publish, and tool-only authoring variants', () => {
	const author = (
		callId: string,
		code: string,
		output: Record<string, unknown>,
	) => executeEvent(callId, 'author-package' as const, code, output)
	const gitLaneTranscript = freshTranscript()
	requireCompletedResult(gitLaneTranscript, authorBrief).events = [
		{
			callId: 'author-search-query',
			action: 'search',
			toolName: 'search',
			status: 'succeeded',
			input: { query: 'status brief automation' },
			output: { results: [] },
			match: { kind: 'no-exact-reusable' },
		},
		{
			callId: 'author-search-guide',
			action: 'search',
			toolName: 'search',
			status: 'succeeded',
			input: { entity: 'package-authoring-guide' },
			output: { result: 'guide capability' },
			match: { kind: 'no-exact-reusable' },
		},
		executeEvent(
			'author-inspect',
			'inspect-authoring-guidance' as const,
			'await kody.codingGuideGet({})',
			{ guide: 'captured' },
		),
		author('author-initialize', 'await kody.packageGetGitRemote({})', {
			remote: 'captured',
		}),
		author('author-edit', 'await kody.repoEditFiles({})', { edited: true }),
		author('author-publish', 'await kody.packagePublishExternalPush({})', {
			published: true,
		}),
	]
	expect(score(gitLaneTranscript)).toMatchObject({
		ok: true,
		totals: passingTotals,
	})

	const twoPublishTranscript = freshTranscript()
	const twoPublishResult = requireCompletedResult(
		twoPublishTranscript,
		authorBrief,
	)
	twoPublishResult.events = [
		twoPublishResult.events[0]!,
		author(
			'author-publish-disabled',
			'await kody.packageSave({ enabled: false })',
			{ published: true, enabled: false },
		),
		author(
			'author-test-disabled',
			"await kody.repoEditFiles({ session_id: 's', edits: [{ kind: 'write', path: 'a.ts', content: 'test' }] })",
			{ passed: true },
		),
		author(
			'author-publish-enabled',
			'await kody.packageSave({ enabled: true })',
			{ published: true, enabled: true },
		),
	]
	expect(score(twoPublishTranscript)).toMatchObject({
		ok: true,
		totals: passingTotals,
	})

	const toolOnlyTranscript = freshTranscript()
	const toolOnlyResult = requireCompletedResult(
		toolOnlyTranscript,
		'author-validated-cleanup-automation',
	)
	toolOnlyResult.events = [
		toolOnlyResult.events[0]!,
		author('tool-only-open', 'await kody.repoOpenSession({})', {
			sessionId: 'repo-session',
		}),
		author('tool-only-write', 'await kody.repoEditFiles({})', {
			written: true,
		}),
		author('tool-only-commit', 'await kody.repoEditFiles({})', {
			committed: true,
		}),
		author('tool-only-check', 'await kody.repoRunChecks({})', { passed: true }),
		author('tool-only-publish', 'await kody.repoPublishSession({})', {
			published: true,
		}),
	]
	expect(score(toolOnlyTranscript)).toMatchObject({
		ok: true,
		totals: passingTotals,
	})
})

test('scorer rejects removed scheduling primitives and requires workflows.create for a deferred reminder', () => {
	const deferredRun =
		'schedule-single-reminder must use workflows.create for the deferred run'
	for (const [code, removedPrimitive] of [
		[
			"await kody.job_schedule_once({ runAt: '2026-07-15T16:00:00.000Z' })",
			true,
		],
		['return await kody.valueList({})', false],
	] as const) {
		const transcript = freshTranscript()
		const executeEvent = requireCompletedResult(
			transcript,
			'schedule-single-reminder',
		).events.find((event) => event.action === 'execute-one-off')
		if (!executeEvent) throw new Error('Expected an execute-one-off fixture.')
		executeEvent.input = { code }
		const report = score(transcript)
		expect(report.ok).toBe(false)
		expect(errorsFor(report, 'schedule-single-reminder')).toEqual(
			expect.arrayContaining(
				removedPrimitive
					? [
							`${executeEvent.callId} uses a removed scheduling primitive`,
							deferredRun,
						]
					: [deferredRun],
			),
		)
	}
})
