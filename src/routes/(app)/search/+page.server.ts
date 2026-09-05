import { findCompletedDownload } from '$lib/server/queue/store';
import { searchVideos } from '$lib/server/ytdlp/metadata';
import { parseYtUrl } from '$lib/server/ytdlp/parseUrl';
import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/**
 * When the query is a YouTube URL, jump straight to the matching page instead
 * of running a text search.
 */
function urlTarget(query: string): string | null {
	const target = parseYtUrl(query);
	if (!target) return null;

	switch (target.kind) {
		case 'channel':
			return `/channel/${encodeURIComponent(target.ref)}`;
		case 'playlist':
			return `/playlist/${encodeURIComponent(target.playlistId)}`;
		case 'video':
			return `/video/${encodeURIComponent(target.videoId)}`;
	}
}

export const load: PageServerLoad = async ({ url }) => {
	const query = url.searchParams.get('q')?.trim() ?? '';
	if (!query) return { query: '', results: [] };

	const target = urlTarget(query);
	if (target) redirect(303, target);
	try {
		const videos = await searchVideos(query);
		const results = videos.map((video) => ({
			...video,
			isDownloaded: findCompletedDownload(video.videoId) !== null
		}));
		return { query, results };
	} catch (cause) {
		error(502, `Search failed: ${(cause as Error).message}`);
	}
};
