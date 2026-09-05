import { findCompletedDownload } from '$lib/server/queue/store';
import { isSubscribed } from '$lib/server/subscriptions/store';
import { resolveChannel } from '$lib/server/ytdlp/metadata';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals }) => {
	try {
		const channel = await resolveChannel(params.ref, { limit: 100 });
		const videos = channel.videos.map((video) => ({
			...video,
			isDownloaded: findCompletedDownload(video.videoId) !== null
		}));
		return {
			channel: { ...channel, videos },
			subscribed: isSubscribed(params.ref, locals.session!.userId)
		};
	} catch (cause) {
		error(502, `Could not load channel: ${(cause as Error).message}`);
	}
};
