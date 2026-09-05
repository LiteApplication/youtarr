import type { DB } from '../db/index.ts';
import { getDb } from '../db/index.ts';

export interface Subscription {
	channelRef: string;
	channelId: string;
	name: string;
	thumbnail: string | null;
	createdBy: string;
	createdAt: number;
	lastCheckedAt: number | null;
}

interface SubscriptionRow {
	channel_ref: string;
	channel_id: string;
	name: string;
	thumbnail: string | null;
	created_by: string;
	created_at: number;
	last_checked_at: number | null;
}

function rowToSubscription(row: SubscriptionRow): Subscription {
	return {
		channelRef: row.channel_ref,
		channelId: row.channel_id,
		name: row.name,
		thumbnail: row.thumbnail,
		createdBy: row.created_by,
		createdAt: row.created_at,
		lastCheckedAt: row.last_checked_at
	};
}

/**
 * Create (or refresh) a channel subscription and seed its seen-set with the
 * video ids given, atomically. Seeding means the next check only enqueues
 * uploads that appear *after* the subscription was created - the existing
 * back catalog is left to the manual "download channel" flow. Re-subscribing
 * updates the name/thumbnail and tops up the seen-set without re-downloading
 * anything.
 */
export function subscribe(
	input: {
		channelRef: string;
		channelId: string;
		name: string;
		thumbnail: string | null;
		createdBy: string;
	},
	seedVideoIds: string[],
	db: DB = getDb()
): Subscription {
	const now = Date.now();
	const upsertSub = db.prepare(
		`INSERT INTO channel_subscriptions (channel_ref, channel_id, name, thumbnail, created_by, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT (channel_ref, created_by) DO UPDATE SET name = excluded.name, thumbnail = excluded.thumbnail`
	);
	const upsertSeen = db.prepare(
		`INSERT INTO channel_seen (channel_ref, created_by, video_id, seen_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT (channel_ref, created_by, video_id) DO NOTHING`
	);
	db.transaction(() => {
		upsertSub.run(
			input.channelRef,
			input.channelId,
			input.name,
			input.thumbnail,
			input.createdBy,
			now
		);
		for (const videoId of seedVideoIds)
			upsertSeen.run(input.channelRef, input.createdBy, videoId, now);
	})();
	return getSubscription(input.channelRef, input.createdBy, db) as Subscription;
}

export function unsubscribe(channelRef: string, createdBy: string, db: DB = getDb()): boolean {
	// channel_seen rows cascade via the foreign key.
	return (
		db
			.prepare('DELETE FROM channel_subscriptions WHERE channel_ref = ? AND created_by = ?')
			.run(channelRef, createdBy).changes > 0
	);
}

export function getSubscription(
	channelRef: string,
	createdBy: string,
	db: DB = getDb()
): Subscription | null {
	const row = db
		.prepare('SELECT * FROM channel_subscriptions WHERE channel_ref = ? AND created_by = ?')
		.get(channelRef, createdBy) as SubscriptionRow | undefined;
	return row ? rowToSubscription(row) : null;
}

export function isSubscribed(channelRef: string, createdBy: string, db: DB = getDb()): boolean {
	return (
		db
			.prepare('SELECT 1 FROM channel_subscriptions WHERE channel_ref = ? AND created_by = ?')
			.get(channelRef, createdBy) !== undefined
	);
}

/** One user's channel subscriptions. */
export function listSubscriptions(createdBy: string, db: DB = getDb()): Subscription[] {
	const rows = db
		.prepare(
			'SELECT * FROM channel_subscriptions WHERE created_by = ? ORDER BY name COLLATE NOCASE'
		)
		.all(createdBy) as SubscriptionRow[];
	return rows.map(rowToSubscription);
}

/**
 * Subscriptions (across all users) whose last check is older than `intervalMs`
 * (or never checked). Background checks run for everyone; each row carries the
 * owning user in `createdBy` for per-owner attribution.
 */
export function dueSubscriptions(
	intervalMs: number,
	db: DB = getDb(),
	now: number = Date.now()
): Subscription[] {
	const rows = db
		.prepare(
			`SELECT * FROM channel_subscriptions
			 WHERE last_checked_at IS NULL OR last_checked_at <= ?
			 ORDER BY name COLLATE NOCASE`
		)
		.all(now - intervalMs) as SubscriptionRow[];
	return rows.map(rowToSubscription);
}

/** Which of the given video ids the subscription has already accounted for. */
export function seenVideoIds(channelRef: string, createdBy: string, db: DB = getDb()): Set<string> {
	const rows = db
		.prepare('SELECT video_id FROM channel_seen WHERE channel_ref = ? AND created_by = ?')
		.all(channelRef, createdBy) as { video_id: string }[];
	return new Set(rows.map((r) => r.video_id));
}

export function markVideoSeen(
	channelRef: string,
	createdBy: string,
	videoId: string,
	db: DB = getDb(),
	now: number = Date.now()
): void {
	db.prepare(
		`INSERT INTO channel_seen (channel_ref, created_by, video_id, seen_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT (channel_ref, created_by, video_id) DO NOTHING`
	).run(channelRef, createdBy, videoId, now);
}

export function markChecked(
	channelRef: string,
	createdBy: string,
	db: DB = getDb(),
	now: number = Date.now()
): void {
	db.prepare(
		'UPDATE channel_subscriptions SET last_checked_at = ? WHERE channel_ref = ? AND created_by = ?'
	).run(now, channelRef, createdBy);
}
