import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JobMeta } from '../queue/store.ts';
import { renderTemplate, resolveLibraryPath, sanitizeSegment } from './naming.ts';
import { episodeNfo, tvshowNfo } from './nfo.ts';
import { assertMounted, createSentinel, MountMissingError, publishFile } from './publish.ts';

describe('sanitizeSegment', () => {
	it('replaces reserved characters', () => {
		expect(sanitizeSegment('AC/DC: Back <in> Black?')).toBe('AC_DC_ Back _in_ Black_');
	});

	it('neutralises traversal and hidden-file prefixes', () => {
		expect(sanitizeSegment('..')).not.toMatch(/^\./);
		expect(sanitizeSegment('.hidden')).not.toMatch(/^\./);
	});

	it('escapes Windows reserved device names', () => {
		expect(sanitizeSegment('CON')).toBe('_CON');
		expect(sanitizeSegment('com1')).toBe('_com1');
	});

	it('strips trailing dots and spaces', () => {
		expect(sanitizeSegment('Album...')).toBe('Album');
		expect(sanitizeSegment('Album   ')).toBe('Album');
	});

	it('caps byte length for long unicode names', () => {
		const long = '🎵'.repeat(200);
		expect(Buffer.byteLength(sanitizeSegment(long), 'utf8')).toBeLessThanOrEqual(200);
	});

	it('never returns an empty segment', () => {
		expect(sanitizeSegment('')).toBe('_');
		expect(sanitizeSegment('...')).not.toBe('');
	});
});

describe('renderTemplate', () => {
	const meta: JobMeta = {
		title: 'Episode One',
		channel: 'My Channel',
		uploadDate: '20230115'
	};

	it('renders the default template', () => {
		expect(
			renderTemplate(
				'{channel}/Season {season}/{channel} - S{season}E{episode:03} - {title}',
				meta,
				1
			)
		).toBe('My Channel/Season 2023/My Channel - S2023E001 - Episode One');
	});

	it('falls back to season "00" when the upload date is missing', () => {
		const noDate = { ...meta, uploadDate: undefined };
		expect(
			renderTemplate(
				'{channel}/Season {season}/{channel} - S{season}E{episode:03} - {title}',
				noDate,
				1
			)
		).toBe('My Channel/Season 00/My Channel - S00E001 - Episode One');
	});

	it('sanitises hostile metadata inside the template', () => {
		const hostile = { ...meta, channel: '../..', title: 'x/../../etc' };
		const rendered = renderTemplate('{channel}/{title}', hostile, 1);
		expect(rendered).not.toContain('..');
	});
});

describe('resolveLibraryPath', () => {
	it('accepts paths inside the root', () => {
		expect(resolveLibraryPath('/media', 'A/Season 2023/A - S2023E001', 'mp4')).toBe(
			'/media/A/Season 2023/A - S2023E001.mp4'
		);
	});

	it('rejects escapes even if sanitisation were bypassed', () => {
		expect(() => resolveLibraryPath('/media', '../evil', 'mp4')).toThrow(/escapes library root/);
		expect(() => resolveLibraryPath('/media', 'A/../../evil', 'mp4')).toThrow(
			/escapes library root/
		);
	});
});

describe('nfo generation', () => {
	it('escapes XML-hostile channel names', () => {
		const xml = tvshowNfo({
			title: 'Mezzanine <Deluxe> & "Remastered"',
			channelId: 'UC123',
			plot: 'A "great" <channel>'
		});
		expect(xml).toContain('Mezzanine &lt;Deluxe&gt; &amp; &quot;Remastered&quot;');
		expect(xml).toContain('A &quot;great&quot; &lt;channel&gt;');
		expect(xml).not.toMatch(/<Deluxe>/);
	});

	it('emits a youtube uniqueid when a channel id is present', () => {
		const withId = tvshowNfo({ title: 'T', channelId: 'UC123' });
		expect(withId).toContain('<uniqueid type="youtube" default="true">UC123</uniqueid>');

		const withoutId = tvshowNfo({ title: 'T' });
		expect(withoutId).not.toContain('<uniqueid');
	});

	it('renders episode nfo with season, episode, and converted aired date', () => {
		const xml = episodeNfo({
			title: 'Episode One',
			showTitle: 'My Channel',
			season: '2023',
			episode: 1,
			aired: '20230115',
			videoId: 'abc123',
			plot: 'A video'
		});
		expect(xml).toContain('<title>Episode One</title>');
		expect(xml).toContain('<showtitle>My Channel</showtitle>');
		expect(xml).toContain('<season>2023</season>');
		expect(xml).toContain('<episode>1</episode>');
		expect(xml).toContain('<aired>2023-01-15</aired>');
		expect(xml).toContain('<uniqueid type="youtube" default="true">abc123</uniqueid>');
	});

	it('episode nfo defaults an invalid season to 1 and omits aired when unparseable', () => {
		const xml = episodeNfo({
			title: 'T',
			showTitle: 'S',
			season: '00',
			episode: 1,
			videoId: 'v1'
		});
		expect(xml).toContain('<season>1</season>');
		expect(xml).not.toContain('<aired>');
	});
});

describe('publish', () => {
	let dir: string;
	let library: string;
	let staging: string;
	let scratch: string;

	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), 'youtarr-publish-'));
		library = path.join(dir, 'media');
		staging = path.join(library, '.staging');
		scratch = path.join(dir, 'scratch');
		mkdirSync(library, { recursive: true });
		mkdirSync(scratch, { recursive: true });
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it('refuses to write without the mount sentinel', () => {
		writeFileSync(path.join(scratch, 'a.mp4'), 'video');
		expect(() =>
			publishFile({
				sourcePath: path.join(scratch, 'a.mp4'),
				targetPath: path.join(library, 'A/Season 2023/01.mp4'),
				jobId: 'j1',
				libraryRoot: library,
				staging
			})
		).toThrow(MountMissingError);
		expect(existsSync(path.join(library, 'A'))).toBe(false);
	});

	it('publishes atomically once the sentinel exists and cleans staging', () => {
		createSentinel(library);
		writeFileSync(path.join(scratch, 'a.mp4'), 'video-bytes');
		const target = path.join(library, 'A/Season 2023/01.mp4');
		publishFile({
			sourcePath: path.join(scratch, 'a.mp4'),
			targetPath: target,
			jobId: 'j1',
			libraryRoot: library,
			staging
		});
		expect(existsSync(target)).toBe(true);
		expect(existsSync(path.join(staging, 'j1'))).toBe(false);
		expect(() => assertMounted(library)).not.toThrow();
	});
});
