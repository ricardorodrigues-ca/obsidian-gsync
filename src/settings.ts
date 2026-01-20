export interface GSyncSettings {
	// OAuth Credentials
	clientId: string;
	clientSecret: string;

	// Authentication Tokens
	accessToken: string;
	refreshToken: string;
	tokenExpiry: number;

	// Sync configuration
	syncFolderId: string;
	syncFolderName: string;
	autoSync: boolean;
	autoSyncInterval: number; // in minutes

	// Sync behavior
	conflictResolution: 'local' | 'remote' | 'newer' | 'ask';
	syncOnStartup: boolean;
	syncOnSave: boolean;

	// File filters
	excludedFolders: string[];
	excludedExtensions: string[];
	includeHiddenFiles: boolean;

	// Advanced
	lastSyncTime: number;
	debugMode: boolean;
}

export const DEFAULT_SETTINGS: GSyncSettings = {
	clientId: '',
	clientSecret: '',

	accessToken: '',
	refreshToken: '',
	tokenExpiry: 0,

	syncFolderId: '',
	syncFolderName: 'ObsidianVault',
	autoSync: false,
	autoSyncInterval: 30,

	conflictResolution: 'newer',
	syncOnStartup: false,
	syncOnSave: false,

	excludedFolders: ['.obsidian', '.git', '.trash'],
	excludedExtensions: [],
	includeHiddenFiles: false,

	lastSyncTime: 0,
	debugMode: false,
};

export interface FileMetadata {
	path: string;
	name: string;
	mtime: number;
	size: number;
	isFolder: boolean;
	driveId?: string;
	driveMtime?: number;
	md5Checksum?: string;
}

export interface SyncStatus {
	status: 'idle' | 'syncing' | 'error' | 'authenticated' | 'unauthenticated';
	message: string;
	progress?: number;
	total?: number;
}

export interface ConflictInfo {
	localFile: FileMetadata;
	remoteFile: FileMetadata;
	path: string;
}
