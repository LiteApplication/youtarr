import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface Thumbnail {
	url: string;
	width?: number;
	height?: number;
}

export interface VideoResult {
	kind: 'video';
	videoId: string;
	title: string;
	channel: { id?: string; name: string };
	duration?: string;
	thumbnails: Thumbnail[];
	uploadDate?: string; // YYYYMMDD
}

export interface VideoDetail extends VideoResult {
	description?: string;
}

export interface PlaylistDetail {
	playlistId: string;
	title: string;
	channel?: { id?: string; name: string };
	thumbnails: Thumbnail[];
	videoCount: number;
	videos: VideoResult[];
}

export interface ChannelDetail {
	channelId: string;
	ref: string;
	name: string;
	thumbnails: Thumbnail[];
	videos: VideoResult[];
}

export class MetadataError extends Error {}

const VIDEO_ID = /^[A-Za-z0-9_-]{6,20}$/;
const PLAYLIST_ID = /^[A-Za-z0-9_-]{2,64}$/;
const CHANNEL_REF =
	/^(@[\w.-]{1,100}|channel\/UC[\w-]{10,40}|c\/[\w.-]{1,100}|user\/[\w.-]{1,100})$/;

export function assertVideoId(id: string): void {
	if (!VIDEO_ID.test(id)) throw new MetadataError(`invalid video id: ${JSON.stringify(id)}`);
}

export function assertPlaylistId(id: string): void {
	if (!PLAYLIST_ID.test(id)) throw new MetadataError(`invalid playlist id: ${JSON.stringify(id)}`);
}

export function assertChannelRef(ref: string): void {
	if (!CHANNEL_REF.test(ref)) {
		throw new MetadataError(`invalid channel reference: ${JSON.stringify(ref)}`);
	}
}

function ytdlpBin(): string {
	return process.env.YTDLP_BIN ?? 'yt-dlp';
}

interface RawEntry {
	id?: string;
	title?: string;
	channel?: string;
	uploader?: string;
	channel_id?: string;
	uploader_id?: string;
	duration?: number;
	duration_string?: string;
	upload_date?: string;
	thumbnail?: string;
	thumbnails?: { url?: string; width?: number; height?: number }[];
	entries?: RawEntry[];
	description?: string;
}

/**
 * Run yt-dlp against a single URL/search query and parse its `-J` JSON dump.
 * Metadata-only: no network access besides what yt-dlp itself performs.
 */
async function ytdlpJson(args: string[], deps: { run?: typeof runRaw } = {}): Promise<RawEntry> {
	const run = deps.run ?? runRaw;
	const stdout = await run(['--no-warnings', '-J', ...args]);
	try {
		return JSON.parse(stdout) as RawEntry;
	} catch (cause) {
		throw new MetadataError(`yt-dlp returned invalid JSON: ${(cause as Error).message}`);
	}
}

async function runRaw(args: string[]): Promise<string> {
	try {
		const { stdout } = await execFileAsync(ytdlpBin(), args, {
			maxBuffer: 64 * 1024 * 1024,
			timeout: 45_000
		});
		return stdout;
	} catch (cause) {
		const err = cause as NodeJS.ErrnoException & { stderr?: string };
		if (err.code === 'ENOENT') throw new MetadataError(`yt-dlp binary not found`);
		throw new MetadataError(
			`yt-dlp lookup failed: ${(err.stderr ?? err.message ?? 'unknown error').toString().slice(-500)}`
		);
	}
}

function normalizeThumbnails(raw: RawEntry): Thumbnail[] {
	const list: Thumbnail[] = Array.isArray(raw.thumbnails)
		? raw.thumbnails
				.filter((t): t is { url: string; width?: number; height?: number } => Boolean(t?.url))
				.map((t) => ({ url: t.url, width: t.width, height: t.height }))
		: [];
	if (list.length === 0 && typeof raw.thumbnail === 'string') {
		list.push({ url: raw.thumbnail });
	}
	// Ascending by width, so `.at(-1)` picks the largest - mirrors YouTube's own ordering.
	return list.sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
}

function formatDuration(raw: RawEntry): string | undefined {
	if (typeof raw.duration_string === 'string' && raw.duration_string) return raw.duration_string;
	if (typeof raw.duration !== 'number' || !Number.isFinite(raw.duration)) return undefined;
	const total = Math.max(0, Math.round(raw.duration));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	return h > 0
		? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
		: `${m}:${String(s).padStart(2, '0')}`;
}

function rowToVideo(e: RawEntry): VideoResult {
	return {
		kind: 'video',
		videoId: e.id ?? '',
		title: e.title ?? '(untitled)',
		channel: {
			id: e.channel_id ?? e.uploader_id ?? undefined,
			name: e.channel ?? e.uploader ?? 'Unknown channel'
		},
		duration: formatDuration(e),
		thumbnails: normalizeThumbnails(e),
		uploadDate: typeof e.upload_date === 'string' ? e.upload_date : undefined
	};
}

export interface MetadataDeps {
	run?: typeof runRaw;
}

/** Video search via yt-dlp's built-in `ytsearchN:` pseudo-extractor. Flat: fast, one request. */
export async function searchVideos(
	query: string,
	limit = 24,
	deps: MetadataDeps = {}
): Promise<VideoResult[]> {
	const safeQuery = query.replace(/[\r\n]/g, ' ').trim();
	if (!safeQuery) return [];
	const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 50);
	const data = await ytdlpJson(['--flat-playlist', `ytsearch${safeLimit}:${safeQuery}`], deps);
	const entries = data.entries ?? [];
	return entries.filter((e) => e?.id).map(rowToVideo);
}

export async function resolveVideo(videoId: string, deps: MetadataDeps = {}): Promise<VideoDetail> {
	assertVideoId(videoId);
	const data = await ytdlpJson([`https://www.youtube.com/watch?v=${videoId}`], deps);
	return {
		...rowToVideo(data),
		description: typeof data.description === 'string' ? data.description : undefined
	};
}

export async function resolvePlaylist(
	playlistId: string,
	deps: MetadataDeps = {}
): Promise<PlaylistDetail> {
	assertPlaylistId(playlistId);
	const data = await ytdlpJson(
		['--flat-playlist', `https://www.youtube.com/playlist?list=${playlistId}`],
		deps
	);
	const entries = (data.entries ?? []).filter((e) => e?.id);
	return {
		playlistId: data.id ?? playlistId,
		title: data.title ?? 'Playlist',
		channel:
			data.channel || data.uploader
				? { id: data.channel_id ?? undefined, name: data.channel ?? data.uploader ?? '' }
				: undefined,
		thumbnails: normalizeThumbnails(data),
		videoCount: entries.length,
		videos: entries.map(rowToVideo)
	};
}

/** Recent uploads for a channel (by ref, e.g. "@handle" or "channel/UC…"), newest first. */
export async function resolveChannel(
	ref: string,
	options: { limit?: number } = {},
	deps: MetadataDeps = {}
): Promise<ChannelDetail> {
	assertChannelRef(ref);
	const limit = Math.min(Math.max(1, options.limit ?? 100), 500);
	const url = `https://www.youtube.com/${ref}/videos`;
	const data = await ytdlpJson(['--flat-playlist', '--playlist-end', String(limit), url], deps);
	const entries = (data.entries ?? []).filter((e) => e?.id);
	return {
		channelId: data.channel_id ?? data.uploader_id ?? ref,
		ref,
		name: data.channel ?? data.uploader ?? data.title ?? ref,
		thumbnails: normalizeThumbnails(data),
		videos: entries.map(rowToVideo)
	};
}
