import { Plugin, Notice } from 'obsidian';
import { GSyncSettings, DEFAULT_SETTINGS, SyncStatus } from './settings';
import { GoogleAuthService } from './googleAuth';
import { GoogleDriveService } from './googleDrive';
import { SyncService } from './syncService';
import { GSyncSettingTab } from './settingsTab';

export default class GSyncPlugin extends Plugin {
	settings: GSyncSettings;
	authService: GoogleAuthService;
	driveService: GoogleDriveService;
	syncService: SyncService;

	private statusBarItem: HTMLElement | null = null;
	private ribbonIconEl: HTMLElement | null = null;
	private autoSyncInterval: number | null = null;

	async onload() {
		await this.loadSettings();

		// Initialize services
		this.authService = new GoogleAuthService(this);
		this.driveService = new GoogleDriveService(this);
		this.syncService = new SyncService(this);

		// Load saved OAuth credentials
		if (this.settings.clientId && this.settings.clientSecret) {
			this.authService.setCredentials({
				clientId: this.settings.clientId,
				clientSecret: this.settings.clientSecret,
			});
		}

		// Set up sync status callback
		this.syncService.onSyncStatusChange((status) => {
			this.updateStatusBar(status);
			this.updateRibbonIcon(status);
		});

		// Add ribbon icon
		this.ribbonIconEl = this.addRibbonIcon(
			'cloud',
			'Google Drive Sync',
			async () => {
				if (this.syncService.isSyncInProgress()) {
					new Notice('Sync already in progress');
					return;
				}

				if (!this.authService.isAuthenticated()) {
					new Notice('Please configure Google Drive authentication in settings');
					return;
				}

				await this.syncService.sync();
			}
		);
		this.ribbonIconEl.addClass('gsync-ribbon-icon');

		// Add status bar item
		this.statusBarItem = this.addStatusBarItem();
		this.statusBarItem.addClass('gsync-status-bar');
		this.updateStatusBar({ status: 'idle', message: 'Ready' });

		// Add settings tab
		this.addSettingTab(new GSyncSettingTab(this.app, this));

		// Add commands
		this.addCommand({
			id: 'gsync-sync-now',
			name: 'Sync Now',
			callback: async () => {
				if (!this.authService.isAuthenticated()) {
					new Notice('Please configure Google Drive authentication first');
					return;
				}
				await this.syncService.sync();
			},
		});

		this.addCommand({
			id: 'gsync-force-upload',
			name: 'Force Upload All',
			callback: async () => {
				if (!this.authService.isAuthenticated()) {
					new Notice('Please configure Google Drive authentication first');
					return;
				}

				// Reset sync time to force upload
				const originalTime = this.settings.lastSyncTime;
				this.settings.lastSyncTime = 0;

				new Notice('Starting full upload...');
				await this.syncService.sync();

				// Restore if sync failed
				if (this.settings.lastSyncTime === 0) {
					this.settings.lastSyncTime = originalTime;
				}
			},
		});

		this.addCommand({
			id: 'gsync-force-download',
			name: 'Force Download All',
			callback: async () => {
				if (!this.authService.isAuthenticated()) {
					new Notice('Please configure Google Drive authentication first');
					return;
				}

				new Notice('Force download not implemented yet - use Sync Now');
			},
		});

		this.addCommand({
			id: 'gsync-open-settings',
			name: 'Open Settings',
			callback: () => {
				// Open the settings tab
				const setting = (this.app as any).setting;
				setting.open();
				setting.openTabById('obsidian-gsync');
			},
		});

		// Start auto sync if enabled
		if (this.settings.autoSync && this.authService.isAuthenticated()) {
			this.startAutoSync();
		}

		// Sync on startup if enabled
		if (this.settings.syncOnStartup && this.authService.isAuthenticated()) {
			// Delay startup sync to let Obsidian fully load
			setTimeout(() => {
				this.syncService.sync();
			}, 5000);
		}

		console.log('GSync plugin loaded');
	}

	onunload() {
		this.stopAutoSync();
		console.log('GSync plugin unloaded');
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	startAutoSync() {
		this.stopAutoSync();

		const intervalMs = this.settings.autoSyncInterval * 60 * 1000;
		this.autoSyncInterval = window.setInterval(async () => {
			if (!this.syncService.isSyncInProgress() && this.authService.isAuthenticated()) {
				if (this.settings.debugMode) {
					console.log('Auto sync triggered');
				}
				await this.syncService.sync();
			}
		}, intervalMs);

		this.registerInterval(this.autoSyncInterval);
	}

	stopAutoSync() {
		if (this.autoSyncInterval !== null) {
			window.clearInterval(this.autoSyncInterval);
			this.autoSyncInterval = null;
		}
	}

	private updateStatusBar(status: SyncStatus) {
		if (!this.statusBarItem) return;

		let text = '';
		let title = '';

		switch (status.status) {
			case 'idle':
				text = 'GSync: Ready';
				title = status.message;
				break;
			case 'syncing':
				if (status.progress !== undefined && status.total !== undefined) {
					text = `GSync: ${status.progress}/${status.total}`;
				} else {
					text = 'GSync: Syncing...';
				}
				title = status.message;
				break;
			case 'error':
				text = 'GSync: Error';
				title = status.message;
				break;
			case 'authenticated':
				text = 'GSync: Connected';
				title = 'Connected to Google Drive';
				break;
			case 'unauthenticated':
				text = 'GSync: Not Connected';
				title = 'Click to configure';
				break;
		}

		this.statusBarItem.setText(text);
		this.statusBarItem.setAttr('title', title);

		// Remove all status classes
		this.statusBarItem.removeClass('gsync-status-idle');
		this.statusBarItem.removeClass('gsync-status-syncing');
		this.statusBarItem.removeClass('gsync-status-error');

		// Add current status class
		this.statusBarItem.addClass(`gsync-status-${status.status}`);
	}

	private updateRibbonIcon(status: SyncStatus) {
		if (!this.ribbonIconEl) return;

		// Remove all status classes
		this.ribbonIconEl.removeClass('gsync-syncing');
		this.ribbonIconEl.removeClass('gsync-error');

		if (status.status === 'syncing') {
			this.ribbonIconEl.addClass('gsync-syncing');
		} else if (status.status === 'error') {
			this.ribbonIconEl.addClass('gsync-error');
		}
	}
}
