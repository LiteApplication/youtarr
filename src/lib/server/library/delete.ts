import { existsSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { mediaDir } from '../env.ts';
import { safeLibraryPath } from './browse.ts';
import { pruneEmptyDirs } from './edit.ts';
import { assertMounted } from './publish.ts';

const VIDEO_RE = /\.(mp4|mkv|webm|m4v|avi)$/i;

export interface DeleteResult {
	/** What the deleted entry represented, inferred from its depth. */
	kind: 'channel' | 'season' | 'episode';
	/** library-relative path that was removed */
	removed: string;
}

/**
 * Delete a channel directory, season directory, or single episode from the
 * library. Directories are removed recursively; pruneEmptyDirs clears any
 * now-empty tree left above a deleted episode.
 *
 * Sentinel- and path-guarded like every other library write.
 */
export function deleteLibraryEntry(
	relative: string,
	options: { root?: string } = {}
): DeleteResult {
	const root = options.root ?? mediaDir();
	assertMounted(root);
	const absolute = safeLibraryPath(relative, root);
	if (path.resolve(absolute) === path.resolve(root)) {
		throw new Error('refusing to delete the library root');
	}
	if (!existsSync(absolute)) throw new Error('not found in library');

	const stats = statSync(absolute);
	const parent = path.dirname(absolute);

	if (stats.isDirectory()) {
		// Top-level directory is a channel; anything nested is a season.
		const isTopLevel = path.resolve(parent) === path.resolve(root);
		rmSync(absolute, { recursive: true, force: true });
		pruneEmptyDirs(parent, root);
		return { kind: isTopLevel ? 'channel' : 'season', removed: relative };
	}

	if (!VIDEO_RE.test(absolute)) {
		throw new Error('refusing to delete a non-video file');
	}
	rmSync(absolute, { force: true });
	const nfo = absolute.replace(/\.[^./\\]+$/, '.nfo');
	if (existsSync(nfo)) rmSync(nfo, { force: true });
	pruneEmptyDirs(parent, root);
	return { kind: 'episode', removed: relative };
}
