import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mediaDir } from '../env.ts';
import type { JobMeta } from '../queue/store.ts';
import { getSettings } from '../settings.ts';
import { safeLibraryPath } from './browse.ts';
import { renderTemplate, resolveLibraryPath } from './naming.ts';
import { episodeNfo, tvshowNfo } from './nfo.ts';
import { assertMounted } from './publish.ts';

export interface EditableVideoTags {
	title: string;
	channel: string;
	channelId?: string;
	season: string;
	episode: number;
	aired?: string; // YYYYMMDD
}

/**
 * Retag a library video in place: move it to where the naming template now
 * says it belongs and rewrite its episode NFO (and the show's tvshow.nfo, if
 * the channel name changed). Used by both the manual metadata editor and the
 * upload flow.
 */
export async function applyVideoTags(
	relative: string,
	tags: EditableVideoTags,
	options: { root?: string } = {}
): Promise<{ newPath: string }> {
	const root = options.root ?? mediaDir();
	assertMounted(root);
	const absolute = safeLibraryPath(relative, root);
	if (!existsSync(absolute)) throw new Error('file not found in library');

	const meta: JobMeta = {
		title: tags.title,
		channel: tags.channel,
		channelId: tags.channelId,
		uploadDate: tags.aired
	};
	const template = getSettings().namingTemplate;
	const ext = path.extname(absolute).slice(1);
	const targetPath = resolveLibraryPath(
		root,
		renderTemplate(template, meta, tags.episode, tags.season),
		ext
	);

	const oldNfo = absolute.replace(/\.[^./\\]+$/, '.nfo');
	if (targetPath !== absolute) {
		mkdirSync(path.dirname(targetPath), { recursive: true });
		renameSync(absolute, targetPath);
		if (existsSync(oldNfo)) rmSafe(oldNfo);
		pruneEmptyDirs(path.dirname(absolute), root);
	}

	const showDir = findShowDir(targetPath, root);
	writeFileSync(
		targetPath.replace(/\.[^./\\]+$/, '.nfo'),
		episodeNfo({
			title: tags.title,
			showTitle: tags.channel,
			season: tags.season,
			episode: tags.episode,
			aired: tags.aired,
			videoId: path.basename(relative)
		}),
		'utf8'
	);
	if (showDir) {
		writeFileSync(
			path.join(showDir, 'tvshow.nfo'),
			tvshowNfo({ title: tags.channel, channelId: tags.channelId }),
			'utf8'
		);
	}

	return { newPath: path.relative(root, targetPath) };
}

/** The channel-root directory a published episode lives under, or null at the library root. */
function findShowDir(episodePath: string, root: string): string | null {
	const seasonDir = path.dirname(episodePath);
	const showDir = path.dirname(seasonDir);
	return path.resolve(showDir) === path.resolve(root) ? null : showDir;
}

function rmSafe(file: string): void {
	try {
		renameSync(file, path.join(tmpdir(), `youtarr-discard-${Date.now()}-${path.basename(file)}`));
	} catch {
		/* best effort */
	}
}

/** Remove now-empty directories up to (but never including) the library root. */
export function pruneEmptyDirs(from: string, root: string): void {
	let current = path.resolve(from);
	const stop = path.resolve(root);
	while (current !== stop && current.startsWith(stop)) {
		let entries: string[];
		try {
			entries = readdirSync(current);
		} catch {
			break;
		}
		if (entries.length > 0) break;
		try {
			rmdirSync(current);
		} catch {
			break;
		}
		current = path.dirname(current);
	}
}

const UPLOAD_EXTENSIONS = new Set(['mp4', 'mkv', 'webm', 'm4v', 'avi']);

/**
 * Ingest an uploaded video: park it in the library under its metadata-derived
 * path via the same retag+move machinery the editor uses.
 */
export async function ingestUpload(
	fileName: string,
	data: Buffer,
	tags: EditableVideoTags,
	options: { root?: string } = {}
): Promise<{ newPath: string }> {
	const root = options.root ?? mediaDir();
	assertMounted(root);
	const ext = path.extname(fileName).slice(1).toLowerCase();
	if (!UPLOAD_EXTENSIONS.has(ext)) {
		throw new Error(`unsupported video format .${ext} - use mp4, mkv, webm, m4v, or avi`);
	}
	// Land it in a dotted (scanner-invisible) intake dir on the library volume,
	// so the applyVideoTags move stays intra-filesystem and atomic.
	const intake = path.join(root, '.youtarr-intake');
	mkdirSync(intake, { recursive: true });
	const parked = path.join(intake, `upload-${Date.now()}.${ext}`);
	writeFileSync(parked, data);
	try {
		return await applyVideoTags(path.relative(root, parked), tags, options);
	} finally {
		if (existsSync(parked)) rmSafe(parked);
	}
}
