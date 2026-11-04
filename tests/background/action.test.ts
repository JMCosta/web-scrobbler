import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type browser from 'webextension-polyfill';
import type { ManagerTab } from '@/core/storage/wrapper';
import * as ControllerMode from '@/core/object/controller/controller-mode';

const mocks = vi.hoisted(() => {
	const menus = {
		create: vi.fn(),
		removeAll: vi.fn(),
		update: vi.fn(),
	};
	return {
		menus,
		items: new Map<string, browser.Menus.UpdateUpdatePropertiesType>(),
		browser: {
			contextMenus: menus as typeof menus | undefined,
			runtime: {
				lastError: undefined as { message: string } | undefined,
				getURL: (path: string) => `chrome-extension://test/${path}`,
			},
			tabs: { get: vi.fn() },
			action: { setIcon: vi.fn(), setTitle: vi.fn() },
			notifications: {},
		},
		getChannelDetails: vi.fn(),
		getChannelBlocklistLabel: vi.fn(),
		sendPopupMessage: vi.fn(),
	};
});

vi.mock('webextension-polyfill', () => ({ default: mocks.browser }));
vi.mock('@/core/background/util', () => ({
	getBrowserPreferredTheme: async () => 'light',
	getChannelDetails: mocks.getChannelDetails,
	getChannelBlocklistLabel: mocks.getChannelBlocklistLabel,
}));
vi.mock('@/util/communication', () => ({
	sendPopupMessage: mocks.sendPopupMessage,
}));
vi.mock('@/util/util-connector', () => ({
	getConnectorByUrl: async () => ({ id: 'YouTube', label: 'YouTube' }),
}));
vi.mock('@/util/i18n', () => ({
	t: (key: string, substitution?: string) => `${key}:${substitution ?? ''}`,
}));

describe('Action context menus', () => {
	let performUpdateAction: typeof import('@/core/background/action').performUpdateAction;
	let createItem: (
		properties: browser.Menus.CreateCreatePropertiesType,
		callback: () => void,
	) => string;
	const tab = (
		mode: ManagerTab['mode'] = ControllerMode.Unsupported,
	): ManagerTab => ({
		tabId: 1,
		mode,
		permanentMode: mode,
		song: null,
	});

	beforeEach(async () => {
		vi.resetModules();
		vi.clearAllMocks();
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		mocks.items.clear();
		mocks.browser.contextMenus = mocks.menus;
		mocks.browser.runtime.lastError = undefined;
		mocks.sendPopupMessage.mockResolvedValue(undefined);
		mocks.menus.removeAll.mockImplementation(async () =>
			mocks.items.clear(),
		);
		createItem = (properties, callback) => {
			queueMicrotask(() => {
				if (mocks.items.has(String(properties.id))) {
					mocks.browser.runtime.lastError = {
						message: 'Duplicate menu ID',
					};
				} else {
					mocks.items.set(String(properties.id), { ...properties });
				}
				callback();
				mocks.browser.runtime.lastError = undefined;
			});
			return String(properties.id);
		};
		mocks.menus.create.mockImplementation(createItem);
		mocks.menus.update.mockImplementation(
			async (id: string, properties) => {
				if (!mocks.items.has(id)) {
					throw new Error(`Cannot find menu item with id ${id}`);
				}
				mocks.items.set(id, { ...mocks.items.get(id), ...properties });
			},
		);
		mocks.browser.tabs.get.mockResolvedValue({
			url: 'https://youtube.com/watch?v=test',
		});
		mocks.browser.action.setIcon.mockResolvedValue(undefined);
		mocks.browser.action.setTitle.mockResolvedValue(undefined);
		mocks.getChannelDetails.mockResolvedValue(null);
		mocks.getChannelBlocklistLabel.mockResolvedValue(null);
		({ performUpdateAction } = await import('@/core/background/action'));
	});

	afterEach(() => vi.restoreAllMocks());

	it('creates all missing menus before updating a newly installed extension', async () => {
		await performUpdateAction(tab());
		expect(mocks.menus.create).toHaveBeenCalledTimes(5);
		expect(mocks.menus.update).toHaveBeenCalledTimes(5);
		expect(
			[...mocks.items.values()].every((item) => item.visible === false),
		).toBe(true);
		expect(console.warn).not.toHaveBeenCalled();
	});

	it('waits for asynchronous menu creation while still updating the icon', async () => {
		const complete: (() => void)[] = [];
		mocks.menus.create.mockImplementation((properties, callback) => {
			complete.push(() => {
				mocks.items.set(properties.id, { ...properties });
				callback();
			});
			return properties.id;
		});
		const pending = performUpdateAction(tab());
		await vi.waitFor(() => expect(complete).toHaveLength(5));
		expect(mocks.menus.update).not.toHaveBeenCalled();
		expect(mocks.browser.action.setIcon).toHaveBeenCalledOnce();
		complete.forEach((callback) => callback());
		await pending;
		expect(mocks.menus.update).toHaveBeenCalledTimes(5);
	});

	it('shares initialization between simultaneous tab and startup updates', async () => {
		const { ensureContextMenus } = await import(
			'@/core/background/context-menus'
		);
		await Promise.all([
			ensureContextMenus(),
			performUpdateAction(tab()),
			performUpdateAction(tab()),
		]);
		expect(mocks.menus.removeAll).toHaveBeenCalledOnce();
		expect(mocks.menus.create).toHaveBeenCalledTimes(5);
		expect(console.warn).not.toHaveBeenCalled();
	});

	it('recreates persisted menu IDs once when the service worker restarts', async () => {
		await performUpdateAction(tab());
		vi.resetModules();
		({ performUpdateAction } = await import('@/core/background/action'));
		await performUpdateAction(tab());
		expect(mocks.menus.removeAll).toHaveBeenCalledTimes(2);
		expect(mocks.menus.create).toHaveBeenCalledTimes(10);
		expect(console.warn).not.toHaveBeenCalled();
	});

	it('shows only the enable action for a disabled connector', async () => {
		await performUpdateAction(tab(ControllerMode.Disabled));
		expect(mocks.items.get('enableConnector')).toMatchObject({
			visible: true,
			title: 'menuEnableConnector:YouTube',
		});
		expect(mocks.items.get('disableConnector')?.visible).toBe(false);
		expect(mocks.items.get('disableUntilClosed')?.visible).toBe(false);
		expect(mocks.items.get('disableChannel')?.visible).toBe(false);
		expect(mocks.items.get('enableChannel')?.visible).toBe(false);
	});

	it.each([false, true])(
		'preserves channel controls when blocked=%s',
		async (blocked) => {
			mocks.getChannelDetails.mockResolvedValue({
				channelInfo: { id: 'channel', label: 'Artist' },
				connector: { id: 'YouTube' },
			});
			mocks.getChannelBlocklistLabel.mockResolvedValue(
				blocked ? 'Artist' : null,
			);
			await performUpdateAction(tab(ControllerMode.Playing));
			expect(mocks.items.get('disableConnector')?.visible).toBe(true);
			expect(mocks.items.get('disableUntilClosed')?.visible).toBe(true);
			expect(mocks.items.get('enableChannel')?.visible).toBe(blocked);
			expect(mocks.items.get('disableChannel')?.visible).toBe(!blocked);
		},
	);

	it('supports browsers without the context menu API', async () => {
		mocks.browser.contextMenus = undefined;
		await performUpdateAction(tab());
		expect(mocks.menus.create).not.toHaveBeenCalled();
		expect(mocks.menus.update).not.toHaveBeenCalled();
		expect(mocks.browser.action.setIcon).toHaveBeenCalledOnce();
	});

	it('handles creation errors and retries initialization on the next update', async () => {
		mocks.menus.create.mockImplementationOnce((_properties, callback) => {
			mocks.browser.runtime.lastError = {
				message: 'Menu creation failed',
			};
			callback();
			mocks.browser.runtime.lastError = undefined;
			return 'enableConnector';
		});
		await expect(performUpdateAction(tab())).resolves.toBeUndefined();
		expect(mocks.menus.update).not.toHaveBeenCalled();
		expect(console.warn).toHaveBeenCalledWith(
			'Unable to update extension context menus',
			expect.objectContaining({ message: 'Menu creation failed' }),
		);
		await performUpdateAction(tab());
		expect(mocks.menus.removeAll).toHaveBeenCalledTimes(2);
		expect(mocks.menus.update).toHaveBeenCalledTimes(5);
	});

	it('handles rejected menu updates without preventing icon and title updates', async () => {
		mocks.menus.update.mockRejectedValueOnce(
			new Error('Menu update failed'),
		);
		await expect(performUpdateAction(tab())).resolves.toBeUndefined();
		expect(console.warn).toHaveBeenCalledWith(
			'Unable to update extension context menus',
			expect.objectContaining({ message: 'Menu update failed' }),
		);
		expect(mocks.browser.action.setIcon).toHaveBeenCalledOnce();
		expect(mocks.browser.action.setTitle).toHaveBeenCalledOnce();
	});
});
