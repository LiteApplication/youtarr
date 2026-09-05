import { getPlaylistSubscription } from '$lib/server/playlists/store';
import { findCompletedDownload } from '$lib/server/queue/store';
import { resolvePlaylist } from '$lib/server/ytdlp/metadata';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals }) => {
	try {
		const sub = getPlaylistSubscription(params.id, locals.session!.userId);
		const playlist = await resolvePlaylist(params.id);
		const videosWithStatus = playlist.videos.map((video) => ({
			...video,
			isDownloaded: video.videoId ? findCompletedDownload(video.videoId) !== null : false
		}));
		const isDownloaded =
			videosWithStatus.length > 0 && videosWithStatus.every((v) => !v.videoId || v.isDownloaded);
		return {
			playlist: {
				...playlist,
				videos: videosWithStatus
			},
			synced: sub !== null && sub.enabled,
			isDownloaded
		};
	} catch (cause) {
		error(502, `Could not load playlist: ${(cause as Error).message}`);
	}
};
