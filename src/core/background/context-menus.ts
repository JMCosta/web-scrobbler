import browser from 'webextension-polyfill';

export const contextMenus = {
	ENABLE_CONNECTOR: 'enableConnector',
	DISABLE_CONNECTOR: 'disableConnector',
	DISABLE_UNTIL_CLOSED: 'disableUntilClosed',
	ENABLE_CHANNEL: 'enableChannel',
	DISABLE_CHANNEL: 'disableChannel',
};

let menusReady: Promise<void> | undefined;

/**
 * Create the action menus before updating them, including after a worker restart.
 * Concurrent startup and tab events share the same initialization.
 */
export function ensureContextMenus(): Promise<void> {
	const menus = browser.contextMenus;
	if (!menus) {
		return Promise.resolve();
	}
	if (!menusReady) {
		menusReady = (async () => {
			// Menus can outlive the worker, so replace the old entries once.
			await menus.removeAll();
			await Promise.all(
				Object.values(contextMenus).map(
					(id) =>
						new Promise<void>((resolve, reject) => {
							menus.create(
								{
									id,
									visible: false,
									contexts: ['action'],
									title: 'Error: You should not be seeing this',
								},
								() => {
									const error = browser.runtime.lastError;
									if (error) {
										reject(new Error(error.message));
									} else {
										resolve();
									}
								},
							);
						}),
				),
			);
		})().catch((error: unknown) => {
			menusReady = undefined;
			throw error;
		});
	}
	return menusReady;
}
