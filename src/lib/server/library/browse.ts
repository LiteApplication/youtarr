import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { mediaDir } from '../env.ts';

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.webm', '.m4v', '.avi']);

/**
 * Resolve a library-relative path from the client and refuse anything that
 * escapes the media root. All /api/library and editor input goes through this.
 */
export function safeLibraryPath(relative: string, root: string = mediaDir()): string {
	const absolute = path.resolve(root, relative);
	const rootPrefix = path.resolve(root) + path.sep;
	if (absolute !== path.resolve(root) && !absolute.startsWith(rootPrefix)) {
		throw new Error('path escapes the library');
	}
	return absolute;
}

export interface LibraryEntry {
	name: string;
	/** library-relative path */
	path: string;
	kind: 'directory' | 'video';
	sizeBytes?: number;
}

/** One directory level of the library, directories first. */
export function listLibrary(relative = '', root: string = mediaDir()): LibraryEntry[] {
	const absolute = safeLibraryPath(relative, root);
	let names: string[];
	try {
		names = readdirSync(absolute);
	} catch {
		return [];
	}
	const entries: LibraryEntry[] = [];
	for (const name of names) {
		if (name.startsWith('.')) continue; // staging, sentinel, hidden files
		const child = path.join(absolute, name);
		let stats;
		try {
			stats = statSync(child);
		} catch {
			continue;
		}
		if (stats.isDirectory()) {
			entries.push({ name, path: path.join(relative, name), kind: 'directory' });
		} else if (VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase())) {
			entries.push({
				name,
				path: path.join(relative, name),
				kind: 'video',
				sizeBytes: stats.size
			});
		}
	}
	return entries.sort((a, b) =>
		a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1
	);
}

export interface EpisodeInfo {
	title: string | null;
	showTitle: string | null;
	season: string | null;
	episode: number | null;
	aired: string | null;
}

function unesc(value: string): string {
	return value
		.replaceAll('&lt;', '<')
		.replaceAll('&gt;', '>')
		.replaceAll('&quot;', '"')
		.replaceAll('&apos;', "'")
		.replaceAll('&amp;', '&');
}

function pick(xml: string, name: string): string | null {
	const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
	return m ? unesc(m[1]) : null;
}

/**
 * Read a video's metadata straight from its sidecar `.nfo` (no embedded-tag
 * reader needed - Jellyfin reads the NFO, so that's the source of truth here
 * too). Returns nulls when there is no NFO yet.
 */
export function readEpisodeInfo(relative: string, root: string = mediaDir()): EpisodeInfo {
	const absolute = safeLibraryPath(relative, root);
	const nfoPath = absolute.replace(/\.[^./\\]+$/, '.nfo');
	if (!existsSync(nfoPath)) {
		return { title: null, showTitle: null, season: null, episode: null, aired: null };
	}
	const xml = readFileSync(nfoPath, 'utf8');
	const episode = pick(xml, 'episode');
	return {
		title: pick(xml, 'title'),
		showTitle: pick(xml, 'showtitle'),
		season: pick(xml, 'season'),
		episode: episode ? Number(episode) : null,
		aired: pick(xml, 'aired')
	};
}
