import { Notice, requestUrl } from 'obsidian';
import type GSyncPlugin from './main';

// Google OAuth 2.0 configuration
// Users need to create their own OAuth credentials at https://console.cloud.google.com/
const SCOPES = [
	'https://www.googleapis.com/auth/drive.file',
	'https://www.googleapis.com/auth/drive.appdata',
];

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export interface OAuthCredentials {
	clientId: string;
	clientSecret: string;
}

export class GoogleAuthService {
	private plugin: GSyncPlugin;
	private credentials: OAuthCredentials | null = null;
	private localServer: any = null;
	private redirectUri = 'http://localhost:42813/callback';

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

	async startAuthFlow(): Promise<boolean> {
		if (!this.credentials) {
			new Notice('Please configure your Google OAuth credentials first');
			return false;
		}

		return new Promise((resolve) => {
			// Create a simple HTTP server to receive the OAuth callback
			const http = require('http');
			const url = require('url');

			if (this.localServer) {
				this.localServer.close();
			}

			this.localServer = http.createServer(async (req: any, res: any) => {
				const parsedUrl = url.parse(req.url, true);

				if (parsedUrl.pathname === '/callback') {
					const code = parsedUrl.query.code;
					const error = parsedUrl.query.error;

					if (error) {
						res.writeHead(200, { 'Content-Type': 'text/html' });
						res.end(`
							<html>
								<body style="font-family: sans-serif; text-align: center; padding-top: 50px;">
									<h2>Authentication Failed</h2>
									<p>Error: ${error}</p>
									<p>You can close this window.</p>
								</body>
							</html>
						`);
						this.localServer.close();
						resolve(false);
						return;
					}

					if (code) {
						try {
							await this.exchangeCodeForTokens(code as string);
							res.writeHead(200, { 'Content-Type': 'text/html' });
							res.end(`
								<html>
									<body style="font-family: sans-serif; text-align: center; padding-top: 50px;">
										<h2>Authentication Successful!</h2>
										<p>You can close this window and return to Obsidian.</p>
									</body>
								</html>
							`);
							this.localServer.close();
							resolve(true);
						} catch (err) {
							res.writeHead(200, { 'Content-Type': 'text/html' });
							res.end(`
								<html>
									<body style="font-family: sans-serif; text-align: center; padding-top: 50px;">
										<h2>Authentication Failed</h2>
										<p>Error exchanging code for tokens.</p>
										<p>You can close this window.</p>
									</body>
								</html>
							`);
							this.localServer.close();
							resolve(false);
						}
					}
				}
			});

			this.localServer.listen(42813, () => {
				// Open the Google OAuth URL in the default browser
				const authUrl = this.buildAuthUrl();
				require('electron').shell.openExternal(authUrl);
				new Notice('Opening Google sign-in page in your browser...');
			});

			this.localServer.on('error', (err: any) => {
				console.error('Auth server error:', err);
				new Notice('Failed to start authentication server. Port 42813 may be in use.');
				resolve(false);
			});

			// Timeout after 5 minutes
			setTimeout(() => {
				if (this.localServer) {
					this.localServer.close();
					resolve(false);
				}
			}, 300000);
		});
	}

	private buildAuthUrl(): string {
		const params = new URLSearchParams({
			client_id: this.credentials!.clientId,
			redirect_uri: this.redirectUri,
			response_type: 'code',
			scope: SCOPES.join(' '),
			access_type: 'offline',
			prompt: 'consent',
		});

		return `${GOOGLE_AUTH_URL}?${params.toString()}`;
	}

	private async exchangeCodeForTokens(code: string): Promise<void> {
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
				redirect_uri: this.redirectUri,
			}).toString(),
		});

		if (response.status !== 200) {
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
