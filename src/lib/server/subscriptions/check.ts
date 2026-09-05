import type { DB } from '../db/index.ts';
import { getDb } from '../db/index.ts';
import { publish } from '../events.ts';
import { buildVideoJobs } from '../queue/enqueue.ts';
import { createBatch } from '../queue/store.ts';
import { resolveChannel } from '../ytdlp/metadata.ts';
import {
	dueSubscriptions,
	markChecked,
	markVideoSeen,
	seenVideoIds,
	type Subscription
} from './store.ts';

export interface CheckResult {
	/** Number of new-upload batches enqueued. */
	enqueued: number;
	/** Batch ids created, for the caller to poke the worker pool. */
	batchIds: string[];
}

/**
 * The external operation a check performs, injectable so tests can run fully
 * offline (matching the repo's dependency-injection convention over module
 * mocking).
 */
export interface CheckDeps {
	getChannel: typeof resolveChannel;
}

const defaultDeps: CheckDeps = { getChannel: resolveChannel };

/**
 * Check one subscribed channel for uploads not yet in its seen-set and enqueue
 * them as a single batch. Every video considered is marked seen (even if the
 * batch enqueue fails) so a channel with a broken video doesn't get rechecked
 * forever - the failure is logged instead.
 */
export async function checkSubscription(
	sub: Subscription,
	db: DB = getDb(),
	deps: CheckDeps = defaultDeps
): Promise<CheckResult> {
	const channel = await deps.getChannel(sub.channelRef, { limit: 50 });
	const seen = seenVideoIds(sub.channelRef, sub.createdBy, db);
	const fresh = channel.videos.filter((v) => v.videoId && !seen.has(v.videoId));

	for (const video of fresh) markVideoSeen(sub.channelRef, sub.createdBy, video.videoId, db);
	markChecked(sub.channelRef, sub.createdBy, db);

	if (fresh.length === 0) return { enqueued: 0, batchIds: [] };

	try {
		const tracks = buildVideoJobs(fresh, db);
		const { batch } = createBatch(
			{
				kind: 'channel',
				sourceId: sub.channelRef,
				title: `${sub.name} - new uploads`,
				channel: sub.name,
				thumbnail: sub.thumbnail ?? undefined,
				createdBy: sub.createdBy
			},
			tracks,
			db
		);
		console.log(`subscription: enqueued ${tracks.length} video(s) from ${sub.name}`);
		return { enqueued: 1, batchIds: [batch.id] };
	} catch (cause) {
		console.error(`subscription: failed to enqueue uploads for ${sub.name}:`, (cause as Error).message);
		return { enqueued: 0, batchIds: [] };
	}
}

/**
 * Check every subscription due for a refresh (last checked longer ago than
 * `intervalMs`). Failures on one channel don't abort the rest. Returns the
 * total number of batches enqueued across all channels.
 */
export async function checkDueSubscriptions(
	intervalMs: number,
	db: DB = getDb(),
	deps: CheckDeps = defaultDeps
): Promise<CheckResult> {
	const subs = dueSubscriptions(intervalMs, db);
	const batchIds: string[] = [];
	for (const sub of subs) {
		try {
			const result = await checkSubscription(sub, db, deps);
			batchIds.push(...result.batchIds);
		} catch (cause) {
			console.error(`subscription: check failed for ${sub.name}:`, (cause as Error).message);
		}
	}
	if (batchIds.length > 0) {
		publish({ type: 'queue', payload: { enqueued: batchIds } });
	}
	return { enqueued: batchIds.length, batchIds };
}
