import type { ConnectorMeta } from '@/core/connectors';
import * as Options from '@/core/storage/options';
import type { DebugLogType } from '@/core/util/debug';
import {
	areAllResults,
	parseScrobblePercent,
	getSecondsToScrobble,
	isAnyResult,
} from '@/util/util';
import Song from '@/core/object/song';
import Timer from '@/core/object/timer';
import Pipeline from '@/core/object/pipeline/pipeline';
import * as ControllerMode from '@/core/object/controller/controller-mode';
import * as ControllerEvents from '@/core/object/controller/controller-event';
import { ServiceCallResult } from '@/core/object/service-call-result';
import SavedEdits from '@/core/storage/saved-edits';
import type { State } from '@/core/types';
import {
	contentListener,
	sendContentMessage,
	setupContentListeners,
} from '@/util/communication';
import EventEmitter from '@/util/emitter';
import * as BrowserStorage from '@/core/storage/browser-storage';
import { debugLog } from '@/core/content/util';
import scrobbleCache from '@/core/storage/scrobble-cache';
import { ScrobbleStatus } from '@/core/storage/wrapper';
import browser from 'webextension-polyfill';
import type BaseConnector from '@/core/content/connector';
import Blocklist from '@/core/storage/blocklist';

/**
 * List of song fields used to check if song is changed. If any of
 * these fields are changed, the new song is playing.
 */
const fieldsToCheckSongChange = [
	'artist',
	'track',
	'album',
	'uniqueID',
] as const;
const trackMetadataFields = [
	'artist',
	'track',
	'album',
	'albumArtist',
] as const;

export type ControllerEvent =
	(typeof ControllerEvents)[keyof typeof ControllerEvents];

export type ControllerModeStr =
	(typeof ControllerMode)[keyof typeof ControllerMode];

/**
 * Priorities of each state as an object
 */
export const isPrioritizedMode: Partial<Record<ControllerModeStr, true>> = {
	[ControllerMode.Disallowed]: true,
	[ControllerMode.Playing]: true,
	[ControllerMode.Paused]: true,
	[ControllerMode.Scrobbled]: true,
	[ControllerMode.Loading]: true,
	[ControllerMode.Unknown]: true,
	[ControllerMode.Ignored]: true,
	[ControllerMode.Err]: true,
	[ControllerMode.Loved]: true,
	[ControllerMode.Unloved]: true,
};

type updateEvent = {
	updateEditStatus: (isEditing: boolean) => void;
};

const disabledTabs = BrowserStorage.getStorage(BrowserStorage.DISABLED_TABS);

/**
 * Object that handles song playback and scrobbling actions.
 */
export default class Controller {
	public connector: BaseConnector;
	public isEnabled: boolean;
	private mode: ControllerModeStr;
	private tempMode: ControllerModeStr | null;
	private timeoutId: NodeJS.Timeout | undefined = undefined;

	private pipeline = new Pipeline();
	private playbackTimer = new Timer();
	private replayDetectionTimer = new Timer();

	private currentSong: Song | null = null;
	private processingRun = 0;
	private isReplayingSong = false;
	private shouldScrobblePodcasts = true;
	private scrobbleCacheIds = new WeakMap<Song, number>();
	private blocklist: Blocklist;
	private isPaused = false;

	private forceScrobble = false;
	private shouldHaveScrobbled = false;
	private scrobblingSongs = new WeakSet<Song>();
	private unconfirmedSubmissions = new WeakSet<Song>();

	private isEditing = false;
	private setNotEditingTimeout = setTimeout(() => {
		// do nothing
	}, 0);
	private eventEmitter = new EventEmitter<updateEvent>();
	private tabId = sendContentMessage({
		type: 'getTabId',
		payload: undefined,
	});

	/**
	 * Sync the disallowed reason for the play being checked.
	 *
	 * @param song - Play to check
	 * @returns true if song should scrobble; false if disallowed.
	 */
	private async shouldScrobble(song = this.currentSong): Promise<boolean> {
		if (this.forceScrobble) {
			return true;
		}

		if (!song || song.parsed.scrobblingDisallowedReason) {
			return false;
		}

		if (
			!(await this.blocklist.shouldScrobbleChannel(
				this.connector.getChannelId?.(),
			))
		) {
			song.parsed.scrobblingDisallowedReason = 'ForbiddenChannel';
			return false;
		}

		if (song.flags.hasBlockedTag) {
			song.parsed.scrobblingDisallowedReason = 'ForbiddenTag';
			return false;
		}

		return !song.parsed.scrobblingDisallowedReason;
	}

	/**
	 * Function that handles updating the scrobble info box
	 */
	private async getInfoBoxElement(): Promise<HTMLDivElement | null> {
		if (
			!this.connector.scrobbleInfoLocationSelector ||
			// infobox is disabled in options
			!(await Options.getOption(
				Options.USE_INFOBOX,
				this.connector.meta.id,
			))
		) {
			return null;
		}

		const parentEl = document.querySelector(
			this.connector.scrobbleInfoLocationSelector,
		);
		if (!parentEl) {
			return null;
		}

		// check if infoBoxEl was already created
		let infoBoxElement = document.querySelector<HTMLDivElement>(
			'#scrobbler-infobox-el',
		);

		// check if element is still in the correct place
		if (infoBoxElement) {
			if (infoBoxElement.parentElement !== parentEl) {
				infoBoxElement.remove();
			} else {
				return infoBoxElement;
			}
		}

		// if it was not in the correct place or didn't exist, create it
		infoBoxElement = document.createElement('div');
		infoBoxElement.setAttribute('id', 'scrobbler-infobox-el');

		// style the infobox
		for (const prop in this.connector.scrobbleInfoStyle) {
			infoBoxElement.style[prop] =
				this.connector.scrobbleInfoStyle[prop] ?? '';
		}

		parentEl.appendChild(infoBoxElement);
		return infoBoxElement;
	}

	private async updateInfoBox() {
		let oldInfoBoxText: string | false = false;
		const infoBoxElement = await this.getInfoBoxElement();
		if (!infoBoxElement) {
			// clean up
			const infoBoxElement = document.querySelector<HTMLDivElement>(
				'#scrobbler-infobox-el',
			);
			if (infoBoxElement) {
				infoBoxElement.remove();
			}
			return;
		}
		const textEl = infoBoxElement.querySelector('span');
		if (textEl) {
			oldInfoBoxText = textEl.innerText;
		}

		const mode = this.getMode();
		const infoBoxText = Util.getInfoBoxText(mode, this.currentSong);

		// Check if infobox needs to be updated
		if (!oldInfoBoxText || infoBoxText !== oldInfoBoxText) {
			const img = document.createElement('img');
			img.setAttribute(
				'src',
				browser.runtime.getURL('./icons/icon_main_48.png'),
			);
			img.setAttribute('alt', 'Web Scrobbler state:');
			img.setAttribute('style', 'height: 1.2em');

			const info = document.createElement('span');
			info.innerText = infoBoxText;

			// Clear old contents of infoBoxElement
			while (infoBoxElement.firstChild) {
				infoBoxElement.removeChild(infoBoxElement.firstChild);
			}
			infoBoxElement.appendChild(img);
			infoBoxElement.appendChild(info);
		}
	}

	/**
	 * @param tabId - Tab ID
	 * @param connector - Connector match object
	 * @param isEnabled - Flag indicates initial stage
	 */
	constructor(connector: BaseConnector, isEnabled: boolean) {
		this.connector = connector;
		this.blocklist = new Blocklist(this.connector.meta.id);
		this.isEnabled = isEnabled;
		this.mode = isEnabled ? ControllerMode.Base : ControllerMode.Disabled;
		this.onModeChanged();
		this.tempMode = null; // temporary default setting for now
		Options.getOption(Options.SCROBBLE_PODCASTS, connector.meta.id)
			.then((shouldScrobblePodcasts) => {
				if (typeof shouldScrobblePodcasts !== 'boolean') {
					return;
				}
				this.shouldScrobblePodcasts = shouldScrobblePodcasts;
			})
			.catch((err) => {
				debugLog(err, 'error');
			});

		this.debugLog(
			`Created controller for ${connector.meta.label} connector`,
		);

		setupContentListeners(
			contentListener({
				type: 'skipCurrentSong',
				fn: () => {
					this.skipCurrentSong();
				},
			}),
			contentListener({
				type: 'toggleLove',
				fn: ({ isLoved, shouldShowNotification }) => {
					this.toggleLove(isLoved, shouldShowNotification);
				},
			}),
			contentListener({
				type: 'updateLove',
				fn: ({ isLoved }) => {
					this.currentSong?.setLoveStatus(isLoved, true);
				},
			}),
			contentListener({
				type: 'reprocessSong',
				fn: () => {
					this.reprocessSong();
				},
			}),
			contentListener({
				type: 'setEditState',
				fn: (isEditing) => {
					this.isEditing = isEditing;
					this.eventEmitter.emit('updateEditStatus', isEditing);

					if (isEditing) {
						clearTimeout(this.setNotEditingTimeout);
						this.setNotEditingTimeout = setTimeout(() => {
							this.isEditing = false;
							this.eventEmitter.emit('updateEditStatus', false);
						}, 5000);
					}
				},
			}),
			contentListener({
				type: 'resetData',
				fn: () => {
					this.resetSongData();
				},
			}),
			contentListener({
				type: 'setConnectorState',
				fn: (isEnabled) => {
					this.setConnectorState(isEnabled);
				},
			}),
			contentListener({
				type: 'disableConnectorUntilTabIsClosed',

				fn: () => this.disableUntilTabIsClosed(),
			}),
			contentListener({
				type: 'getConnectorDetails',
				fn: () => ({
					mode: this.getMode(),
					permanentMode: this.mode,
					song: this.currentSong?.getCloneableData() ?? null,
				}),
			}),
			contentListener({
				type: 'forceScrobbleSong',
				fn: () => {
					this.forceScrobble = true;
					if (this.shouldHaveScrobbled) {
						void this.scrobbleSong();
					} else {
						void this.setSongNowPlaying();
					}
				},
			}),
			contentListener({
				type: 'getChannelDetails',
				fn: () => ({
					connector: this.connector.meta,
					channelInfo: this.connector.getChannelInfo?.(),
				}),
			}),
			contentListener({
				type: 'addToBlocklist',
				fn: async () => {
					await this.blocklist.addToBlocklist(
						this.connector.getChannelInfo?.() ?? null,
					);
					this.setMode(ControllerMode.Disallowed);
				},
			}),
			contentListener({
				type: 'removeFromBlocklist',
				fn: async () => {
					const song = this.currentSong;
					await this.blocklist.removeFromBlocklist(
						this.connector.getChannelInfo?.()?.id ?? null,
					);
					if (this.currentSong !== song) {
						return;
					}
					if (this.shouldHaveScrobbled) {
						void this.scrobbleSong(song);
					} else {
						void this.setSongNowPlaying(song);
					}
				},
			}),
		);
	}

	/** Listeners. */

	/**
	 * Called if current song is updated.
	 */
	public onSongUpdated(): void {
		this.updateInfoBox();
		sendContentMessage({
			type: 'songUpdate',
			payload: this.currentSong?.getCloneableData() ?? null,
		});
	}

	/**
	 * Called if a controller mode is changed.
	 */
	public onModeChanged(): void {
		this.updateInfoBox();
		sendContentMessage({
			type: 'controllerModeChange',
			payload: {
				mode: this.getMode(),
				permanentMode: this.mode,
			},
		});
	}

	/**
	 * Called if a new event is dispatched.
	 *
	 * @param event - Event generated by the controller.
	 */
	public async onControllerEvent(event: string): Promise<void> {
		switch (event) {
			case ControllerEvents.SongNowPlaying: {
				const song = this.getCurrentSong();
				const run = this.processingRun;
				if (
					!song ||
					song.flags.isReplaying ||
					!song.isValid() ||
					!(await this.shouldScrobble(song)) ||
					!this.isCurrentProcessing(song, run)
				) {
					break;
				}
				const id = await this.tabId;
				if (!id || !this.isCurrentProcessing(song, run)) {
					break;
				}

				sendContentMessage({
					type: 'showNowPlaying',
					payload: {
						song: song.getCloneableData(),
						connector: this.connector.meta,
					},
				});
				break;
			}
			case ControllerEvents.ControllerReset: {
				const song = this.getCurrentSong();
				if (song) {
					sendContentMessage({
						type: 'clearNowPlaying',
						payload: {
							song: song.getCloneableData(),
						},
					});
				}
				break;
			}
			case ControllerEvents.SongUnrecognized: {
				const song = this.getCurrentSong();
				const run = this.processingRun;
				if (
					!song ||
					!(await this.shouldScrobble(song)) ||
					!this.isCurrentProcessing(song, run)
				) {
					break;
				}
				const id = await this.tabId;
				if (!id || !this.isCurrentProcessing(song, run)) {
					break;
				}

				sendContentMessage({
					type: 'showSongNotRecognized',
					payload: {
						song: song.getCloneableData(),
						connector: this.connector.meta,
					},
				});
				break;
			}
		}

		this.updateInfoBox();
	}

	/** Public functions */

	/**
	 * Switch the state of controller.
	 * @param flag - True means enabled and vice versa
	 */
	public setEnabled(flag: boolean): void {
		this.isEnabled = flag;

		if (flag) {
			this.setMode(ControllerMode.Base);
		} else {
			this.resetState();
			this.setMode(ControllerMode.Disabled);
		}
	}

	/**
	 * Do finalization before unloading controller.
	 */
	public finish(): void {
		this.debugLog(
			`Remove controller for ${this.connector.meta.label} connector`,
		);
		this.resetState();
	}

	/**
	 * Reset song data and process it again.
	 */
	public async resetSongData(): Promise<void> {
		const song = this.assertSongIsPlaying();

		song.resetInfo();
		await SavedEdits.removeSongInfo(song);
		if (song !== this.currentSong) {
			return;
		}

		this.unprocessSong(song);
		void this.processSong(song);
	}

	/**
	 * Make the controller to ignore current song.
	 */
	skipCurrentSong(): void {
		this.assertSongIsPlaying();
		if (!assertSongNotNull(this.currentSong)) {
			return;
		}

		this.setMode(ControllerMode.Skipped);

		this.currentSong.flags.isSkipped = true;
		this.shouldHaveScrobbled = false;
		this.forceScrobble = false;

		this.playbackTimer.reset();
		this.replayDetectionTimer.reset();

		this.onSongUpdated();
	}

	/**
	 * Get connector match object.
	 * @returns Connector
	 */
	getConnector(): ConnectorMeta {
		return this.connector.meta;
	}

	/**
	 * Get current song as plain object.
	 * @returns Song copy
	 */
	getCurrentSong(): Song | null {
		return this.currentSong;
	}

	/**
	 * Get current controller mode.
	 * @returns Controller mode
	 */
	getMode(): (typeof ControllerMode)[keyof typeof ControllerMode] {
		const pausableModes = [
			ControllerMode.Playing,
			ControllerMode.Scrobbled,
		];
		if (this.tempMode !== null) {
			return this.tempMode;
		}
		if (pausableModes.includes(this.mode) && this.isPaused) {
			return ControllerMode.Paused;
		}
		return this.mode;
	}

	/**
	 * Sets data for current song from user input
	 * @param data - Object containing song data
	 */
	async setUserSongData(data: Options.SavedEdit): Promise<void> {
		const song = this.assertSongIsPlaying();

		if (song.flags.isScrobbled) {
			throw new Error('Unable to set user data for scrobbled song');
		}

		await SavedEdits.saveSongInfo(song, data);
		if (song !== this.currentSong) {
			return;
		}

		this.unprocessSong(song);
		void this.processSong(song);
	}

	/**
	 * Reprocess currently playing song without otherwise changing it.
	 */
	reprocessSong(): void {
		const song = this.assertSongIsPlaying();
		this.unprocessSong(song);
		void this.processSong(song);
	}

	/**
	 * Send request to love or unlove current song.
	 * @param isLoved - Flag indicated song is loved
	 * @param shouldShowNotification - Flag indicating that a notification should show up
	 */
	async toggleLove(
		isLoved: boolean,
		shouldShowNotification: boolean,
	): Promise<void> {
		this.assertSongIsPlaying();
		if (!assertSongNotNull(this.currentSong)) {
			return;
		}
		if (!this.currentSong.isValid()) {
			throw new Error('No valid song is now playing');
		}

		// set love status optimistically, amend to revert if it were to fail.
		this.currentSong.setLoveStatus(isLoved, true);
		this.onSongUpdated();
		try {
			if (isLoved) {
				this.setTempMode(ControllerMode.Loved);
			} else {
				this.setTempMode(ControllerMode.Unloved);
			}
			await sendContentMessage({
				type: 'toggleLove',
				payload: {
					song: this.currentSong.getCloneableData(),
					isLoved,
					shouldShowNotification,
				},
			});
		} catch {
			this.currentSong.setLoveStatus(!isLoved, true);
		}

		this.onSongUpdated();
	}

	/**
	 * React on love/unlove.
	 * @param isLoved - Whether song is now liked or unliked
	 */
	async onLoveChanged(isLoved: boolean | null): Promise<void> {
		if (!this.currentSong) {
			return;
		}

		/**
		 * Only update love status for some specific modes
		 */
		const loveChangeableModes = [
			ControllerMode.Playing,
			ControllerMode.Scrobbled,
		];
		if (!loveChangeableModes.includes(this.mode)) {
			return;
		}

		/**
		 * If there has not been definitive state before,
		 * just change state without sending anything to service.
		 * We dont want the extension to randomly unlove songs
		 * on scrobbling service because user didn't do it on
		 * streaming service.
		 */
		if (this.currentSong.flags.isLovedInService === null) {
			this.currentSong.flags.isLovedInService = isLoved;
			return;
		}

		/**
		 * If suddenly we are not receiving definitive state anymore
		 * be safe and reset the isloved state
		 */
		if (isLoved === null) {
			this.currentSong.flags.isLovedInService = null;
			return;
		}

		/**
		 * State did not change, don't do anything.
		 */
		if (this.currentSong.flags.isLovedInService === isLoved) {
			return;
		}

		/**
		 * Song already had fetched a definitive loved state,
		 * and this one is different.
		 * This means user has actively changed it.
		 * Change if option suggests so.
		 */
		this.currentSong.flags.isLovedInService = isLoved;
		if (
			await Options.getOption(
				Options.AUTO_TOGGLE_LOVE,
				this.connector.meta.id,
			)
		) {
			if (
				// do not show notification if:
				// 1. song is already loved and is being toggled to love status
				// 2. song is already unloved and is being toggled to unlove status
				(this.currentSong.metadata.userloved === true && isLoved) ||
				(this.currentSong.metadata.userloved === false && !isLoved)
			) {
				return;
			}
			// do send notification if song has not yet been (un)loved toggled yet
			this.toggleLove(isLoved, true);
		}
	}

	/**
	 * React on state change.
	 * @param newState - State of connector
	 */
	onStateChanged(newState: State): void {
		if (!this.isEnabled) {
			return;
		}

		/*
		 * Empty state has same semantics as reset; even if isPlaying,
		 * we don't have enough data to use.
		 */
		if (isStateEmpty(newState)) {
			this.onEmptyState(newState);
			return;
		}

		/*
		 * A state counts as a new song when the identity fields changed
		 * or the current song is replaying.
		 */
		const sameTrackId =
			this.connector.useUniqueIdAsTrackIdentity &&
			Boolean(newState.uniqueID) &&
			newState.uniqueID === this.currentSong?.parsed.uniqueID;
		const isNewSong =
			this.isReplayingSong ||
			(!sameTrackId && this.isSongChanged(newState));

		if (!isNewSong) {
			void this.processCurrentState(newState, sameTrackId);
		} else if (newState.isPlaying) {
			this.processNewState(newState);
		} else {
			this.reset();
		}
	}

	/**
	 * Handle a state that contains no usable track data.
	 * Resets a playing song if there is one; a non-empty state that is
	 * still missing artist/track is left to the pipeline, which treats
	 * missing metadata as correctable rather than as no song.
	 *
	 * @param newState - Connector state
	 */
	private onEmptyState(newState: State): void {
		if (this.currentSong) {
			this.debugLog('Received empty state - resetting');
			this.reset();
		}

		if (newState.isPlaying) {
			this.debugLog(
				`State from connector doesn't contain enough information about the playing track: ${toString(
					newState as Record<string, unknown>,
				)}`,
				'warn',
			);
		}
	}

	/** Internal functions */

	/**
	 * Set the mode of the controller
	 *
	 * @param mode - new controller mode
	 */
	private setMode(mode: ControllerModeStr): void {
		if (!mode) {
			throw new Error(`Unknown mode: ${mode}`);
		}

		this.mode = mode;
		this.onModeChanged();
	}

	/**
	 * Checks if the temp icon/mode is visible.
	 */
	private isTempIconVisible() {
		return this.timeoutId !== undefined;
	}

	/**
	 * Temporarily set the mode of the controller,
	 * then returns to previous mode after 5 seconds.
	 *
	 * @param newMode - new controller mode to be set
	 *
	 */
	private setTempMode(newMode: ControllerModeStr) {
		if (this.isTempIconVisible()) {
			clearTimeout(this.timeoutId);
			this.timeoutId = undefined;
		}
		const TEMP_ICON_DISPLAY_DURATION = 5000;
		this.tempMode = newMode;
		this.onModeChanged();
		this.timeoutId = setTimeout(() => {
			this.timeoutId = undefined;
			this.tempMode = null;
			this.onModeChanged();
		}, TEMP_ICON_DISPLAY_DURATION);
	}

	private dispatchEvent(event: string): void {
		if (!event) {
			throw new Error(`Unknown event: ${event}`);
		}

		this.onControllerEvent(event);
	}

	/**
	 * Process connector state as new one.
	 * @param newState - Connector state
	 */
	private processNewState(newState: State): void {
		/*
		 * We've hit a new song (or replaying the previous one)
		 * clear any previous song and its bindings.
		 */
		this.isPaused = false;
		this.resetState();
		const song = new Song(newState, this.connector.meta);
		this.currentSong = song;
		song.flags.isReplaying = this.isReplayingSong;

		this.debugLog(
			`New song detected: ${toString(
				newState as Record<string, string>,
			)}`,
		);

		if (!this.shouldScrobblePodcasts && newState.isPodcast) {
			this.skipCurrentSong();
			return;
		}

		/*
		 * Start the timer, actual time will be set after processing
		 * is done; we can call doScrobble directly, because the timer
		 * will be allowed to trigger only after the song is validated.
		 */
		this.playbackTimer.start(() => {
			void this.scrobbleSong(song);
		});

		this.replayDetectionTimer.start(() => {
			this.debugLog('Replaying song...');
			this.isReplayingSong = true;
		});

		/*
		 * If we just detected the track and it's not playing yet,
		 * pause the timer right away; this is important, because
		 * isPlaying flag binding only calls pause/resume which assumes
		 * the timer is started.
		 */
		if (!newState.isPlaying) {
			this.setPaused();
		}

		void this.processSong(song);
		this.isReplayingSong = false;
	}

	/**
	 * Process connector state as current one.
	 * @param newState - Connector state
	 * @param sameTrackId - Whether metadata can be updated in place
	 */
	private async processCurrentState(
		newState: State,
		sameTrackId: boolean,
	): Promise<void> {
		const song = this.currentSong;
		if (!song || song.flags.isSkipped) {
			return;
		}

		const {
			currentTime,
			isPlaying,
			trackArt,
			duration,
			scrobblingDisallowedReason,
		} = newState;
		const isPlayingStateChanged = song.parsed.isPlaying !== isPlaying;
		const disallowedReasonChanged =
			song.parsed.scrobblingDisallowedReason !==
			scrobblingDisallowedReason;

		song.parsed.currentTime = currentTime;
		song.parsed.isPlaying = isPlaying;
		song.parsed.trackArt = trackArt;
		song.parsed.scrobblingDisallowedReason = scrobblingDisallowedReason;

		const metadataChanged =
			sameTrackId && this.updateTrackMetadata(song, newState);
		if (metadataChanged) {
			song.parsed.duration = duration ?? song.parsed.duration;
			this.unprocessSong(song);
			void this.processSong(song);
		}

		if (
			this.mode === ControllerMode.Disallowed &&
			scrobblingDisallowedReason &&
			disallowedReasonChanged
		) {
			this.onSongUpdated();
		}

		if (
			!metadataChanged &&
			this.isNeedToUpdateDuration(newState) &&
			duration
		) {
			this.updateSongDuration(duration);
		}

		if (isPlayingStateChanged && isPlaying !== void 0) {
			this.onPlayingStateChanged(isPlaying);
		} else if (
			!metadataChanged &&
			(this.mode === ControllerMode.Disallowed ||
				this.shouldHaveScrobbled) &&
			isPlaying &&
			(await this.shouldScrobble(song))
		) {
			// we need to unset disallowed whenever needed.
			// this is not necessarily tied to pausing/unpausing
			void this.setSongNowPlaying(song);
		}
	}

	private updateTrackMetadata(song: Song, state: State): boolean {
		let changed = false;
		for (const field of trackMetadataFields) {
			const value = state[field];
			if (value && value !== song.parsed[field]) {
				song.parsed[field] = value;
				changed = true;
			}
		}
		return changed;
	}

	/**
	 * Reset controller state.
	 */
	private resetState(): void {
		this.dispatchEvent(ControllerEvents.ControllerReset);

		this.playbackTimer.reset();
		this.replayDetectionTimer.reset();
		this.shouldHaveScrobbled = false;
		this.forceScrobble = false;

		this.currentSong = null;
	}

	/**
	 * Process song using pipeline module.
	 */
	private async processSong(song: Song): Promise<void> {
		const run = ++this.processingRun;
		const isCurrent = () => this.isCurrentProcessing(song, run);

		try {
			const initiallyAllowed = await this.shouldScrobble(song);
			if (!isCurrent()) {
				return;
			}
			if (!song.flags.isScrobbled) {
				this.setMode(
					initiallyAllowed
						? ControllerMode.Loading
						: ControllerMode.Disallowed,
				);
			}

			const processed = await this.pipeline.process(
				song,
				this.connector.meta,
				isCurrent,
			);
			if (!processed || !isCurrent()) {
				return;
			}

			this.debugLog(`Song finished processing: ${song.toString()}`);
			song.flags.isMarkedAsPlaying = false;
			if (song.flags.isScrobbled) {
				this.onSongUpdated();
				return;
			}
			if (this.unconfirmedSubmissions.has(song)) {
				this.setMode(ControllerMode.Err);
				this.onSongUpdated();
				return;
			}
			await this.updateTimers(song);
			if (!isCurrent()) {
				return;
			}

			const isValid = song.isValid();
			const allowed = isValid && (await this.shouldScrobble(song));
			if (!isCurrent()) {
				return;
			}

			if (!isValid) {
				this.setSongNotRecognized();
			} else if (!allowed) {
				this.setMode(ControllerMode.Disallowed);
			} else if (!song.parsed.isPlaying) {
				this.setMode(ControllerMode.Base);
			} else if (this.shouldHaveScrobbled) {
				void this.scrobbleSong(song);
			} else if (this.playbackTimer.isExpired()) {
				this.dispatchEvent(ControllerEvents.SongNowPlaying);
			} else {
				void this.setSongNowPlaying(song);
			}
			this.onSongUpdated();
		} catch (error) {
			if (isCurrent()) {
				this.debugLog(`Song processing failed: ${error}`, 'warn');
				if (!song.flags.isScrobbled) {
					this.setMode(ControllerMode.Err);
				}
				this.onSongUpdated();
			}
		}
	}

	private isCurrentProcessing(song: Song, run: number): boolean {
		return (
			song === this.currentSong &&
			run === this.processingRun &&
			!song.flags.isSkipped
		);
	}

	/**
	 * Called when song was already flagged as processed, but now is
	 * entering the pipeline again.
	 */
	private unprocessSong(song: Song): void {
		this.debugLog(`Song unprocessed: ${song.toString()}`);

		const { isScrobbled, isReplaying, isLovedInService } = song.flags;
		const { startTimestamp, userloved, notificationId } = song.metadata;
		song.resetData();
		Object.assign(song.flags, {
			isScrobbled,
			isReplaying,
			isLovedInService,
		});
		Object.assign(song.metadata, {
			startTimestamp,
			userloved,
			notificationId,
		});

		if (!isScrobbled && !this.shouldHaveScrobbled) {
			this.playbackTimer.update(null);
		}
	}

	/**
	 * Called when playing state is changed.
	 * @param value - New playing state
	 */
	private async onPlayingStateChanged(value: boolean | null): Promise<void> {
		this.debugLog(`isPlaying state changed to ${String(value)}`);
		const song = this.currentSong;

		if (value && song) {
			this.setResumedPlaying();
			this.playbackTimer.resume();
			this.replayDetectionTimer.resume();

			const { isMarkedAsPlaying } = song.flags;

			// Maybe the song was not marked as playing yet
			if (
				(!isMarkedAsPlaying || this.shouldHaveScrobbled) &&
				song.isValid() &&
				(await this.shouldScrobble(song))
			) {
				void this.setSongNowPlaying(song);
			} else if (song === this.currentSong) {
				// Resend current mode
				this.onModeChanged();
			}
		} else {
			this.setPaused();
		}
	}

	/**
	 * Check if song is changed by given connector state.
	 * @param newState - Connector state
	 * @returns Check result
	 */
	private isSongChanged(newState: State): boolean {
		if (!assertSongNotNull(this.currentSong)) {
			return true;
		}

		for (const field of fieldsToCheckSongChange) {
			if (
				field in newState &&
				field in this.currentSong.parsed &&
				newState[field] !== this.currentSong.parsed[field]
			) {
				return true;
			}
		}

		return false;
	}

	/**
	 * Check if song duration should be updated.
	 * @param newState - Connector state
	 * @returns Check result
	 */
	private isNeedToUpdateDuration(newState: State): boolean {
		return (
			Boolean(newState.duration) &&
			this.currentSong?.parsed.duration !== newState.duration
		);
	}

	/**
	 * Update song duration value.
	 * @param duration - Duration in seconds
	 */
	private updateSongDuration(duration: number): void {
		const song = this.currentSong;
		if (!song) {
			return;
		}
		this.debugLog(`Update duration: ${duration}`);

		song.parsed.duration = duration;

		void this.updateTimers(song);
	}

	/**
	 * Update internal timers.
	 * @param song - Play whose duration determines the timer thresholds
	 */
	private async updateTimers(song: Song): Promise<void> {
		if (this.playbackTimer.isExpired()) {
			this.debugLog('Attempt to update expired timers', 'warn');
			return;
		}

		const run = this.processingRun;
		const rawPercent = await Options.getOption(
			Options.SCROBBLE_PERCENT,
			this.connector.meta.id,
		);
		if (
			!this.isCurrentProcessing(song, run) ||
			this.playbackTimer.isExpired()
		) {
			return;
		}
		const duration = song.getDuration();
		const percent = parseScrobblePercent(rawPercent);

		const secondsToScrobble = getSecondsToScrobble(duration, percent);

		if (secondsToScrobble !== -1) {
			this.playbackTimer.update(secondsToScrobble);
			this.replayDetectionTimer.update(duration);

			const remainedSeconds = this.playbackTimer.getRemainingSeconds();
			this.debugLog(
				`The song will be scrobbled in ${
					remainedSeconds ?? -999
				} seconds`,
			);
			this.debugLog(`The song will be repeated in ${duration} seconds`);
		} else {
			this.debugLog('The song is too short to scrobble');
		}
	}

	/**
	 * Contains all actions to be done when song is ready to be marked as
	 * now playing.
	 * @param song - Play to mark as now playing
	 */
	private async setSongNowPlaying(song = this.currentSong): Promise<void> {
		const run = this.processingRun;
		if (
			!song ||
			!this.isCurrentProcessing(song, run) ||
			!song.isValid() ||
			!(await this.shouldScrobble(song)) ||
			!this.isCurrentProcessing(song, run) ||
			song.flags.isScrobbled ||
			this.scrobblingSongs.has(song) ||
			this.unconfirmedSubmissions.has(song)
		) {
			return;
		}

		/**
		 * Sometimes a song may change state before processing is done.
		 * This can cause race condition especially with the blocked tags pipeline
		 * which decides whether a song should be allowed to be played asynchronously.
		 * For this reason we must check again here if the song is loading.
		 */
		if (!song.flags.finishedProcessing) {
			this.debugLog('Song set as loading');
			this.setMode(ControllerMode.Loading);
			return;
		}

		if (this.shouldHaveScrobbled) {
			// The timer already fired while this play was blocked. Recover the
			// scrobble itself, rather than only sending another Now Playing update.
			await this.scrobbleSong(song);
			return;
		}

		song.flags.isMarkedAsPlaying = true;

		const results = await sendContentMessage({
			type: 'setNowPlaying',
			payload: {
				song: song.getCloneableData(),
			},
		});

		if (!this.isCurrentProcessing(song, run) || song.flags.isScrobbled) {
			return;
		}
		if (isAnyResult(results, ServiceCallResult.RESULT_OK)) {
			this.debugLog('Song set as now playing');
			this.setMode(ControllerMode.Playing);
		} else {
			this.debugLog("Song isn't set as now playing");
			this.setMode(ControllerMode.Err);
		}

		this.dispatchEvent(ControllerEvents.SongNowPlaying);
	}

	private async setPaused(): Promise<void> {
		this.playbackTimer.pause();
		this.replayDetectionTimer.pause();

		const song = this.currentSong;
		const run = this.processingRun;
		if (
			!song ||
			!song.isValid() ||
			!(await this.shouldScrobble(song)) ||
			!this.isCurrentProcessing(song, run) ||
			song.parsed.isPlaying
		) {
			return;
		}

		this.isPaused = true;
		this.onModeChanged();
		await sendContentMessage({
			type: 'setPaused',
			payload: {
				song: song.getCloneableData(),
			},
		});
	}

	private async setResumedPlaying(): Promise<void> {
		this.isPaused = false;

		const song = this.currentSong;
		const run = this.processingRun;
		if (
			!song ||
			!song.isValid() ||
			!(await this.shouldScrobble(song)) ||
			!this.isCurrentProcessing(song, run) ||
			!song.parsed.isPlaying
		) {
			return;
		}

		this.onModeChanged();
		await sendContentMessage({
			type: 'setResumedPlaying',
			payload: {
				song: song.getCloneableData(),
			},
		});
	}

	/**
	 * Notify user that song it not recognized by the extension.
	 */
	private setSongNotRecognized(): void {
		this.setMode(ControllerMode.Unknown);
		this.dispatchEvent(ControllerEvents.SongUnrecognized);
	}

	/**
	 * Enable or disable a connector
	 *
	 * @param isEnabled - Whether to enable or disable connector.
	 */
	private setConnectorState(isEnabled: boolean) {
		this.setEnabled(isEnabled);
		Options.setConnectorEnabled(this.getConnector(), isEnabled);
	}

	/**
	 * Disable connector until tab is closed
	 */
	private async disableUntilTabIsClosed() {
		const disabledTabList = await disabledTabs.get();
		const currentTab = await this.tabId;
		disabledTabs.set({
			...disabledTabList,
			[currentTab ?? -1]: {
				...(disabledTabList?.[currentTab ?? -1] ?? {}),
				[this.connector.meta.id]: true,
			},
		});
		this.setEnabled(false);
	}

	/**
	 * Save a blocked or unrecognized play for recovery.
	 *
	 * @param song - Play whose listening threshold was reached
	 * @returns true if the play was blocked
	 */
	private async saveFailedScrobble(song: Song): Promise<boolean> {
		const allowed = await this.shouldScrobble(song);
		if (allowed && song.isValid()) {
			return false;
		}

		await this.cacheScrobble(
			song,
			allowed ? ScrobbleStatus.INVALID : ScrobbleStatus.DISALLOWED,
		);
		if (song === this.currentSong && !song.flags.isSkipped) {
			this.shouldHaveScrobbled = true;
		}
		return true;
	}

	private async cacheScrobble(
		song: Song,
		status: ScrobbleStatus,
	): Promise<void> {
		if (!this.scrobbleCacheIds.has(song)) {
			const id = await scrobbleCache.pushScrobble({
				song: song.getCloneableData(),
				status,
			});
			this.scrobbleCacheIds.set(song, id);
		}
	}

	/**
	 * Called when scrobble timer triggers.
	 * The time should be set only after the song is validated and ready
	 * to be scrobbled.
	 * @param song - Play to submit
	 */
	private async scrobbleSong(song = this.currentSong): Promise<void> {
		if (
			!song ||
			song !== this.currentSong ||
			song.flags.isSkipped ||
			song.flags.isScrobbled ||
			this.scrobblingSongs.has(song) ||
			this.unconfirmedSubmissions.has(song)
		) {
			return;
		}

		this.scrobblingSongs.add(song);
		try {
			if (await this.saveFailedScrobble(song)) {
				return;
			}

			if (this.isEditing) {
				await new Promise((resolve) => {
					const eventHandler = (isEditing: boolean) => {
						if (!isEditing) {
							this.eventEmitter.off(
								'updateEditStatus',
								eventHandler,
							);
							resolve(true);
						}
					};
					this.eventEmitter.on('updateEditStatus', eventHandler);
				});
			}
			if (song.flags.isSkipped) {
				return;
			}

			const currentlyPlaying = song === this.currentSong;
			if (currentlyPlaying) {
				this.shouldHaveScrobbled = false;
			}
			const [results] = await sendContentMessage({
				type: 'scrobble',
				payload: {
					songs: [song.getCloneableData()],
					currentlyPlaying,
				},
			});

			// The background has cached the submitted play's result. A failed
			// message leaves the original entry available for manual recovery.
			const cacheId = this.scrobbleCacheIds.get(song);
			if (cacheId !== undefined) {
				this.scrobbleCacheIds.delete(song);
				void scrobbleCache.deleteScrobbles([cacheId]).catch((error) => {
					this.debugLog(
						`Unable to remove recovered cache entry: ${error}`,
						'warn',
					);
				});
			}

			if (song !== this.currentSong || song.flags.isSkipped) {
				return;
			}
			if (isAnyResult(results, ServiceCallResult.RESULT_OK)) {
				this.debugLog('Scrobbled successfully');
				song.flags.isScrobbled = true;
				this.setMode(ControllerMode.Scrobbled);
				this.onSongUpdated();
			} else if (
				areAllResults(results, ServiceCallResult.RESULT_IGNORE)
			) {
				this.debugLog('Song is ignored by service');
				this.setMode(ControllerMode.Ignored);
			} else {
				this.debugLog('Scrobbling failed', 'warn');
				this.setMode(ControllerMode.Err);
			}
		} catch (error) {
			this.unconfirmedSubmissions.add(song);
			this.debugLog(`Scrobbling failed: ${error}`, 'warn');
			if (song === this.currentSong && !song.flags.isSkipped) {
				this.setMode(ControllerMode.Err);
			}
			try {
				// A lost reply can follow a successful submission. Keep the play
				// available for manual recovery without resending it automatically.
				await this.cacheScrobble(song, ScrobbleStatus.ERROR);
			} catch (cacheError) {
				this.debugLog(
					`Unable to cache failed scrobble: ${cacheError}`,
					'warn',
				);
			}
		} finally {
			this.scrobblingSongs.delete(song);
		}
	}

	/**
	 * Reset the state of the connector, removing currently playing song if there is one.
	 */
	private reset(): void {
		this.resetState();
		this.setMode(ControllerMode.Base);
	}

	/**
	 * Assert whether there is a song playing right now
	 */
	private assertSongIsPlaying(): Song {
		if (!this.currentSong) {
			throw new Error('No song is now playing');
		}
		return this.currentSong;
	}

	/**
	 * Print debug message prefixed with controller.
	 * @param text - Debug message
	 * @param logType - Log type
	 */
	private debugLog(text: string, logType: DebugLogType = 'log'): void {
		const message = `Controller: ${text}`;
		debugLog(message, logType);
	}
}

/**
 * Check if given connector state is empty.
 * @param state - Connector state
 * @returns Check result
 */
function isStateEmpty(state: State) {
	return !(state.artist && state.track) && !state.uniqueID && !state.duration;
}

/**
 * Get string representation of given object.
 * @param obj - Any object
 * @returns String value
 */
function toString(obj: Record<string, unknown>): string {
	return JSON.stringify(obj, null, 2);
}

function assertSongNotNull(song: Song | null): song is Song {
	if (!song) {
		return false;
	}
	return true;
}
