/**
 * Picks a general work category for a session. The task description is read
 * once here, sent to Workers AI, and never stored or logged. Only a category
 * id leaves this module.
 */
export const sessionCategoryModel = '@cf/cloudflare/clairic-flash'
export const sessionCategoryJudgeModel = '@cf/cloudflare/clef-flash'
export const maxCategoryNameAttempts = 3
const judgeRejectAbove = 0.35
const maxActiveCategories = 60
const newCategoryChoice = 'none of these'

export const seedSessionCategories = [
	'connect service',
	'build package',
	'debug error',
	'schedule job',
	'manage secrets',
	'query data',
	'send message',
	'manage account',
] as const

/** Runs one Workers AI model. Injected so the labeler never names a vendor. */
export type SessionAiRunner = (model: string, body: unknown) => Promise<unknown>

export function workersAiRunner(ai: Ai): SessionAiRunner {
	// The models are not in the generated AiModels map yet; cast at the boundary.
	return (model, body) =>
		ai.run(model as Parameters<Ai['run']>[0], body as never) as Promise<unknown>
}

export type LabelStats = {
	labeled: number
	reused: number
	proposedPasses: number
	proposals: number
	rejectedPrecheck: number
	rejectedJudge: number
	accepted: number
	failedThreeAttempts: number
	modelFailed: number
}

function emptyStats(): LabelStats {
	return {
		labeled: 0,
		reused: 0,
		proposedPasses: 0,
		proposals: 0,
		rejectedPrecheck: 0,
		rejectedJudge: 0,
		accepted: 0,
		failedThreeAttempts: 0,
		modelFailed: 0,
	}
}

export type SessionCategory = { id: string; name: string }

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null
}

/** The binding returns the result directly; the gateway wraps it once. */
function readAnswers(raw: unknown): Record<string, unknown> | null {
	const result = isRecord(raw) && isRecord(raw.result) ? raw.result : raw
	return isRecord(result) && isRecord(result.answers) ? result.answers : null
}

export function normalizeCategoryName(value: string) {
	return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

const reservedCategoryNames = new Set([newCategoryChoice, 'uncategorized'])

/**
 * Cheap shape check for a proposed category name: one to four plain
 * lowercase words. Digits, punctuation, addresses, ids, and anything long
 * fail, which removes most ways user data could ride in a name.
 */
export function categoryNamePassesPrecheck(name: string) {
	if (name.length < 3 || name.length > 40) return false
	if (reservedCategoryNames.has(name)) return false
	const words = name.split(' ')
	if (words.length > 4) return false
	return words.every((word) => /^[a-z]{2,16}$/.test(word))
}

async function loadActiveCategories(db: D1Database) {
	const rows = await db
		.prepare(
			`SELECT id, name FROM session_analytics_categories
			 WHERE status = 'active' ORDER BY created_at, name LIMIT ?`,
		)
		.bind(maxActiveCategories)
		.all<SessionCategory>()
	return rows.results
}

async function ensureCategory(db: D1Database, name: string, now: Date) {
	await db
		.prepare(
			`INSERT INTO session_analytics_categories (id, name, created_at)
			 VALUES (?, ?, ?) ON CONFLICT (name) DO NOTHING`,
		)
		.bind(crypto.randomUUID(), name, now.toISOString())
		.run()
	const row = await db
		.prepare(
			`SELECT id, status, merged_into FROM session_analytics_categories WHERE name = ?`,
		)
		.bind(name)
		.first<{ id: string; status: string; merged_into: string | null }>()
	if (!row || row.status === 'retired') return null
	return row.status === 'merged' ? row.merged_into : row.id
}

async function chooseCategory(
	ai: SessionAiRunner,
	input: { task: string; names: ReadonlyArray<string>; rejected: number },
) {
	const raw = await ai(sessionCategoryModel, {
		state: input.task,
		fields: {
			category: {
				type: 'enum',
				enum: [...input.names, newCategoryChoice],
				instructions: `The general kind of work described. Choose "${newCategoryChoice}" only when no option fits.`,
			},
			new_category: {
				type: 'text',
				knowledge: true,
				nullable: true,
				maxLength: 40,
				instructions:
					input.rejected === 0
						? 'A new general category for this kind of work: two or three plain lowercase English words, a verb then a noun, such as "connect service". Never include a name of a person, company, product, project, file, or place.'
						: 'A more general category for this kind of work: two plain lowercase English words, a common verb then a common noun, such as "manage files". The previous answer was too specific. Use no names at all.',
			},
		},
	})
	const answers = readAnswers(raw)
	if (!answers) throw new Error('category model returned no answers')
	const category = isRecord(answers.category) ? answers.category.value : null
	const proposed = isRecord(answers.new_category)
		? answers.new_category.value
		: null
	return {
		category: typeof category === 'string' ? category : null,
		proposed: typeof proposed === 'string' ? proposed : null,
	}
}

/** The judge sees only the proposed name, never the task description. */
async function judgeSaysUserData(ai: SessionAiRunner, name: string) {
	const raw = await ai(sessionCategoryJudgeModel, {
		state: { name },
		questions: {
			user_data: {
				type: 'noul',
				instructions:
					'Does state.name contain the name of a person, company, product, project, file, place, or any other identifying detail, rather than only generic words for a kind of work?',
			},
		},
	})
	const answers = readAnswers(raw)
	const answer =
		answers && isRecord(answers.user_data) ? answers.user_data : null
	const noul = answer ? answer.noul : null
	if (typeof noul !== 'number') throw new Error('judge returned no answer')
	return noul > judgeRejectAbove
}

/**
 * Category id for a task description, or null for uncategorized. A proposed
 * new name must pass the shape check and then the judge; a rejected name is
 * regenerated, up to three attempts. Every failure ends as uncategorized.
 */
export async function labelSessionCategory(input: {
	db: D1Database
	ai: SessionAiRunner
	task: string
	now: Date
}): Promise<{ categoryId: string | null; stats: LabelStats }> {
	const stats = emptyStats()
	stats.labeled = 1
	try {
		const active = await loadActiveCategories(input.db)
		const known = new Map(
			active.map((category) => [category.name, category.id]),
		)
		const names = [
			...new Set([...seedSessionCategories, ...active.map((c) => c.name)]),
		]
		for (let attempt = 0; attempt < maxCategoryNameAttempts; attempt++) {
			const choice = await chooseCategory(input.ai, {
				task: input.task,
				names,
				rejected: attempt,
			})
			if (
				choice.category &&
				choice.category !== newCategoryChoice &&
				names.includes(choice.category)
			) {
				stats.reused = 1
				const categoryId =
					known.get(choice.category) ??
					(await ensureCategory(input.db, choice.category, input.now))
				return { categoryId, stats }
			}
			if (attempt === 0) stats.proposedPasses = 1
			stats.proposals += 1
			const name = normalizeCategoryName(choice.proposed ?? '')
			if (!categoryNamePassesPrecheck(name)) {
				stats.rejectedPrecheck += 1
				continue
			}
			if (known.has(name)) {
				stats.accepted = 1
				return { categoryId: known.get(name) ?? null, stats }
			}
			if (await judgeSaysUserData(input.ai, name)) {
				stats.rejectedJudge += 1
				continue
			}
			stats.accepted = 1
			return {
				categoryId: await ensureCategory(input.db, name, input.now),
				stats,
			}
		}
		stats.failedThreeAttempts = 1
		return { categoryId: null, stats }
	} catch {
		stats.modelFailed = 1
		return { categoryId: null, stats }
	}
}

export async function recordLabelStats(
	db: D1Database,
	stats: LabelStats,
	now: Date,
) {
	await db
		.prepare(
			`INSERT INTO session_analytics_label_stats (
				day, labeled, reused, proposed_passes, proposals, rejected_precheck,
				rejected_judge, accepted, failed_three_attempts, model_failed
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (day) DO UPDATE SET
				labeled = labeled + excluded.labeled,
				reused = reused + excluded.reused,
				proposed_passes = proposed_passes + excluded.proposed_passes,
				proposals = proposals + excluded.proposals,
				rejected_precheck = rejected_precheck + excluded.rejected_precheck,
				rejected_judge = rejected_judge + excluded.rejected_judge,
				accepted = accepted + excluded.accepted,
				failed_three_attempts = failed_three_attempts + excluded.failed_three_attempts,
				model_failed = model_failed + excluded.model_failed`,
		)
		.bind(
			now.toISOString().slice(0, 10),
			stats.labeled,
			stats.reused,
			stats.proposedPasses,
			stats.proposals,
			stats.rejectedPrecheck,
			stats.rejectedJudge,
			stats.accepted,
			stats.failedThreeAttempts,
			stats.modelFailed,
		)
		.run()
}
