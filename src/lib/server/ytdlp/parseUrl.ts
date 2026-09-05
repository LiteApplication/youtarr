/**
 * Recognise a pasted YouTube URL and route straight to the matching page
 * instead of running a text search. No network call - pure string parsing.
 */
export type YtTarget =
	| { kind: 'video'; videoId: string }
	| { kind: 'playlist'; playlistId: string }
	| { kind: 'channel'; ref: string };

const VIDEO_ID = /^[A-Za-z0-9_-]{6,20}$/;
const YOUTUBE_HOSTS = new Set(['youtube.com', 'm.youtube.com', 'music.youtube.com']);

export function parseYtUrl(input: string): YtTarget | null {
	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		return null;
	}
	const host = url.hostname.toLowerCase().replace(/^www\./, '');

	if (host === 'youtu.be') {
		const videoId = url.pathname.slice(1).split('/')[0];
		return videoId && VIDEO_ID.test(videoId) ? { kind: 'video', videoId } : null;
	}
	if (!YOUTUBE_HOSTS.has(host)) return null;

	const v = url.searchParams.get('v');
	if (v && VIDEO_ID.test(v)) return { kind: 'video', videoId: v };

	const list = url.searchParams.get('list');
	if (url.pathname === '/playlist' && list) return { kind: 'playlist', playlistId: list };

	if (url.pathname.startsWith('/shorts/') || url.pathname.startsWith('/live/')) {
		const videoId = url.pathname.split('/')[2];
		return videoId && VIDEO_ID.test(videoId) ? { kind: 'video', videoId } : null;
	}

	const segments = url.pathname.split('/').filter(Boolean);
	if (segments.length === 0) return null;
	if (segments[0].startsWith('@')) return { kind: 'channel', ref: segments[0] };
	if (['channel', 'c', 'user'].includes(segments[0]) && segments[1]) {
		return { kind: 'channel', ref: `${segments[0]}/${segments[1]}` };
	}
	return null;
}
