import path from 'node:path';
import type { JobMeta } from '../queue/store.ts';

const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

/** Make a single path segment safe on Linux and on SMB-mounted Windows clients. */
export function sanitizeSegment(input: string): string {
	let segment = input
		.normalize('NFC')
		// eslint-disable-next-line no-control-regex
		.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
		.replace(/^\.+/, '_') // no dot-prefixed segments: hidden files / '..' traversal
		.replace(/[. ]+$/, '') // Windows rejects trailing dots and spaces
		.trim();
	if (segment === '' || WINDOWS_RESERVED.test(segment)) {
		segment = `_${segment}`;
	}
	// Cap byte length so segment + extension stays under common FS limits.
	while (Buffer.byteLength(segment, 'utf8') > 200) {
		segment = segment.slice(0, -1);
	}
	return segment;
}

/** Upload year (YYYY) from a YYYYMMDD upload date, or '00' when unknown. */
export function seasonFor(meta: Pick<JobMeta, 'uploadDate'>): string {
	if (meta.uploadDate && /^\d{8}$/.test(meta.uploadDate)) return meta.uploadDate.slice(0, 4);
	return '00';
}

/**
 * Render the naming template into a library-relative file path (no extension).
 * Placeholders: {channel} {season} {episode:03} {title} {year}
 */
export function renderTemplate(
	template: string,
	meta: JobMeta,
	episode: number,
	season: string = seasonFor(meta)
): string {
	const fields: Record<string, string> = {
		channel: meta.channel || 'Unknown channel',
		title: meta.title || 'Untitled',
		season,
		year: season !== '00' ? season : ''
	};
	const rendered = template.replace(
		/\{(\w+)(?::(\d+))?\}/g,
		(_match, name: string, pad?: string) => {
			if (name === 'episode') {
				return pad ? String(episode).padStart(Number(pad), '0') : String(episode);
			}
			return fields[name] ?? '';
		}
	);
	return rendered
		.split('/')
		.map((segment) => sanitizeSegment(segment))
		.filter((segment) => segment !== '')
		.join('/');
}

/**
 * Resolve the final absolute path and assert it stays inside the library root.
 * A channel named "../.." must never become a write outside the media root.
 */
export function resolveLibraryPath(libraryRoot: string, relative: string, ext: string): string {
	const absolute = path.resolve(libraryRoot, `${relative}.${ext}`);
	const root = path.resolve(libraryRoot) + path.sep;
	if (!absolute.startsWith(root)) {
		throw new Error(`path escapes library root: ${JSON.stringify(relative)}`);
	}
	return absolute;
}
