import '#/mocks/webextension-polyfill';

import { expect, it, describe, vi, beforeEach, afterEach } from 'vitest';
import type Song from '@/core/object/song';
import type Pipeline from '@/core/object/pipeline/pipeline';

const mocks = vi.hoisted(() => ({
	sendContentMessage:
		vi.fn<
			(message: { type: string; payload?: unknown }) => Promise<unknown>
		>(),
	getOption: vi.fn(),
	pipelineProcess: vi.fn<Pipeline['process']>(),
	shouldScrobbleChannel: vi.fn<() => Promise<boolean>>(),
}));

vi.mock('@/util/communication', () => ({
	contentListener: (listener: unknown) => listener,
	setupContentListeners: vi.fn(),
	sendContentMessage: mocks.sendContentMessage,
}));

vi.mock('@/core/storage/options', async (importOriginal) => {
	const mod = await importOriginal<typeof import('@/core/storage/options')>();
	return {
		...mod,
		getOption: mocks.getOption,
		setConnectorEnabled: vi.fn(),
	};
});

vi.mock('@/core/storage/browser-storage', async (importOriginal) => {
	const mod =
		await importOriginal<typeof import('@/core/storage/browser-storage')>();
	return {
		...mod,
		getStorage: () => {
			const store: Record<string, unknown> = {};
			return {
				get: vi.fn(() => Promise.resolve(store)),
				set: vi.fn((data: Record<string, unknown>) => {
					Object.assign(store, data);
					return Promise.resolve();
				}),
				update: vi.fn((data: Record<string, unknown>) => {
					Object.assign(store, data);
					return Promise.resolve();
				}),
				debugLog: vi.fn().mockResolvedValue(undefined),
				clear: vi.fn(() => {
					for (const key in store) {
						delete store[key];
					}
					return Promise.resolve();
				}),
			};
		},
	};
});

vi.mock('@/core/storage/saved-edits', () => ({
	default: {
		loadSongInfo: vi.fn().mockResolvedValue(false),
		saveSongInfo: vi.fn().mockResolvedValue(undefined),
		removeSongInfo: vi.fn().mockResolvedValue(undefined),
	},
}));

vi.mock('@/core/storage/scrobble-cache', () => ({
	default: {
		pushScrobble: vi.fn().mockResolvedValue(1),
		deleteScrobbles: vi.fn().mockResolvedValue(undefined),
	},
}));

vi.mock('@/core/storage/blocklist', () => ({
	default: class Blocklist {
		addToBlocklist = vi.fn().mockResolvedValue(undefined);
		removeFromBlocklist = vi.fn().mockResolvedValue(undefined);
		shouldScrobbleChannel = mocks.shouldScrobbleChannel;
	},
}));

vi.mock('@/core/object/pipeline/pipeline', () => ({
	default: class Pipeline {
		process = mocks.pipelineProcess;
	},
}));

vi.mock('@/core/content/util', () => ({
	debugLog: vi.fn(),
	getInfoBoxText: vi.fn(() => ''),
}));

import Controller from '@/core/object/controller/controller';
import * as ControllerMode from '@/core/object/controller/controller-mode';
import * as Options from '@/core/storage/options';
import * as ContentUtil from '@/core/content/util';
import scrobbleCache from '@/core/storage/scrobble-cache';
import { ServiceCallResult } from '@/core/object/service-call-result';
import { ScrobbleStatus } from '@/core/storage/wrapper';
import type BaseConnector from '@/core/content/connector';
import type { State } from '@/core/types';

/**
 * Content script code calls Util.* as a global; main.ts assigns it at
 * runtime, tests assign the mocked module instead.
 */
vi.stubGlobal('Util', ContentUtil);
vi.stubGlobal('window', {
	setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms),
});
vi.stubGlobal('document', { querySelector: () => null });

const CONNECTOR = {
	meta: {
		label: 'Dummy label',
		js: 'Dummy js',
		matches: ['Dummy match'],
		id: 'Dummy id',
	},
} as unknown as BaseConnector;

const SONG_STATE: State = {
	artist: 'No Doubt',
	track: 'Bathwater',
	album: 'Return of Saturn',
	duration: 200,
	isPlaying: true,
};

const NEW_SONG_STATE: State = {
	artist: 'A Perfect Circle',
	track: 'Judith',
	album: 'Mer de Noms',
	duration: 400,
	isPlaying: true,
};

const PODCAST_STATE: State = {
	artist: 'Podcast Network',
	track: 'Episode 10',
	duration: 1800,
	isPodcast: true,
	isPlaying: true,
};

function defaultSendContentMessage(message: { type: string }) {
	switch (message.type) {
		case 'getTabId':
			return Promise.resolve(1);
		case 'scrobble':
			return Promise.resolve([[ServiceCallResult.RESULT_OK]]);
		default:
			return Promise.resolve([ServiceCallResult.RESULT_OK]);
	}
}

function stubOptions(overrides: Record<string, unknown>) {
	mocks.getOption.mockImplementation((name: string) => {
		if (name in overrides) {
			return Promise.resolve(overrides[name]);
		}
		if (name === Options.SCROBBLE_PODCASTS) {
			return Promise.resolve(true);
		}
		return Promise.resolve(undefined);
	});
}

/**
 * Flush the microtask chains spawned by fire-and-forget async calls.
 */
async function settle() {
	for (let i = 0; i < 10; i++) {
		await vi.advanceTimersByTimeAsync(0);
	}
}

async function createController(isEnabled = true) {
	const controller = new Controller(CONNECTOR, isEnabled);
	await settle();
	mocks.sendContentMessage.mockClear();
	return controller;
}

function sentMessages(type: string) {
	return mocks.sendContentMessage.mock.calls.filter(
		([message]) => message.type === type,
	);
}

function markValid(song: Song) {
	song.flags.finishedProcessing = true;
	song.flags.isValid = true;
	return true;
}

async function mockMetadataLookups(
	...lookups: { track: string; delay: number }[]
) {
	const { default: RealPipeline } = await vi.importActual<
		typeof import('@/core/object/pipeline/pipeline')
	>('@/core/object/pipeline/pipeline');
	const pipeline = new RealPipeline();
	mocks.pipelineProcess.mockImplementation(pipeline.process.bind(pipeline));
	mocks.sendContentMessage.mockImplementation(async (message) => {
		if (message.type !== 'getSongInfo') {
			return defaultSendContentMessage(message);
		}
		const lookup = lookups.shift();
		if (!lookup) {
			throw new Error('Unexpected metadata lookup');
		}
		if (lookup.delay) {
			await new Promise((resolve) => setTimeout(resolve, lookup.delay));
		}
		return [{ track: lookup.track }];
	});
}

describe('onStateChanged', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		stubOptions({});
		mocks.sendContentMessage.mockImplementation(defaultSendContentMessage);
		mocks.pipelineProcess.mockImplementation(async (song: Song) =>
			markValid(song),
		);
		mocks.shouldScrobbleChannel.mockResolvedValue(true);
		vi.mocked(scrobbleCache.pushScrobble).mockClear().mockResolvedValue(1);
		vi.mocked(scrobbleCache.deleteScrobbles).mockClear();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('does nothing when the controller is disabled', async () => {
		const controller = await createController(false);

		controller.onStateChanged(SONG_STATE);
		await settle();

		expect(controller.getMode()).toBe(ControllerMode.Disabled);
		expect(controller.getCurrentSong()).toBeNull();
		expect(sentMessages('setNowPlaying')).toHaveLength(0);
	});

	it('marks a new playing song as now playing', async () => {
		const controller = await createController();

		controller.onStateChanged(SONG_STATE);
		await settle();

		expect(controller.getMode()).toBe(ControllerMode.Playing);
		expect(controller.getCurrentSong()?.parsed.track).toBe('Bathwater');
		expect(sentMessages('setNowPlaying')).toHaveLength(1);
		expect(sentMessages('showNowPlaying')).toHaveLength(1);
	});

	it('resets when the connector sends an empty state', async () => {
		const controller = await createController();

		controller.onStateChanged(SONG_STATE);
		await settle();

		controller.onStateChanged({ isPlaying: false });
		await settle();

		expect(controller.getCurrentSong()).toBeNull();
		expect(controller.getMode()).toBe(ControllerMode.Base);
		expect(sentMessages('clearNowPlaying')).toHaveLength(1);
	});

	it('creates a song from a playing state that lacks an artist', async () => {
		const controller = await createController();

		controller.onStateChanged({
			track: 'Bathwater',
			duration: 200,
			isPlaying: true,
		});
		await settle();

		expect(controller.getMode()).toBe(ControllerMode.Playing);
		expect(controller.getCurrentSong()?.parsed.track).toBe('Bathwater');
		expect(controller.getCurrentSong()?.parsed.artist).toBeNull();
		expect(sentMessages('setNowPlaying')).toHaveLength(1);
	});

	it('keeps the current song when a partial update drops artist and track', async () => {
		const controller = await createController();

		controller.onStateChanged(SONG_STATE);
		await settle();

		controller.onStateChanged({
			uniqueID: 'some-id',
			duration: 200,
			isPlaying: true,
		});
		await settle();

		expect(controller.getCurrentSong()?.parsed.track).toBe('Bathwater');
		expect(controller.getMode()).toBe(ControllerMode.Playing);
		expect(sentMessages('setNowPlaying')).toHaveLength(1);
		expect(sentMessages('clearNowPlaying')).toHaveLength(0);
	});

	it('drops the previous song when the track changes', async () => {
		const controller = await createController();

		controller.onStateChanged(SONG_STATE);
		await settle();

		controller.onStateChanged(NEW_SONG_STATE);
		await settle();

		expect(sentMessages('clearNowPlaying')).toHaveLength(1);
		expect(controller.getCurrentSong()?.parsed.track).toBe('Judith');
		expect(controller.getMode()).toBe(ControllerMode.Playing);
		expect(sentMessages('showNowPlaying')).toHaveLength(2);
	});

	it('ignores a channel check that completes after a track switch', async () => {
		const controller = await createController();
		mocks.shouldScrobbleChannel.mockImplementationOnce(
			() =>
				new Promise((resolve) => setTimeout(() => resolve(false), 500)),
		);
		mocks.pipelineProcess.mockClear();

		controller.onStateChanged(SONG_STATE);
		controller.onStateChanged(NEW_SONG_STATE);
		await settle();
		expect(controller.getMode()).toBe(ControllerMode.Playing);

		await vi.advanceTimersByTimeAsync(500);
		expect(mocks.pipelineProcess).toHaveBeenCalledOnce();
		expect(mocks.pipelineProcess.mock.calls[0][0]).toBe(
			controller.getCurrentSong(),
		);
		expect(sentMessages('setNowPlaying')).toHaveLength(1);
	});

	it('ignores an earlier metadata result when returning to the same track', async () => {
		const controller = await createController();
		const state = {
			...SONG_STATE,
			uniqueID: 'first-track',
			trackArt: 'art',
		};
		await mockMetadataLookups(
			{ track: 'Old result', delay: 500 },
			{ track: 'Judith', delay: 0 },
			{ track: 'New result', delay: 1_000 },
		);

		controller.onStateChanged(state);
		await settle();
		controller.onStateChanged({
			...NEW_SONG_STATE,
			uniqueID: 'second-track',
			trackArt: 'art',
		});
		await settle();
		controller.onStateChanged(state);
		await settle();
		mocks.sendContentMessage.mockClear();

		await vi.advanceTimersByTimeAsync(500);
		expect(controller.getMode()).toBe(ControllerMode.Loading);
		expect(controller.getCurrentSong()?.flags.finishedProcessing).toBe(
			false,
		);
		expect(sentMessages('songUpdate')).toHaveLength(0);

		await vi.advanceTimersByTimeAsync(500);
		expect(controller.getMode()).toBe(ControllerMode.Playing);
		expect(controller.getCurrentSong()?.getTrack()).toBe('New result');
		expect(sentMessages('setNowPlaying')).toHaveLength(1);
	});

	it('keeps newer metadata when the same play is reprocessed', async () => {
		const controller = await createController();
		await mockMetadataLookups(
			{ track: 'Old result', delay: 1_000 },
			{ track: 'New result', delay: 0 },
		);

		controller.onStateChanged({ ...SONG_STATE, trackArt: 'art' });
		await settle();
		const song = controller.getCurrentSong();
		controller.reprocessSong();
		await settle();
		expect(song?.getTrack()).toBe('New result');

		await vi.advanceTimersByTimeAsync(1_000);
		expect(controller.getCurrentSong()).toBe(song);
		expect(song?.getTrack()).toBe('New result');
		expect(sentMessages('setNowPlaying')).toHaveLength(1);
	});

	it('keeps the new track’s listening threshold when an old timer update finishes', async () => {
		const controller = await createController();
		let firstPercentRead = true;
		mocks.getOption.mockImplementation((name: string) => {
			if (name === Options.SCROBBLE_PERCENT && firstPercentRead) {
				firstPercentRead = false;
				return new Promise((resolve) =>
					setTimeout(() => resolve(50), 500),
				);
			}
			return Promise.resolve(50);
		});

		controller.onStateChanged(SONG_STATE);
		await settle();
		controller.onStateChanged(NEW_SONG_STATE);
		await settle();
		await vi.advanceTimersByTimeAsync(101_000);
		expect(sentMessages('scrobble')).toHaveLength(0);
		expect(sentMessages('setNowPlaying')).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(99_000);
		expect(sentMessages('scrobble')).toHaveLength(1);
		expect(controller.getMode()).toBe(ControllerMode.Scrobbled);
	});

	it('pauses and resumes and scrobbles only after played time', async () => {
		const controller = await createController();

		controller.onStateChanged(SONG_STATE);
		await settle();

		// 20s of the 100s needed to scrobble elapse
		await vi.advanceTimersByTimeAsync(20_000);

		controller.onStateChanged({
			...SONG_STATE,
			isPlaying: false,
			currentTime: 20,
		});
		await settle();

		expect(controller.getMode()).toBe(ControllerMode.Paused);
		expect(sentMessages('setPaused')).toHaveLength(1);

		// paused wall time must not count towards the scrobble point
		await vi.advanceTimersByTimeAsync(60_000);
		expect(sentMessages('scrobble')).toHaveLength(0);

		controller.onStateChanged({
			...SONG_STATE,
			isPlaying: true,
			currentTime: 20,
		});
		await settle();

		expect(controller.getMode()).toBe(ControllerMode.Playing);

		// 80s of playback remain until the scrobble point (50% of 200s)
		await vi.advanceTimersByTimeAsync(80_000);
		await settle();

		expect(sentMessages('scrobble')).toHaveLength(1);
		expect(controller.getMode()).toBe(ControllerMode.Scrobbled);
	});

	it('does not pause when isPlaying is undefined', async () => {
		const controller = await createController();

		controller.onStateChanged(SONG_STATE);
		await settle();

		controller.onStateChanged({
			...SONG_STATE,
			isPlaying: undefined,
			currentTime: 30,
		});
		await settle();

		expect(controller.getMode()).toBe(ControllerMode.Playing);
		expect(sentMessages('setPaused')).toHaveLength(0);
	});

	it('disallows scrobbling when the connector reports a disallowed reason', async () => {
		const controller = await createController();

		controller.onStateChanged({
			...SONG_STATE,
			scrobblingDisallowedReason: 'IsAd',
		});
		await settle();

		expect(controller.getMode()).toBe(ControllerMode.Disallowed);
		expect(sentMessages('setNowPlaying')).toHaveLength(0);
	});

	it('resumes now playing when a disallowed reason clears mid-song', async () => {
		const controller = await createController();

		controller.onStateChanged({
			...SONG_STATE,
			scrobblingDisallowedReason: 'IsAd',
		});
		await settle();

		expect(controller.getMode()).toBe(ControllerMode.Disallowed);

		controller.onStateChanged({
			...SONG_STATE,
			scrobblingDisallowedReason: null,
		});
		await settle();

		expect(controller.getMode()).toBe(ControllerMode.Playing);
		expect(sentMessages('setNowPlaying')).toHaveLength(1);
	});

	it('caches an unrecognized song instead of scrobbling it', async () => {
		mocks.pipelineProcess.mockImplementation(async (song: Song) => {
			song.flags.finishedProcessing = true;
			return true;
		});
		const controller = await createController();

		controller.onStateChanged(SONG_STATE);
		await settle();

		expect(controller.getMode()).toBe(ControllerMode.Unknown);
		expect(sentMessages('showSongNotRecognized')).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(150_000);
		await settle();

		expect(sentMessages('scrobble')).toHaveLength(0);
		expect(scrobbleCache.pushScrobble).toHaveBeenCalledWith(
			expect.objectContaining({ status: ScrobbleStatus.INVALID }),
		);
	});

	it('skips podcasts when podcast scrobbling is off', async () => {
		stubOptions({ [Options.SCROBBLE_PODCASTS]: false });
		const controller = await createController();

		controller.onStateChanged(PODCAST_STATE);
		await settle();

		expect(controller.getMode()).toBe(ControllerMode.Skipped);
		expect(sentMessages('setNowPlaying')).toHaveLength(0);
	});

	it('reprocesses a replayed song without a now playing notification', async () => {
		const controller = await createController();

		controller.onStateChanged(SONG_STATE);
		await settle();

		// 100s scrobble point, 200s replay detection
		await vi.advanceTimersByTimeAsync(201_000);
		await settle();

		expect(controller.getMode()).toBe(ControllerMode.Scrobbled);

		mocks.sendContentMessage.mockClear();
		controller.onStateChanged({ ...SONG_STATE, currentTime: 0 });
		await settle();

		expect(sentMessages('setNowPlaying')).toHaveLength(1);
		expect(sentMessages('showNowPlaying')).toHaveLength(0);
	});

	it('ignores connector updates for a skipped song', async () => {
		const controller = await createController();

		controller.onStateChanged(SONG_STATE);
		await settle();
		mocks.sendContentMessage.mockClear();

		controller.skipCurrentSong();
		expect(controller.getMode()).toBe(ControllerMode.Skipped);

		controller.onStateChanged({ ...SONG_STATE, isPlaying: false });
		await settle();

		expect(controller.getMode()).toBe(ControllerMode.Skipped);
		expect(sentMessages('setPaused')).toHaveLength(0);
	});
});
