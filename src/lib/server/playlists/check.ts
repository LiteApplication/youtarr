import type { DB } from '../db/index.ts';
import { getDb } from '../db/index.ts';
import { publish } from '../events.ts';
import { buildVideoJobs } from '../queue/enqueue.ts';
import { createBatch } from '../queue/store.ts';
import { resolvePlaylist } from '../ytdlp/metadata.ts';
import {
	duePlaylistSubscriptions,
	markPlaylistChecked,
	markVideosSeen,
	seenVideoIds,
	type PlaylistSubscription
} from './store.ts';

export interface PlaylistCheckResult {
	/** Number of batches enqueued (one per playlist that gained new videos). */
	enqueued: number;
	/** Batch ids created, for the caller to poke the worker pool and reconcile drains. */
	batchIds: string[];
}

/**
 * The external operation a check performs, injectable so tests run fully offline
 * (matching the repo's dependency-injection convention over module mocking).
 */
export interface PlaylistCheckDeps {
	getPlaylist: typeof resolvePlaylist;
}

const defaultDeps: PlaylistCheckDeps = { getPlaylist: resolvePlaylist };

/**
 * Check one followed playlist for videos added since it was followed and
 * enqueue the new ones as a playlist batch (already-downloaded videos are
 * skipped inside `buildVideoJobs`, so a re-added video already in the library
 * is not fetched again). The new batch flows through the normal drain/
 * incremental sync and lands in the same Jellyfin playlist. Every new video is
 * marked seen so it isn't reconsidered next time.
 */
export async function checkPlaylistSubscription(
	sub: PlaylistSubscription,
	db: DB = getDb(),
	deps: PlaylistCheckDeps = defaultDeps
): Promise<PlaylistCheckResult> {
	const playlist = await deps.getPlaylist(sub.playlistId);
	const seen = seenVideoIds(sub.playlistId, sub.createdBy, db);
	const newVideos = playlist.videos.filter((v) => v.videoId && !seen.has(v.videoId));

	const batchIds: string[] = [];
	if (newVideos.length > 0) {
		const tracks = buildVideoJobs(newVideos, db);
		const { batch } = createBatch(
			{
				kind: 'playlist',
				sourceId: sub.playlistId,
				title: playlist.title,
				channel: playlist.channel?.name,
				thumbnail: playlist.thumbnails.at(-1)?.url,
				createdBy: sub.createdBy
			},
			tracks,
			db
		);
		markVideosSeen(sub.playlistId, sub.createdBy, newVideos.map((v) => v.videoId), db);
		batchIds.push(batch.id);
		console.log(`playlist sync: enqueued ${newVideos.length} new video(s) from "${playlist.title}"`);
	}

	markPlaylistChecked(sub.playlistId, sub.createdBy, db);
	return { enqueued: batchIds.length, batchIds };
}

/**
 * Check every enabled playlist due for a refresh. A failure on one playlist
 * doesn't abort the rest. Returns the batches enqueued across all playlists.
 */
export async function checkDuePlaylistSubscriptions(
	intervalMs: number,
	db: DB = getDb(),
	deps: PlaylistCheckDeps = defaultDeps
): Promise<PlaylistCheckResult> {
	const subs = duePlaylistSubscriptions(intervalMs, db);
	const batchIds: string[] = [];
	for (const sub of subs) {
		try {
			const result = await checkPlaylistSubscription(sub, db, deps);
			batchIds.push(...result.batchIds);
		} catch (cause) {
			console.error(`playlist sync: check failed for "${sub.title}":`, (cause as Error).message);
		}
	}
	if (batchIds.length > 0) {
		publish({ type: 'queue', payload: { enqueued: batchIds } });
	}
	return { enqueued: batchIds.length, batchIds };
}
