import { Notice, requestUrl, Platform } from 'obsidian';
import type GSyncPlugin from './main';

// Google OAuth 2.0 configuration
// Users need to create their own OAuth credentials at https://console.cloud.google.com/
const SCOPES = [
	'https://www.googleapis.com/auth/drive.file',
	'https://www.googleapis.com/auth/drive.appdata',
];

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// Use urn:ietf:wg:oauth:2.0:oob for manual code entry (works on all platforms)
// This is Google's out-of-band flow for devices that can't receive redirects
const REDIRECT_URI_OOB = 'urn:ietf:wg:oauth:2.0:oob';

export interface OAuthCredentials {
	clientId: string;
	clientSecret: string;
}

export class GoogleAuthService {
	private plugin: GSyncPlugin;
	private credentials: OAuthCredentials | null = null;
	private pendingAuthResolve: ((value: boolean) => void) | null = null;
	private codeVerifier: string | null = null;

	constructor(plugin: GSyncPlugin) {
		this.plugin = plugin;
	}

	setCredentials(credentials: OAuthCredentials) {
		this.credentials = credentials;
	}

	hasCredentials(): boolean {
		return this.credentials !== null &&
			this.credentials.clientId !== '' &&
			this.credentials.clientSecret !== '';
	}

	isAuthenticated(): boolean {
		return this.plugin.settings.accessToken !== '' &&
			this.plugin.settings.refreshToken !== '' &&
			Date.now() < this.plugin.settings.tokenExpiry;
	}

	async getValidAccessToken(): Promise<string | null> {
		if (!this.plugin.settings.accessToken) {
			return null;
		}

		// Check if token is expired or about to expire (5 minute buffer)
		if (Date.now() >= this.plugin.settings.tokenExpiry - 300000) {
			const refreshed = await this.refreshAccessToken();
			if (!refreshed) {
				return null;
			}
		}

		return this.plugin.settings.accessToken;
	}

	/**
	 * Generate a random code verifier for PKCE
	 */
	private generateCodeVerifier(): string {
		const array = new Uint8Array(32);
		crypto.getRandomValues(array);
		return this.base64UrlEncode(array);
	}

	/**
	 * Generate code challenge from verifier using SHA-256
	 */
	private async generateCodeChallenge(verifier: string): Promise<string> {
		const encoder = new TextEncoder();
		const data = encoder.encode(verifier);
		const digest = await crypto.subtle.digest('SHA-256', data);
		return this.base64UrlEncode(new Uint8Array(digest));
	}

	/**
	 * Base64 URL encode (RFC 4648)
	 */
	private base64UrlEncode(buffer: Uint8Array): string {
		let binary = '';
		for (let i = 0; i < buffer.byteLength; i++) {
			binary += String.fromCharCode(buffer[i]!);
		}
		return btoa(binary)
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/, '');
	}

	/**
	 * Start the OAuth flow - opens browser for authentication
	 * Returns the auth URL for the user to visit
	 */
	async startAuthFlow(): Promise<string | null> {
		if (!this.credentials) {
			new Notice('Please configure your Google OAuth credentials first');
			return null;
		}

		// Generate PKCE code verifier and challenge
		this.codeVerifier = this.generateCodeVerifier();
		const codeChallenge = await this.generateCodeChallenge(this.codeVerifier);

		const authUrl = this.buildAuthUrl(codeChallenge);

		// Open URL in browser
		window.open(authUrl);

		new Notice('Opening Google sign-in page. Copy the authorization code after signing in.');

		return authUrl;
	}

	/**
	 * Complete the auth flow by exchanging the authorization code for tokens
	 */
	async completeAuthFlow(code: string): Promise<boolean> {
		if (!this.credentials) {
			new Notice('Please configure your Google OAuth credentials first');
			return false;
		}

		if (!this.codeVerifier) {
			new Notice('Please start the authentication flow first');
			return false;
		}

		try {
			await this.exchangeCodeForTokens(code, this.codeVerifier);
			this.codeVerifier = null;
			return true;
		} catch (error) {
			console.error('Auth flow error:', error);
			new Notice('Authentication failed. Please try again.');
			this.codeVerifier = null;
			return false;
		}
	}

	private buildAuthUrl(codeChallenge: string): string {
		const params = new URLSearchParams({
			client_id: this.credentials!.clientId,
			redirect_uri: REDIRECT_URI_OOB,
			response_type: 'code',
			scope: SCOPES.join(' '),
			access_type: 'offline',
			prompt: 'consent',
			code_challenge: codeChallenge,
			code_challenge_method: 'S256',
		});

		return `${GOOGLE_AUTH_URL}?${params.toString()}`;
	}

	private async exchangeCodeForTokens(code: string, codeVerifier: string): Promise<void> {
		const response = await requestUrl({
			url: GOOGLE_TOKEN_URL,
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: new URLSearchParams({
				client_id: this.credentials!.clientId,
				client_secret: this.credentials!.clientSecret,
				code: code,
				grant_type: 'authorization_code',
				redirect_uri: REDIRECT_URI_OOB,
				code_verifier: codeVerifier,
			}).toString(),
		});

		if (response.status !== 200) {
			console.error('Token exchange failed:', response.status, response.text);
			throw new Error('Failed to exchange code for tokens');
		}

		const data = response.json;
		this.plugin.settings.accessToken = data.access_token;
		this.plugin.settings.refreshToken = data.refresh_token || this.plugin.settings.refreshToken;
		this.plugin.settings.tokenExpiry = Date.now() + (data.expires_in * 1000);
		await this.plugin.saveSettings();

		new Notice('Successfully connected to Google Drive!');
	}

	async refreshAccessToken(): Promise<boolean> {
		if (!this.credentials || !this.plugin.settings.refreshToken) {
			return false;
		}

		try {
			const response = await requestUrl({
				url: GOOGLE_TOKEN_URL,
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams({
					client_id: this.credentials.clientId,
					client_secret: this.credentials.clientSecret,
					refresh_token: this.plugin.settings.refreshToken,
					grant_type: 'refresh_token',
				}).toString(),
			});

			if (response.status !== 200) {
				return false;
			}

			const data = response.json;
			this.plugin.settings.accessToken = data.access_token;
			this.plugin.settings.tokenExpiry = Date.now() + (data.expires_in * 1000);
			await this.plugin.saveSettings();

			return true;
		} catch (error) {
			console.error('Failed to refresh access token:', error);
			return false;
		}
	}

	async revokeAccess(): Promise<void> {
		if (this.plugin.settings.accessToken) {
			try {
				await requestUrl({
					url: `https://oauth2.googleapis.com/revoke?token=${this.plugin.settings.accessToken}`,
					method: 'POST',
				});
			} catch (error) {
				// Ignore errors during revocation
			}
		}

		this.plugin.settings.accessToken = '';
		this.plugin.settings.refreshToken = '';
		this.plugin.settings.tokenExpiry = 0;
		this.plugin.settings.syncFolderId = '';
		await this.plugin.saveSettings();

		new Notice('Disconnected from Google Drive');
	}
}
