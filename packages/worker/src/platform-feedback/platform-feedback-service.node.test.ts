import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { platformFeedbackTestSchemaSql } from './test-schema.ts'
import {
	getPlatformFeedbackByIdForAdmin,
	updatePlatformFeedbackStatusForAdmin,
} from './repo.ts'
import {
	getPlatformFeedbackForAdmin,
	getPlatformFeedbackForSubmitter,
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
) {
	return updatePlatformFeedbackForAdmin({
		db,
		feedbackId,
		reviewerUserId,
		action,
		...(adminNote === undefined ? {} : { adminNote }),
	})
}

const rateLimitMessage = (retryAfterSeconds: number) =>
	`Platform feedback is limited to 10 submissions per rolling 24 hours. Retry after ${retryAfterSeconds} seconds. For urgent issues, email support@kody.codes.`

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
	for (let index = 0; index < 10; index += 1) {
		await submit(rateLimited.db, 'rate-limited-user')
	}
	await expect(submit(rateLimited.db, 'rate-limited-user')).rejects.toThrow(
		rateLimitMessage(86400),
	)
	expect(
		rateLimited.sqlite
			.prepare(`SELECT COUNT(*) AS total FROM platform_feedback`)
			.get(),
	).toEqual({ total: 10 })

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
		for (let index = 0; index < 10; index += 1) {
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
	expect(listed).toMatchObject({ total: 1, page: 1, pageSize: 20 })
	expect(listed.items).toEqual([
		{
			id: owned.id,
			category: 'friction',
			summary: 'Owned feedback',
			status: 'resolved',
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
