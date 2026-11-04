import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ListenBrainzScrobbler from '@/core/scrobbler/listenbrainz/listenbrainz-scrobbler';
import { ServiceCallResult } from '@/core/object/service-call-result';

const storage = vi.hoisted(() => ({
	get: vi.fn(),
	set: vi.fn(),
	debugLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/core/storage/browser-storage', () => ({
	getScrobblerStorage: () => storage,
}));
vi.mock('@/util/communication', () => ({
	setupBackgroundListeners: vi.fn(),
	backgroundListener: vi.fn(),
	sendContentMessage: vi.fn(),
}));
vi.mock('webextension-polyfill', () => ({ default: {} }));

describe('ListenBrainz account checks', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		storage.get.mockResolvedValue(undefined);
		storage.set.mockResolvedValue(undefined);
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
	});
	afterEach(() => vi.restoreAllMocks());

	it('treats an unconfigured account as signed out without errors or storage writes', async () => {
		const scrobbler = new ListenBrainzScrobbler();
		const signOut = vi.spyOn(scrobbler, 'signOut');
		await expect(scrobbler.getSession()).rejects.toThrow(
			ServiceCallResult.ERROR_AUTH,
		);
		await expect(scrobbler.getProfileUrl()).rejects.toThrow(
			ServiceCallResult.ERROR_AUTH,
		);
		expect(console.error).not.toHaveBeenCalled();
		expect(signOut).not.toHaveBeenCalled();
		expect(storage.set).not.toHaveBeenCalled();
	});

	it('still rejects an empty account record as unauthenticated', async () => {
		storage.get.mockResolvedValue({});
		const scrobbler = new ListenBrainzScrobbler();
		await expect(scrobbler.getSession()).rejects.toThrow(
			ServiceCallResult.ERROR_AUTH,
		);
		expect(console.error).not.toHaveBeenCalled();
	});

	it('retains a saved session and its profile URL', async () => {
		storage.get.mockResolvedValue({
			sessionID: 'test-session',
			sessionName: 'listener',
		});
		const scrobbler = new ListenBrainzScrobbler();
		await expect(scrobbler.getSession()).resolves.toEqual({
			sessionID: 'test-session',
			sessionName: 'listener',
		});
		await expect(scrobbler.getProfileUrl()).resolves.toBe(
			'https://listenbrainz.org/user/listener',
		);
		expect(storage.set).not.toHaveBeenCalled();
	});

	it('retains support for a custom instance token', async () => {
		const scrobbler = new ListenBrainzScrobbler();
		scrobbler.userToken = 'test-instance-token';
		await expect(scrobbler.getSession()).resolves.toEqual({
			sessionID: 'test-instance-token',
		});
		expect(console.error).not.toHaveBeenCalled();
	});

	it('propagates actual storage read failures', async () => {
		const scrobbler = new ListenBrainzScrobbler();
		await Promise.resolve();
		const error = new Error('Storage read failed');
		storage.get.mockRejectedValueOnce(error);
		await expect(scrobbler.getSession()).rejects.toBe(error);
	});
});
