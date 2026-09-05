import type { DB } from '../db/index.ts';
import { getDb } from '../db/index.ts';
import { publish } from '../events.ts';
import {
	resolveChannel,
	resolvePlaylist,
	resolveVideo,
	type VideoResult
} from '../ytdlp/metadata.ts';
import type { Batch, JobMeta, NewTrack } from './store.ts';
import { createBatch, findCompletedDownload } from './store.ts';

export type EnqueueRequest =
	| { kind: 'video'; videoId: string }
	| { kind: 'playlist'; playlistId: string; syncJellyfin?: boolean }
	| { kind: 'channel'; ref: string; limit?: number };

/**
 * Map resolved videos to jobs, flagging any already in the library so they are
 * skipped rather than re-downloaded (`NewTrack.existingPath`). Shared by
 * playlist, channel, and subscription expansion.
 */
export function buildVideoJobs(videos: VideoResult[], db: DB = getDb()): NewTrack[] {
	return videos
		.filter((v) => v.videoId)
		.map((v) => ({
			videoId: v.videoId,
			existingPath: findCompletedDownload(v.videoId, db) ?? undefined,
			meta: {
				title: v.title,
				channel: v.channel.name,
				channelId: v.channel.id,
				thumbnail: v.thumbnails.at(-1)?.url,
				uploadDate: v.uploadDate,
				duration: v.duration
			} satisfies JobMeta
		}));
}

/**
 * Expand a user request into one batch of per-video jobs.
 */
export async function enqueue(
	request: EnqueueRequest,
	userId: string,
	db: DB = getDb()
): Promise<Batch[]> {
	const batches: Batch[] = [];

	switch (request.kind) {
		case 'video': {
			const video = await resolveVideo(request.videoId);
			const track: NewTrack = {
				videoId: video.videoId,
				meta: {
					title: video.title,
					channel: video.channel.name,
					channelId: video.channel.id,
					thumbnail: video.thumbnails.at(-1)?.url,
					uploadDate: video.uploadDate,
					duration: video.duration
				}
			};
			const { batch } = createBatch(
				{
					kind: 'video',
					sourceId: video.videoId,
					title: video.title,
					channel: video.channel.name,
					thumbnail: track.meta.thumbnail,
					createdBy: userId
				},
				[track],
				db
			);
			batches.push(batch);
			break;
		}

		case 'playlist': {
			const playlist = await resolvePlaylist(request.playlistId);
			const tracks = buildVideoJobs(playlist.videos, db);
			const { batch } = createBatch(
				{
					kind: 'playlist',
					sourceId: request.playlistId,
					title: playlist.title,
					channel: playlist.channel?.name,
					thumbnail: playlist.thumbnails.at(-1)?.url,
					createdBy: userId,
					syncJellyfin: request.syncJellyfin !== false
				},
				tracks,
				db
			);
			batches.push(batch);
			break;
		}

		case 'channel': {
			const channel = await resolveChannel(request.ref, { limit: request.limit });
			const tracks = buildVideoJobs(channel.videos, db);
			const { batch } = createBatch(
				{
					kind: 'channel',
					sourceId: channel.ref,
					title: channel.name,
					channel: channel.name,
					thumbnail: channel.thumbnails.at(-1)?.url,
					createdBy: userId
				},
				tracks,
				db
			);
			batches.push(batch);
			break;
		}
	}

	publish({ type: 'queue', payload: { enqueued: batches.map((b) => b.id) } });
	return batches;
}
