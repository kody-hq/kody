import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { platformFeedbackTestSchemaSql } from './test-schema.ts'
import {
	getPlatformFeedbackByIdForAdmin,
	updatePlatformFeedbackStatusForAdmin,
} from './repo.ts'
import { platformFeedbackSubmissionRateLimit } from './limits.ts'
import {
	buildPlatformFeedbackSubmissionQuota,
	getPlatformFeedbackForAdmin,
	getPlatformFeedbackForSubmitter,
	getPlatformFeedbackSubmissionQuota,
	listPlatformFeedbackForAdmin,
	listPlatformFeedbackForSubmitter,
	submitPlatformFeedback,
	updatePlatformFeedbackForAdmin,
} from './service.ts'

type Db = D1Database
type SubmitInput = Parameters<typeof submitPlatformFeedback>[0]

function createPlatformFeedbackDb() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(platformFeedbackTestSchemaSql)
	const queries: Array<string> = []
	return {
		sqlite,
		db: createD1FromSqlite(sqlite, { queries }),
		queries,
	}
}

function submit(
	db: Db,
	userId: string,
	input: Partial<Pick<SubmitInput, 'category' | 'summary' | 'details'>> = {},
) {
	return submitPlatformFeedback({
		db,
		submitterUserId: userId,
		submitterUsername: `${userId}-name`,
		submitterEmail: `${userId}@example.com`,
		category: input.category ?? 'friction',
		summary: input.summary ?? 'Feedback',
		details: input.details ?? 'Feedback details',
	})
}

function review(
	db: Db,
	feedbackId: string,
	reviewerUserId: string,
	action: 'triage' | 'resolve' | 'dismiss',
	adminNote?: string,
	outcome?: {
		resolutionNote?: string
		resolutionPrUrls?: Array<string>
	},
) {
	return updatePlatformFeedbackForAdmin({
		db,
		feedbackId,
		reviewerUserId,
		action,
		...(adminNote === undefined ? {} : { adminNote }),
		...(outcome?.resolutionNote === undefined
			? {}
			: { resolutionNote: outcome.resolutionNote }),
		...(outcome?.resolutionPrUrls === undefined
			? {}
			: { resolutionPrUrls: outcome.resolutionPrUrls }),
	})
}

const rateLimitMessage = (retryAfterSeconds: number) =>
	`Platform feedback is limited to ${platformFeedbackSubmissionRateLimit} submissions per rolling 24 hours. Retry after ${retryAfterSeconds} seconds. For urgent issues, email support@kody.codes.`

test('platform feedback workflow submits, lists, reads, transitions, and preserves submitter attribution', async () => {
	const { sqlite, db, queries } = createPlatformFeedbackDb()
	const first = await submit(db, 'user-a', {
		summary: '  Setup is confusing  ',
		details: '  The setup flow does not explain the next action.  ',
	})
	const second = await submit(db, 'user-b', {
		category: 'bug',
		summary: 'Button does not save',
		details: 'The save button leaves the form unchanged.',
	})
	const third = await submit(db, 'user-a', { category: 'experience' })
	expect(first).toMatchObject({
		submitterUserId: 'user-a',
		submitterUsername: 'user-a-name',
		submitterEmail: 'user-a@example.com',
		category: 'friction',
		summary: 'Setup is confusing',
		details: 'The setup flow does not explain the next action.',
		status: 'open',
	})
	expect(second.submitterUserId).toBe('user-b')
	expect(third.submitterUserId).toBe('user-a')

	const page = await listPlatformFeedbackForAdmin({ db, page: 1, pageSize: 2 })
	expect(page).toMatchObject({ total: 3, page: 1, pageSize: 2 })
	expect(page.items.map((item) => Object.keys(item).sort())).toEqual(
		Array(2).fill([
			'category',
			'createdAt',
			'id',
			'reviewedAt',
			'reviewedByUserId',
			'status',
			'submitterUserId',
			'summary',
			'updatedAt',
		]),
	)
	queries.length = 0
	const clampedPage = await listPlatformFeedbackForAdmin({
		db,
		page: 99,
		pageSize: 2,
	})
	expect(clampedPage).toMatchObject({ total: 3, page: 2, pageSize: 2 })
	expect(clampedPage.items).toHaveLength(1)
	expect(
		queries.filter((query) => query.startsWith('SELECT COUNT(*) AS total')),
	).toHaveLength(1)
	expect(
		queries.filter((query) =>
			query.startsWith('SELECT id, submitter_user_id, category, summary'),
		),
	).toHaveLength(2)
	const bugFeedback = await listPlatformFeedbackForAdmin({
		db,
		status: 'open',
		category: 'bug',
	})
	expect(bugFeedback).toMatchObject({ page: 1, pageSize: 20, total: 1 })
	expect(bugFeedback.items).toEqual([
		expect.objectContaining({ id: second.id, submitterUserId: 'user-b' }),
	])

	expect(
		await getPlatformFeedbackForAdmin({ db, feedbackId: first.id }),
	).toMatchObject({
		submitterUsername: 'user-a-name',
		submitterEmail: 'user-a@example.com',
	})
	expect(
		await getPlatformFeedbackForAdmin({ db, feedbackId: second.id }),
	).toMatchObject({
		id: second.id,
		submitterUsername: 'user-b-name',
		submitterEmail: 'user-b@example.com',
		details: 'The save button leaves the form unchanged.',
		adminNote: null,
	})

	expect(
		await review(db, first.id, 'admin-a', 'triage', 'Needs setup-flow review.'),
	).toMatchObject({
		previousStatus: 'open',
		didChangeStatus: true,
		feedback: {
			status: 'triaged',
			reviewedByUserId: 'admin-a',
			adminNote: 'Needs setup-flow review.',
		},
	})
	const correctedTriage = await review(
		db,
		first.id,
		'admin-b',
		'triage',
		'Corrected setup-flow note.',
	)
	expect(correctedTriage).toMatchObject({
		previousStatus: 'triaged',
		didChangeStatus: false,
		feedback: {
			status: 'triaged',
			reviewedByUserId: 'admin-b',
			adminNote: 'Corrected setup-flow note.',
		},
	})
	expect(
		await review(
			db,
			first.id,
			'admin-c',
			'triage',
			'Corrected setup-flow note.',
		),
	).toEqual(correctedTriage)
	expect(await review(db, first.id, 'admin-c', 'triage', '   ')).toMatchObject({
		didChangeStatus: false,
		feedback: {
			status: 'triaged',
			reviewedByUserId: 'admin-c',
			adminNote: null,
		},
	})
	const preservedNote = 'Preserve this note when resolving.'
	const restoredTriage = await review(
		db,
		first.id,
		'admin-d',
		'triage',
		preservedNote,
	)
	expect(restoredTriage.feedback.adminNote).toBe(preservedNote)

	const resolved = await review(db, first.id, 'admin-e', 'resolve')
	expect(resolved).toMatchObject({
		previousStatus: 'triaged',
		didChangeStatus: true,
		feedback: {
			status: 'resolved',
			reviewedByUserId: 'admin-e',
			adminNote: preservedNote,
		},
	})
	const resolvedAgain = await review(db, first.id, 'admin-c', 'resolve')
	expect(resolvedAgain.feedback).toEqual(resolved.feedback)
	expect(resolvedAgain).toMatchObject({
		previousStatus: 'resolved',
		didChangeStatus: false,
	})
	await expect(review(db, first.id, 'admin-c', 'dismiss')).rejects.toThrow(
		`Cannot dismiss platform feedback "${first.id}" from status "resolved".`,
	)
	await expect(
		review(db, 'missing-feedback', 'admin-a', 'triage'),
	).rejects.toThrow('Platform feedback "missing-feedback" was not found.')

	const rows = sqlite
		.prepare(
			`SELECT id, submitter_user_id, submitter_username, submitter_email
			 FROM platform_feedback
			 ORDER BY submitter_user_id, id`,
		)
		.all() as Array<{ id: string; submitter_user_id: string }>
	expect(rows.filter((row) => row.submitter_user_id === 'user-a')).toHaveLength(
		2,
	)
	expect(rows.find((row) => row.id === first.id)).toMatchObject({
		submitter_username: 'user-a-name',
		submitter_email: 'user-a@example.com',
	})
	expect(rows.filter((row) => row.submitter_user_id === 'user-b')).toEqual([
		{
			id: second.id,
			submitter_user_id: 'user-b',
			submitter_username: 'user-b-name',
			submitter_email: 'user-b@example.com',
		},
	])
})

test('platform feedback admin note updates reject the same stale revision', async () => {
	const { db } = createPlatformFeedbackDb()
	const submitted = await submit(db, 'user-a')
	const stale = await getPlatformFeedbackByIdForAdmin(db, submitted.id)
	if (!stale) throw new Error('Expected submitted platform feedback.')
	expect(stale.revision).toBe(0)

	const updateNote = (reviewedByUserId: string, adminNote: string) =>
		updatePlatformFeedbackStatusForAdmin(db, {
			feedbackId: stale.id,
			expectedStatus: stale.status,
			expectedRevision: stale.revision,
			status: stale.status,
			reviewedByUserId,
			reviewedAt: '2026-07-19T01:00:00.000Z',
			adminNote,
			resolutionNote: undefined,
			resolutionPrUrlsJson: undefined,
		})
	expect(await updateNote('admin-a', 'First competing note.')).toBe(true)
	expect(await updateNote('admin-b', 'Second competing note.')).toBe(false)
	expect(await getPlatformFeedbackByIdForAdmin(db, submitted.id)).toMatchObject(
		{
			status: 'open',
			reviewedByUserId: 'admin-a',
			adminNote: 'First competing note.',
			revision: 1,
		},
	)
	expect(
		await getPlatformFeedbackForAdmin({ db, feedbackId: submitted.id }),
	).not.toHaveProperty('revision')
})

test('platform feedback submission enforces the rolling rate limit and atomic active queue cap', async () => {
	const rateLimited = createPlatformFeedbackDb()
	for (let index = 0; index < platformFeedbackSubmissionRateLimit; index += 1) {
		await submit(rateLimited.db, 'rate-limited-user')
	}
	await expect(submit(rateLimited.db, 'rate-limited-user')).rejects.toThrow(
		rateLimitMessage(86400),
	)
	expect(
		rateLimited.sqlite
			.prepare(`SELECT COUNT(*) AS total FROM platform_feedback`)
			.get(),
	).toEqual({ total: platformFeedbackSubmissionRateLimit })

	vi.useFakeTimers()
	try {
		const now = new Date('2026-07-19T12:00:00.000Z')
		vi.setSystemTime(now)
		const { sqlite, db } = createPlatformFeedbackDb()
		const createdAt = new Date(
			now.getTime() - 23 * 60 * 60 * 1_000,
		).toISOString()
		const insertFeedback = sqlite.prepare(
			`INSERT INTO platform_feedback (
				id, submitter_user_id, submitter_username, submitter_email,
				category, summary, details, created_at, updated_at
			) VALUES (?, 'rate-limited-user', 'rate-limited-user',
				'rate-limited-user@example.com', 'friction', 'Feedback', 'Details', ?, ?)`,
		)
		for (
			let index = 0;
			index < platformFeedbackSubmissionRateLimit;
			index += 1
		) {
			insertFeedback.run(`feedback-${index}`, createdAt, createdAt)
		}
		await expect(submit(db, 'rate-limited-user')).rejects.toThrow(
			rateLimitMessage(3600),
		)
	} finally {
		vi.useRealTimers()
	}

	const queueLimited = createPlatformFeedbackDb()
	const insertQueued = queueLimited.sqlite.prepare(
		`INSERT INTO platform_feedback (
			id, submitter_user_id, submitter_username, submitter_email,
			category, summary, details, status, created_at, updated_at
		) VALUES (?, 'queue-limited-user', 'queue-limited-user',
			'queue-limited-user@example.com', 'friction', 'Queued', 'Details', ?, ?, ?)`,
	)
	const createdAt = new Date(Date.now() - 48 * 60 * 60 * 1_000).toISOString()
	for (let index = 0; index < 99; index += 1) {
		insertQueued.run(
			`queued-${index}`,
			index % 2 === 0 ? 'open' : 'triaged',
			createdAt,
			createdAt,
		)
	}
	await submit(queueLimited.db, 'queue-limited-user', { category: 'bug' })
	await expect(
		submit(queueLimited.db, 'queue-limited-user', { category: 'bug' }),
	).rejects.toThrow(
		'You already have 100 open or triaged platform feedback submissions. Wait for an admin to review them before submitting more. For urgent issues, email support@kody.codes.',
	)
	queueLimited.sqlite
		.prepare(
			`UPDATE platform_feedback SET status = 'resolved', updated_at = ? WHERE id = 'queued-0'`,
		)
		.run(createdAt)
	await submit(queueLimited.db, 'queue-limited-user', { category: 'bug' })
	expect(
		queueLimited.sqlite
			.prepare(
				`SELECT COUNT(*) AS total
				FROM platform_feedback
				WHERE submitter_user_id = 'queue-limited-user'
					AND status IN ('open', 'triaged')`,
			)
			.get(),
	).toEqual({ total: 100 })
})

test('platform feedback accepts the cancellation category', async () => {
	const { db, sqlite } = createPlatformFeedbackDb()
	const submitted = await submit(db, 'user-c', { category: 'cancellation' })
	expect(submitted.category).toBe('cancellation')
	expect(
		sqlite
			.prepare(`SELECT category FROM platform_feedback WHERE id = ?`)
			.get(submitted.id),
	).toEqual({ category: 'cancellation' })
})

test('submitter get and list are owner-scoped and omit reviewer fields', async () => {
	const { db } = createPlatformFeedbackDb()
	const owned = await submit(db, 'user-a', {
		summary: 'Owned feedback',
		details: 'Owned details for status checks.',
	})
	const other = await submit(db, 'user-b', {
		summary: 'Other user feedback',
		details: 'Should not be readable by user-a.',
	})
	await review(db, owned.id, 'admin-a', 'resolve', 'Internal note')
	await review(db, other.id, 'admin-a', 'triage', 'Other note')

	const got = await getPlatformFeedbackForSubmitter({
		db,
		feedbackId: owned.id,
		submitterUserId: 'user-a',
	})
	expect(got).toEqual({
		id: owned.id,
		category: 'friction',
		summary: 'Owned feedback',
		details: 'Owned details for status checks.',
		status: 'resolved',
		resolutionNote: null,
		resolutionPrUrls: [],
		createdAt: owned.createdAt,
		updatedAt: expect.any(String),
	})
	expect(got).not.toHaveProperty('reviewedByUserId')
	expect(got).not.toHaveProperty('reviewedAt')
	expect(got).not.toHaveProperty('adminNote')
	expect(got).not.toHaveProperty('submitterUserId')

	expect(
		await getPlatformFeedbackForSubmitter({
			db,
			feedbackId: other.id,
			submitterUserId: 'user-a',
		}),
	).toBeNull()
	expect(
		await getPlatformFeedbackForSubmitter({
			db,
			feedbackId: 'missing-feedback',
			submitterUserId: 'user-a',
		}),
	).toBeNull()

	const listed = await listPlatformFeedbackForSubmitter({
		db,
		submitterUserId: 'user-a',
	})
	expect(listed).toMatchObject({
		total: 1,
		page: 1,
		pageSize: 20,
		submissionQuota: {
			limit: platformFeedbackSubmissionRateLimit,
			remaining: platformFeedbackSubmissionRateLimit - 1,
			nextSlotAt: null,
		},
	})
	expect(listed.items).toEqual([
		{
			id: owned.id,
			category: 'friction',
			summary: 'Owned feedback',
			status: 'resolved',
			resolutionNote: null,
			resolutionPrUrls: [],
			createdAt: owned.createdAt,
			updatedAt: expect.any(String),
		},
	])
	expect(listed.items[0]).not.toHaveProperty('details')
	expect(listed.items[0]).not.toHaveProperty('adminNote')
	expect(listed.items[0]).not.toHaveProperty('reviewedByUserId')
	expect(listed.items.map((item) => item.id)).not.toContain(other.id)

	const openOnly = await listPlatformFeedbackForSubmitter({
		db,
		submitterUserId: 'user-a',
		status: 'open',
	})
	expect(openOnly).toMatchObject({ total: 0, page: 1, items: [] })

	const resolvedOnly = await listPlatformFeedbackForSubmitter({
		db,
		submitterUserId: 'user-a',
		status: 'resolved',
	})
	expect(resolvedOnly.total).toBe(1)
	expect(resolvedOnly.items[0]?.id).toBe(owned.id)
})

test('platform feedback submission quota: fresh, partial, at cap, and window rollover', async () => {
	vi.useFakeTimers()
	try {
		const now = new Date('2026-07-19T12:00:00.000Z')
		vi.setSystemTime(now)
		const nowIso = now.toISOString()
		const { sqlite, db } = createPlatformFeedbackDb()

		expect(
			await getPlatformFeedbackSubmissionQuota({
				db,
				submitterUserId: 'quota-user',
				now: nowIso,
			}),
		).toEqual({
			limit: platformFeedbackSubmissionRateLimit,
			remaining: platformFeedbackSubmissionRateLimit,
			nextSlotAt: null,
		})
		expect(
			buildPlatformFeedbackSubmissionQuota(
				{ rollingCount: 0, oldestCreatedAt: null },
				nowIso,
			),
		).toEqual({
			limit: platformFeedbackSubmissionRateLimit,
			remaining: platformFeedbackSubmissionRateLimit,
			nextSlotAt: null,
		})

		const insertFeedback = sqlite.prepare(
			`INSERT INTO platform_feedback (
				id, submitter_user_id, submitter_username, submitter_email,
				category, summary, details, created_at, updated_at
			) VALUES (?, 'quota-user', 'quota-user', 'quota-user@example.com',
				'friction', 'Feedback', 'Details', ?, ?)`,
		)
		const oldestInWindow = new Date(
			now.getTime() - 6 * 60 * 60 * 1_000,
		).toISOString()
		for (let index = 0; index < 3; index += 1) {
			const createdAt =
				index === 0
					? oldestInWindow
					: new Date(now.getTime() - index * 60 * 1_000).toISOString()
			insertFeedback.run(`partial-${index}`, createdAt, createdAt)
		}
		expect(
			await getPlatformFeedbackSubmissionQuota({
				db,
				submitterUserId: 'quota-user',
				now: nowIso,
			}),
		).toEqual({
			limit: platformFeedbackSubmissionRateLimit,
			remaining: platformFeedbackSubmissionRateLimit - 3,
			nextSlotAt: null,
		})
		const partialList = await listPlatformFeedbackForSubmitter({
			db,
			submitterUserId: 'quota-user',
			now: nowIso,
		})
		expect(partialList.submissionQuota).toEqual({
			limit: platformFeedbackSubmissionRateLimit,
			remaining: platformFeedbackSubmissionRateLimit - 3,
			nextSlotAt: null,
		})

		for (
			let index = 3;
			index < platformFeedbackSubmissionRateLimit;
			index += 1
		) {
			const createdAt = new Date(
				now.getTime() - index * 60 * 1_000,
			).toISOString()
			insertFeedback.run(`capped-${index}`, createdAt, createdAt)
		}
		const nextSlotAt = new Date(
			new Date(oldestInWindow).getTime() + 24 * 60 * 60 * 1_000,
		).toISOString()
		expect(
			await getPlatformFeedbackSubmissionQuota({
				db,
				submitterUserId: 'quota-user',
				now: nowIso,
			}),
		).toEqual({
			limit: platformFeedbackSubmissionRateLimit,
			remaining: 0,
			nextSlotAt,
		})
		expect(
			buildPlatformFeedbackSubmissionQuota(
				{
					rollingCount: platformFeedbackSubmissionRateLimit,
					oldestCreatedAt: oldestInWindow,
				},
				nowIso,
			),
		).toEqual({
			limit: platformFeedbackSubmissionRateLimit,
			remaining: 0,
			nextSlotAt,
		})
		const cappedList = await listPlatformFeedbackForSubmitter({
			db,
			submitterUserId: 'quota-user',
			now: nowIso,
		})
		expect(cappedList.submissionQuota).toEqual({
			limit: platformFeedbackSubmissionRateLimit,
			remaining: 0,
			nextSlotAt,
		})

		const afterOldestAgesOut = new Date(
			new Date(oldestInWindow).getTime() + 24 * 60 * 60 * 1_000 + 1,
		)
		vi.setSystemTime(afterOldestAgesOut)
		const rolled = await getPlatformFeedbackSubmissionQuota({
			db,
			submitterUserId: 'quota-user',
			now: afterOldestAgesOut.toISOString(),
		})
		expect(rolled).toEqual({
			limit: platformFeedbackSubmissionRateLimit,
			remaining: 1,
			nextSlotAt: null,
		})
		const rolledList = await listPlatformFeedbackForSubmitter({
			db,
			submitterUserId: 'quota-user',
			now: afterOldestAgesOut.toISOString(),
		})
		expect(rolledList.submissionQuota).toEqual({
			limit: platformFeedbackSubmissionRateLimit,
			remaining: 1,
			nextSlotAt: null,
		})
	} finally {
		vi.useRealTimers()
	}
})

test('resolve stores submitter-visible resolution note and PR URLs separate from admin_note', async () => {
	const { db } = createPlatformFeedbackDb()
	const submitted = await submit(db, 'user-a', {
		summary: 'Broken save button',
		details: 'Clicking save does nothing.',
	})
	const resolved = await review(
		db,
		submitted.id,
		'admin-a',
		'resolve',
		'Internal triage: assign to setup team.',
		{
			resolutionNote: 'We fixed the save path and shipped it.',
			resolutionPrUrls: [
				'https://github.com/example/repo/pull/1',
				'https://github.com/example/repo/pull/2',
			],
		},
	)
	expect(resolved).toMatchObject({
		didChangeStatus: true,
		feedback: {
			status: 'resolved',
			adminNote: 'Internal triage: assign to setup team.',
			resolutionNote: 'We fixed the save path and shipped it.',
			resolutionPrUrls: [
				'https://github.com/example/repo/pull/1',
				'https://github.com/example/repo/pull/2',
			],
		},
	})

	const forSubmitter = await getPlatformFeedbackForSubmitter({
		db,
		feedbackId: submitted.id,
		submitterUserId: 'user-a',
	})
	expect(forSubmitter).toEqual({
		id: submitted.id,
		category: 'friction',
		summary: 'Broken save button',
		details: 'Clicking save does nothing.',
		status: 'resolved',
		resolutionNote: 'We fixed the save path and shipped it.',
		resolutionPrUrls: [
			'https://github.com/example/repo/pull/1',
			'https://github.com/example/repo/pull/2',
		],
		createdAt: submitted.createdAt,
		updatedAt: expect.any(String),
	})
	expect(JSON.stringify(forSubmitter)).not.toContain(
		'Internal triage: assign to setup team.',
	)
	expect(forSubmitter).not.toHaveProperty('adminNote')

	const listed = await listPlatformFeedbackForSubmitter({
		db,
		submitterUserId: 'user-a',
		status: 'resolved',
	})
	expect(listed.items[0]).toMatchObject({
		id: submitted.id,
		resolutionNote: 'We fixed the save path and shipped it.',
		resolutionPrUrls: [
			'https://github.com/example/repo/pull/1',
			'https://github.com/example/repo/pull/2',
		],
	})
	expect(JSON.stringify(listed.items)).not.toContain(
		'Internal triage: assign to setup team.',
	)
})

test('dismiss stores resolution_note for the submitter without leaking admin_note', async () => {
	const { db } = createPlatformFeedbackDb()
	const submitted = await submit(db, 'user-a', {
		summary: 'Want a purple theme',
		details: 'Please add purple.',
	})
	const dismissed = await review(
		db,
		submitted.id,
		'admin-a',
		'dismiss',
		'Out of brand guidelines; do not mention this.',
		{
			resolutionNote:
				'We are not planning a purple theme, but thanks for asking.',
		},
	)
	expect(dismissed.feedback).toMatchObject({
		status: 'dismissed',
		adminNote: 'Out of brand guidelines; do not mention this.',
		resolutionNote:
			'We are not planning a purple theme, but thanks for asking.',
		resolutionPrUrls: [],
	})
	const forSubmitter = await getPlatformFeedbackForSubmitter({
		db,
		feedbackId: submitted.id,
		submitterUserId: 'user-a',
	})
	expect(forSubmitter).toMatchObject({
		status: 'dismissed',
		resolutionNote:
			'We are not planning a purple theme, but thanks for asking.',
		resolutionPrUrls: [],
	})
	expect(JSON.stringify(forSubmitter)).not.toContain('Out of brand guidelines')
	expect(forSubmitter).not.toHaveProperty('adminNote')
})

test('another user cannot read someone else resolution fields', async () => {
	const { db } = createPlatformFeedbackDb()
	const owned = await submit(db, 'user-a')
	await review(db, owned.id, 'admin-a', 'resolve', 'secret admin note', {
		resolutionNote: 'Shipped a clearer setup flow.',
		resolutionPrUrls: ['https://github.com/example/repo/pull/9'],
	})
	expect(
		await getPlatformFeedbackForSubmitter({
			db,
			feedbackId: owned.id,
			submitterUserId: 'user-b',
		}),
	).toBeNull()
	const listed = await listPlatformFeedbackForSubmitter({
		db,
		submitterUserId: 'user-b',
	})
	expect(listed.total).toBe(0)
	expect(listed.items).toEqual([])
})

test('triage and terminal no-ops ignore invalid resolution fields without validating them', async () => {
	const { db } = createPlatformFeedbackDb()
	const submitted = await submit(db, 'user-a')
	const triaged = await updatePlatformFeedbackForAdmin({
		db,
		feedbackId: submitted.id,
		reviewerUserId: 'admin-a',
		action: 'triage',
		adminNote: 'Keep triage moving.',
		resolutionNote: 'x'.repeat(2_001),
		resolutionPrUrls: ['http://example.com/not-https'],
	})
	expect(triaged).toMatchObject({
		didChangeStatus: true,
		feedback: {
			status: 'triaged',
			adminNote: 'Keep triage moving.',
			resolutionNote: null,
			resolutionPrUrls: [],
		},
	})
	const resolved = await review(
		db,
		submitted.id,
		'admin-a',
		'resolve',
		undefined,
		{
			resolutionNote: 'Shipped.',
			resolutionPrUrls: ['https://example.com/pull/1'],
		},
	)
	expect(resolved.feedback.resolutionNote).toBe('Shipped.')
	const noop = await updatePlatformFeedbackForAdmin({
		db,
		feedbackId: submitted.id,
		reviewerUserId: 'admin-b',
		action: 'resolve',
		resolutionNote: 'x'.repeat(2_001),
		resolutionPrUrls: ['ftp://example.com/nope'],
	})
	expect(noop).toMatchObject({
		didChangeStatus: false,
		feedback: {
			status: 'resolved',
			resolutionNote: 'Shipped.',
			resolutionPrUrls: ['https://example.com/pull/1'],
		},
	})
})

test('resolution PR URL validation rejects non-https, oversize lists, and overlong entries', async () => {
	const { db } = createPlatformFeedbackDb()
	const submitted = await submit(db, 'user-a')
	await expect(
		review(db, submitted.id, 'admin-a', 'resolve', undefined, {
			resolutionPrUrls: ['http://example.com/pull/1'],
		}),
	).rejects.toThrow(/https only/)
	await expect(
		review(db, submitted.id, 'admin-a', 'resolve', undefined, {
			resolutionPrUrls: ['not a url'],
		}),
	).rejects.toThrow(/not a valid URL/)
	await expect(
		review(db, submitted.id, 'admin-a', 'resolve', undefined, {
			resolutionPrUrls: Array.from(
				{ length: 6 },
				(_, index) => `https://example.com/pull/${index}`,
			),
		}),
	).rejects.toThrow(/at most 5/)
	await expect(
		review(db, submitted.id, 'admin-a', 'resolve', undefined, {
			resolutionPrUrls: [`https://example.com/${'a'.repeat(2_100)}`],
		}),
	).rejects.toThrow(/at most 2048/)
	expect(
		await getPlatformFeedbackForAdmin({ db, feedbackId: submitted.id }),
	).toMatchObject({
		status: 'open',
		resolutionNote: null,
		resolutionPrUrls: [],
	})
})
