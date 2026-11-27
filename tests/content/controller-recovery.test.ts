import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type BaseConnector from '@/core/content/connector';
import Controller from '@/core/object/controller/controller';
import * as ControllerMode from '@/core/object/controller/controller-mode';
import { ServiceCallResult } from '@/core/object/service-call-result';
import type Song from '@/core/object/song';
import type { State } from '@/core/types';

const mocks = vi.hoisted(() => ({
	sendContentMessage: vi.fn(),
	pushScrobble: vi.fn(),
	deleteScrobbles: vi.fn(),
	shouldScrobbleChannel: vi.fn(),
	listeners: new Map<string, (value?: boolean) => void>(),
}));

vi.mock('webextension-polyfill', () => ({ default: {} }));
vi.mock('@/util/communication', () => ({
	sendContentMessage: mocks.sendContentMessage,
	setupContentListeners: vi.fn(),
	contentListener: (listener: {
		type: string;
		fn: (value?: boolean) => void;
	}) => {
		mocks.listeners.set(listener.type, listener.fn);
		return listener;
	},
}));
vi.mock('@/core/storage/browser-storage', () => ({
	DISABLED_TABS: 'DisabledTabs',
	getStorage: () => ({}),
}));
vi.mock('@/core/storage/options', () => ({
	SCROBBLE_PODCASTS: 'scrobblePodcasts',
	SCROBBLE_PERCENT: 'scrobblePercent',
	getOption: async (option: string) =>
		option === 'scrobblePercent' ? 50 : false,
}));
vi.mock('@/core/storage/blocklist', () => ({
	default: class {
		shouldScrobbleChannel = mocks.shouldScrobbleChannel;
	},
}));
vi.mock('@/core/storage/scrobble-cache', () => ({
	default: {
		pushScrobble: mocks.pushScrobble,
		deleteScrobbles: mocks.deleteScrobbles,
	},
}));
vi.mock('@/core/storage/saved-edits', () => ({ default: {} }));
vi.mock('@/core/content/util', () => ({ debugLog: vi.fn() }));
vi.mock('@/core/util/debug', () => ({ debugLog: vi.fn() }));
vi.mock('@/core/object/pipeline/pipeline', () => ({
	default: class {
		async process(song: Song) {
			song.flags.isValid = true;
			song.flags.finishedProcessing = true;
			return true;
		}
	},
}));

describe('Controller playback and scrobble recovery', () => {
	let controller: Controller;
	let state: State;
	const scrobbleRequests = () =>
		mocks.sendContentMessage.mock.calls.filter(
			([message]) => message.type === 'scrobble',
		);
	const update = async (changes: Partial<State> = {}) => {
		state = { ...state, ...changes };
		controller.onStateChanged(state);
		await vi.advanceTimersByTimeAsync(0);
	};

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		vi.clearAllMocks();
		mocks.listeners.clear();
		mocks.pushScrobble.mockResolvedValue(1);
		mocks.deleteScrobbles.mockResolvedValue(undefined);
		mocks.shouldScrobbleChannel.mockResolvedValue(true);
		mocks.sendContentMessage.mockImplementation(async ({ type }) => {
			if (type === 'getTabId') {
				return undefined;
			}
			return type === 'scrobble'
				? [[ServiceCallResult.RESULT_OK]]
				: [ServiceCallResult.RESULT_OK];
		});
		vi.stubGlobal('window', globalThis);
		vi.stubGlobal('document', { querySelector: () => null });
		vi.stubGlobal('Util', {
			isArtistTrackEmpty: (song: State) => !(song.artist && song.track),
		});
		state = {
			artist: 'Artist',
			track: 'Track',
			uniqueID: 'video',
			duration: 120,
			currentTime: 1,
			isPlaying: true,
			scrobblingDisallowedReason: null,
		};
		controller = new Controller(
			{
				meta: { id: 'YouTube', label: 'YouTube' },
				getChannelId: () => null,
				useUniqueIdAsTrackIdentity: true,
			} as unknown as BaseConnector,
			true,
		);
	});

	afterEach(async () => {
		controller.finish();
		await vi.advanceTimersByTimeAsync(0);
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it('waits for playback and requires the listening threshold after a background pause', async () => {
		await update({ isPlaying: false, currentTime: 0 });
		await vi.advanceTimersByTimeAsync(180_000);
		expect(controller.getCurrentSong()).toBeNull();
		expect(mocks.pushScrobble).not.toHaveBeenCalled();
		await update({ isPlaying: true, currentTime: 1 });
		expect(controller.getMode()).toBe(ControllerMode.Playing);
		await vi.advanceTimersByTimeAsync(59_000);
		expect(scrobbleRequests()).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(scrobbleRequests()).toHaveLength(1);
		expect(controller.getMode()).toBe(ControllerMode.Scrobbled);
	});

	it('excludes a pause in the middle of the listening threshold', async () => {
		await update();
		await vi.advanceTimersByTimeAsync(10_000);
		await update({ isPlaying: false });
		await vi.advanceTimersByTimeAsync(180_000);
		expect(scrobbleRequests()).toHaveLength(0);
		await update({ isPlaying: true });
		await vi.advanceTimersByTimeAsync(49_000);
		expect(scrobbleRequests()).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(scrobbleRequests()).toHaveLength(1);
	});

	it.each([
		{ scenario: 'starts in a background tab', initiallyHidden: true },
		{
			scenario: 'moves to the background immediately',
			initiallyHidden: false,
		},
	])(
		'excludes buffering and seek time when YouTube $scenario',
		async ({ initiallyHidden }) => {
			vi.resetModules();
			let hidden = initiallyHidden;
			const video = {
				currentTime: 0,
				paused: false,
				ended: false,
				readyState: 4,
				seeking: false,
				matches: (selector: string) => selector === '.html5-main-video',
			};
			const mediaListeners = new Map<
				string,
				(event: { target: typeof video }) => void
			>();
			const youtube = {
				applyFilter: vi.fn(),
				onStateChanged: () => {
					controller.onStateChanged({
						...state,
						currentTime: video.currentTime,
						isPlaying: youtube.isPlaying(),
					});
				},
			} as unknown as BaseConnector;
			vi.stubGlobal('document', {
				get hidden() {
					return hidden;
				},
				get visibilityState() {
					return hidden ? 'hidden' : 'visible';
				},
				querySelector: (selector: string) =>
					video.matches(selector) ? video : null,
				addEventListener: (
					name: string,
					listener: (event: { target: typeof video }) => void,
				) => mediaListeners.set(name, listener),
			});
			vi.stubGlobal('Connector', youtube);
			vi.stubGlobal('Util', {
				getOption: async () => false,
				debugLog: vi.fn(),
			});
			vi.stubGlobal('MetadataFilter', {
				createYouTubeFilter: () => ({ append: vi.fn() }),
			});
			await import('@/connectors/youtube');

			const dispatch = (name: string) =>
				mediaListeners.get(name)!({ target: video });
			dispatch('play');
			expect(controller.getCurrentSong()).toBeNull();
			video.currentTime = 0.5;
			dispatch('timeupdate');
			hidden = true;

			await vi.advanceTimersByTimeAsync(10_000);
			video.currentTime = 10;
			video.readyState = 2;
			dispatch('waiting');
			await vi.advanceTimersByTimeAsync(80_000);
			expect(scrobbleRequests()).toHaveLength(0);

			video.readyState = 4;
			video.seeking = true;
			dispatch('seeking');
			await vi.advanceTimersByTimeAsync(5_000);
			video.currentTime = 35;
			video.seeking = false;
			dispatch('seeked');
			await vi.advanceTimersByTimeAsync(49_999);
			expect(scrobbleRequests()).toHaveLength(0);

			await vi.advanceTimersByTimeAsync(1);
			expect(scrobbleRequests()).toHaveLength(1);
			expect(controller.getMode()).toBe(ControllerMode.Scrobbled);
		},
	);

	it('keeps the listening threshold when a temporary block clears early', async () => {
		await update({ scrobblingDisallowedReason: 'IsLoading' });
		await vi.advanceTimersByTimeAsync(10_000);
		await update({ scrobblingDisallowedReason: null });
		expect(controller.getMode()).toBe(ControllerMode.Playing);
		expect(scrobbleRequests()).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(50_000);
		expect(scrobbleRequests()).toHaveLength(1);
	});

	it('updates the popup when a temporary block becomes a failed lookup', async () => {
		await update({ scrobblingDisallowedReason: 'IsLoading' });
		expect(controller.getMode()).toBe(ControllerMode.Disallowed);
		mocks.sendContentMessage.mockClear();

		await update({
			scrobblingDisallowedReason: 'YouTubeMusicLookupFailed',
		});
		expect(mocks.sendContentMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'songUpdate',
				payload: expect.objectContaining({
					parsed: expect.objectContaining({
						scrobblingDisallowedReason: 'YouTubeMusicLookupFailed',
					}),
				}),
			}),
		);
		expect(controller.getMode()).toBe(ControllerMode.Disallowed);
	});

	it('submits the missed scrobble when a temporary block clears after the threshold', async () => {
		await update({ scrobblingDisallowedReason: 'IsLoading' });
		await vi.advanceTimersByTimeAsync(60_000);
		expect(mocks.pushScrobble).toHaveBeenCalledWith(
			expect.objectContaining({ status: 'disallowed' }),
		);
		await update({ scrobblingDisallowedReason: null, currentTime: 61 });
		expect(scrobbleRequests()).toHaveLength(1);
		expect(controller.getMode()).toBe(ControllerMode.Scrobbled);
		expect(mocks.deleteScrobbles).toHaveBeenCalledWith([1]);
		await update({ currentTime: 62 });
		expect(scrobbleRequests()).toHaveLength(1);
		await update({ isPlaying: false });
		await update({ isPlaying: true });
		expect(scrobbleRequests()).toHaveLength(1);
		expect(controller.getMode()).toBe(ControllerMode.Scrobbled);
	});

	it('recovers an expired attempt even if Now Playing was already sent', async () => {
		await update();
		await vi.advanceTimersByTimeAsync(10_000);
		await update({ scrobblingDisallowedReason: 'IsLoading' });
		await vi.advanceTimersByTimeAsync(50_000);
		await update({ scrobblingDisallowedReason: null });
		expect(scrobbleRequests()).toHaveLength(1);
		expect(controller.getMode()).toBe(ControllerMode.Scrobbled);
	});

	it('waits for resume before recovering a blocked attempt', async () => {
		await update({ scrobblingDisallowedReason: 'IsLoading' });
		await vi.advanceTimersByTimeAsync(60_000);
		await update({ isPlaying: false, scrobblingDisallowedReason: null });
		expect(scrobbleRequests()).toHaveLength(0);
		await update({ isPlaying: true });
		expect(scrobbleRequests()).toHaveLength(1);
	});

	it('preserves category and channel blocks after an attempt expires', async () => {
		await update({ scrobblingDisallowedReason: 'IsLoading' });
		await vi.advanceTimersByTimeAsync(60_000);
		await update({
			scrobblingDisallowedReason: 'ForbiddenYouTubeCategory',
		});
		expect(scrobbleRequests()).toHaveLength(0);
		mocks.shouldScrobbleChannel.mockResolvedValue(false);
		await update({ scrobblingDisallowedReason: null });
		expect(scrobbleRequests()).toHaveLength(0);
	});

	it('keeps a manually recovered scrobble marked as scrobbled on later updates', async () => {
		await update({ scrobblingDisallowedReason: 'IsLoading' });
		await vi.advanceTimersByTimeAsync(60_000);
		mocks.listeners.get('forceScrobbleSong')!();
		await vi.advanceTimersByTimeAsync(0);
		expect(scrobbleRequests()).toHaveLength(1);
		expect(controller.getMode()).toBe(ControllerMode.Scrobbled);
		await update({ scrobblingDisallowedReason: null, currentTime: 62 });
		expect(scrobbleRequests()).toHaveLength(1);
		expect(controller.getMode()).toBe(ControllerMode.Scrobbled);
	});

	it('recovers only once while several playback updates arrive during submission', async () => {
		await update({ scrobblingDisallowedReason: 'IsLoading' });
		await vi.advanceTimersByTimeAsync(60_000);
		let completeSubmission!: (results: ServiceCallResult[][]) => void;
		mocks.sendContentMessage.mockImplementation(async ({ type }) =>
			type === 'scrobble'
				? new Promise<ServiceCallResult[][]>((resolve) => {
						completeSubmission = resolve;
					})
				: [ServiceCallResult.RESULT_OK],
		);
		await update({ scrobblingDisallowedReason: null });
		await update({ currentTime: 62 });
		await update({ currentTime: 63 });
		expect(scrobbleRequests()).toHaveLength(1);
		completeSubmission([[ServiceCallResult.RESULT_OK]]);
		await vi.advanceTimersByTimeAsync(0);
		expect(controller.getMode()).toBe(ControllerMode.Scrobbled);
	});

	it('retains a blocked play in the cache when the next video scrobbles', async () => {
		await update({ scrobblingDisallowedReason: 'IsLoading' });
		await vi.advanceTimersByTimeAsync(60_000);
		expect(mocks.pushScrobble).toHaveBeenCalledOnce();

		await update({
			track: 'Next track',
			uniqueID: 'next-video',
			scrobblingDisallowedReason: null,
		});
		await vi.advanceTimersByTimeAsync(60_000);

		expect(scrobbleRequests()).toHaveLength(1);
		expect(scrobbleRequests()[0][0].payload.songs[0].parsed.uniqueID).toBe(
			'next-video',
		);
		expect(mocks.deleteScrobbles).not.toHaveBeenCalled();
	});

	it('does not mark the next video scrobbled when an earlier recovery succeeds', async () => {
		await update({ scrobblingDisallowedReason: 'IsLoading' });
		await vi.advanceTimersByTimeAsync(60_000);

		let completeSubmission!: (results: ServiceCallResult[][]) => void;
		mocks.sendContentMessage.mockImplementation(async ({ type }) =>
			type === 'scrobble'
				? new Promise<ServiceCallResult[][]>((resolve) => {
						completeSubmission = resolve;
					})
				: [ServiceCallResult.RESULT_OK],
		);
		await update({ scrobblingDisallowedReason: null });
		expect(scrobbleRequests()).toHaveLength(1);
		expect(mocks.deleteScrobbles).not.toHaveBeenCalled();

		await update({ track: 'Next track', uniqueID: 'next-video' });
		completeSubmission([[ServiceCallResult.RESULT_OK]]);
		await vi.advanceTimersByTimeAsync(0);

		expect(mocks.deleteScrobbles).toHaveBeenCalledExactlyOnceWith([1]);
		expect(controller.getCurrentSong()?.flags.isScrobbled).toBe(false);
		expect(controller.getMode()).toBe(ControllerMode.Playing);
	});

	it('does not transfer a delayed cache write to the next video', async () => {
		let completeCacheWrite!: (id: number) => void;
		mocks.pushScrobble.mockImplementationOnce(
			() =>
				new Promise<number>((resolve) => {
					completeCacheWrite = resolve;
				}),
		);
		await update({ scrobblingDisallowedReason: 'IsLoading' });
		await vi.advanceTimersByTimeAsync(60_000);

		await update({
			track: 'Next track',
			uniqueID: 'next-video',
			scrobblingDisallowedReason: null,
		});
		completeCacheWrite(1);
		await update({ currentTime: 2 });
		expect(scrobbleRequests()).toHaveLength(0);

		await vi.advanceTimersByTimeAsync(60_000);
		expect(scrobbleRequests()).toHaveLength(1);
		expect(mocks.deleteScrobbles).not.toHaveBeenCalled();
	});

	it('submits the original play after editing ends on the next video', async () => {
		await update({ scrobblingDisallowedReason: 'IsLoading' });
		await vi.advanceTimersByTimeAsync(60_000);
		mocks.listeners.get('setEditState')!(true);
		await update({ scrobblingDisallowedReason: null });
		expect(scrobbleRequests()).toHaveLength(0);

		await update({ track: 'Next track', uniqueID: 'next-video' });
		mocks.listeners.get('setEditState')!(false);
		await vi.advanceTimersByTimeAsync(0);

		expect(scrobbleRequests()).toHaveLength(1);
		const { songs, currentlyPlaying } = scrobbleRequests()[0][0].payload;
		expect(songs[0].parsed.uniqueID).toBe('video');
		expect(currentlyPlaying).toBe(false);
		expect(controller.getCurrentSong()?.flags.isScrobbled).toBe(false);
	});

	it('keeps the recovery entry when the background cannot confirm submission', async () => {
		await update({ scrobblingDisallowedReason: 'IsLoading' });
		await vi.advanceTimersByTimeAsync(60_000);
		mocks.sendContentMessage.mockImplementation(async ({ type }) => {
			if (type === 'scrobble') {
				throw new Error('Message channel disconnected');
			}
			return [ServiceCallResult.RESULT_OK];
		});

		await update({ scrobblingDisallowedReason: null });

		expect(scrobbleRequests()).toHaveLength(1);
		expect(mocks.pushScrobble).toHaveBeenCalledOnce();
		expect(mocks.deleteScrobbles).not.toHaveBeenCalled();
		expect(controller.getMode()).toBe(ControllerMode.Err);
	});

	it('recovers a play whose title changes when recognition returns', async () => {
		await update({ scrobblingDisallowedReason: 'IsLoading' });
		const song = controller.getCurrentSong();
		await vi.advanceTimersByTimeAsync(92_000);
		expect(mocks.pushScrobble).toHaveBeenCalledOnce();

		await update({
			track: 'Canonical title',
			scrobblingDisallowedReason: null,
			currentTime: 92,
		});

		expect(controller.getCurrentSong()).toBe(song);
		expect(scrobbleRequests()).toHaveLength(1);
		const submitted = scrobbleRequests()[0][0].payload.songs[0];
		expect(submitted.parsed.track).toBe('Canonical title');
		expect(submitted.metadata.startTimestamp).toBe(0);
		expect(mocks.deleteScrobbles).toHaveBeenCalledExactlyOnceWith([1]);
	});

	it('counts listening time from before a title correction', async () => {
		await update();
		const song = controller.getCurrentSong();
		await vi.advanceTimersByTimeAsync(40_000);
		await update({ track: 'Corrected title', currentTime: 40 });
		await vi.advanceTimersByTimeAsync(19_999);
		expect(scrobbleRequests()).toHaveLength(0);

		await vi.advanceTimersByTimeAsync(1);
		expect(controller.getCurrentSong()).toBe(song);
		expect(scrobbleRequests()).toHaveLength(1);
		expect(scrobbleRequests()[0][0].payload.songs[0].parsed.track).toBe(
			'Corrected title',
		);
	});

	it('keeps a completed play scrobbled after reprocessing and counts a real replay', async () => {
		await update({ duration: 900 });
		await vi.advanceTimersByTimeAsync(240_000);
		const song = controller.getCurrentSong();
		expect(scrobbleRequests()).toHaveLength(1);

		await update({ track: 'Corrected title', currentTime: 240 });
		mocks.listeners.get('reprocessSong')!();
		await vi.advanceTimersByTimeAsync(241_000);

		expect(controller.getCurrentSong()).toBe(song);
		expect(controller.getCurrentSong()?.parsed.track).toBe(
			'Corrected title',
		);
		expect(controller.getMode()).toBe(ControllerMode.Scrobbled);
		expect(scrobbleRequests()).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(419_000);
		await update({ isPlaying: false, currentTime: 900 });
		await update({ isPlaying: true, currentTime: 1 });
		await vi.advanceTimersByTimeAsync(240_000);
		expect(scrobbleRequests()).toHaveLength(2);
		expect(controller.getCurrentSong()).not.toBe(song);
	});

	it('caches an unconfirmed first submission and keeps it available for manual recovery', async () => {
		mocks.sendContentMessage.mockImplementation(async ({ type }) => {
			if (type === 'scrobble') {
				throw new Error('Message channel disconnected');
			}
			return [ServiceCallResult.RESULT_OK];
		});
		await update();
		await vi.advanceTimersByTimeAsync(61_000);
		expect(mocks.pushScrobble).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ status: 'error' }),
		);

		await update({ currentTime: 61, track: 'Corrected title' });
		await vi.advanceTimersByTimeAsync(30_000);
		expect(controller.getMode()).toBe(ControllerMode.Err);
		expect(scrobbleRequests()).toHaveLength(1);
		expect(mocks.deleteScrobbles).not.toHaveBeenCalled();
	});

	it('caches the original play when its submission fails after switching videos', async () => {
		let rejectSubmission!: (error: Error) => void;
		mocks.sendContentMessage.mockImplementation(async ({ type }) => {
			if (type === 'scrobble') {
				return new Promise<never>((_, reject) => {
					rejectSubmission = reject;
				});
			}
			return [ServiceCallResult.RESULT_OK];
		});
		await update();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(scrobbleRequests()).toHaveLength(1);

		await update({
			track: 'Next track',
			uniqueID: 'next-video',
			currentTime: 1,
		});
		rejectSubmission(new Error('Background reply was lost'));
		await vi.advanceTimersByTimeAsync(0);

		expect(mocks.pushScrobble).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				status: 'error',
				song: expect.objectContaining({
					parsed: expect.objectContaining({ uniqueID: 'video' }),
				}),
			}),
		);
		expect(controller.getCurrentSong()?.parsed.uniqueID).toBe('next-video');
		expect(controller.getMode()).toBe(ControllerMode.Playing);
	});
});
