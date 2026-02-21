<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { getClerkInstance, resolveClientSession, type ClientSessionUser } from '$lib/client/auth';

	type Theme = 'raven' | 'light';
	type Provider = 'koboldcpp' | 'openrouter';
	type Role = 'base' | 'vip' | 'dev';
	type AuthView = 'sign-in' | 'sign-up';
	const APP_NAME = 'Raven';
	const RAVEN_ICON_PATH = '/raven/logo-cutout.png';
	const COMPOSER_MIN_HEIGHT = 44;
	const COMPOSER_MAX_HEIGHT = 220;
	const MAX_PERSONALIZATION_CHARS = 1_200;
	const MAX_MEMORY_ENTRIES = 20;
	const MAX_MEMORY_ENTRY_CHARS = 280;
	const THINKING_HINTS = [
		'Thinking...',
		'Cooking up a reply...',
		'Assembling thoughts...',
		'Brewing an answer...',
		'Give me a sec...'
	];

	interface ChatMessage {
		role: 'user' | 'assistant';
		content: string;
		attachments?: string[];
	}

	interface ChatThread {
		id: string;
		title: string;
		createdAt: string;
		updatedAt: string;
	}

	interface QuotaInfo {
		allowed: boolean;
		role: Role;
		used: number;
		limit: number;
		remaining: number;
	}

	interface SessionData {
		accessToken: string;
		user: ClientSessionUser;
		isAdmin: boolean;
	}

	interface MemoryEntry {
		id: number;
		text: string;
		createdAt: string;
		updatedAt?: string;
		source?: 'manual' | 'auto';
		kind?: 'preference' | 'profile' | 'project' | 'other';
		confidence?: number;
	}

	let theme: Theme = 'raven';
	let provider: Provider = 'koboldcpp';
	let userRole: Role = 'base';

	let isMobileView = false;
	let desktopSidebarOpen = true;
	let mobileSidebarOpen = false;

	let prompt = '';
	let reasoningEnabled = false;
	let selectedFiles: File[] = [];
	let fileInput: HTMLInputElement | null = null;
	let composerTextarea: HTMLTextAreaElement | null = null;

	let session: SessionData | null = null;
	let clerkSignedIn = false;
	let clerkProfileName: string | null = null;
	let clerkProfileEmail: string | null = null;
	let removeClerkListener: (() => void) | null = null;
	let authReady = false;
	let authMessage = '';
	let activeAuthView: AuthView = 'sign-in';
	let authContainer: HTMLDivElement | null = null;
	let mountedAuthView: AuthView | null = null;
	let mountedAuthTheme: Theme | null = null;

	let isSending = false;
	let thinkingHint = THINKING_HINTS[0];
	let errorMessage = '';
	let messages: ChatMessage[] = [];
	let quota: QuotaInfo | null = null;

	let chatThreads: ChatThread[] = [];
	let currentThreadId: string | null = null;
	let isLoadingThreads = false;
	let isLoadingThreadMessages = false;
	let renamingThreadId: string | null = null;
	let renameDraftTitle = '';

	let accountSettingsOpen = false;
	let personalizationGuidance = '';
	let memoryEnabled = true;
	let autoMemoryEnabled = true;
	let memoryEntries: MemoryEntry[] = [];
	let newMemoryText = '';
	let settingsStorageAvailable = true;
	let isLoadingSettings = false;
	let isSavingSettings = false;

	function applyTheme(nextTheme: Theme) {
		theme = nextTheme;
		document.documentElement.setAttribute('data-theme', nextTheme);
		localStorage.setItem('raven-theme', nextTheme);
	}

	function toggleTheme() {
		applyTheme(theme === 'raven' ? 'light' : 'raven');
		if (!session && !clerkSignedIn && authReady) {
			void mountAuthView();
		}
	}

	function toggleReasoning() {
		reasoningEnabled = !reasoningEnabled;
		localStorage.setItem('raven-reasoning-enabled', reasoningEnabled ? 'true' : 'false');
	}

	async function syncComposerHeight() {
		await tick();
		if (!composerTextarea) {
			return;
		}

		composerTextarea.style.height = '0px';
		const scrollHeight = composerTextarea.scrollHeight;
		const nextHeight = Math.min(Math.max(scrollHeight, COMPOSER_MIN_HEIGHT), COMPOSER_MAX_HEIGHT);
		composerTextarea.style.height = `${nextHeight}px`;
		composerTextarea.style.overflowY = scrollHeight > COMPOSER_MAX_HEIGHT ? 'auto' : 'hidden';
	}

	function openSidebar() {
		if (isMobileView) {
			mobileSidebarOpen = true;
			return;
		}

		desktopSidebarOpen = true;
	}

	function closeSidebar() {
		if (isMobileView) {
			mobileSidebarOpen = false;
			return;
		}

		desktopSidebarOpen = false;
	}

	function triggerUpload() {
		fileInput?.click();
	}

	function handleFileChange(event: Event) {
		const target = event.currentTarget as HTMLInputElement;
		if (!target.files) {
			return;
		}

		selectedFiles = Array.from(target.files).filter((file) =>
			['text/plain', 'application/pdf'].includes(file.type) || /\.(txt|pdf)$/i.test(file.name)
		);
	}

	function removeFile(fileName: string) {
		selectedFiles = selectedFiles.filter((file) => file.name !== fileName);
	}

	function clearComposerFiles() {
		selectedFiles = [];
		if (fileInput) {
			fileInput.value = '';
		}
	}

	function startNewChat() {
		currentThreadId = null;
		messages = [];
		prompt = '';
		errorMessage = '';
		cancelThreadRename();
		clearComposerFiles();
		void syncComposerHeight();
	}

	function clearSessionState() {
		session = null;
		userRole = 'base';
		quota = null;
		chatThreads = [];
		accountSettingsOpen = false;
		personalizationGuidance = '';
		memoryEnabled = true;
		autoMemoryEnabled = true;
		memoryEntries = [];
		newMemoryText = '';
		settingsStorageAvailable = true;
		isLoadingSettings = false;
		isSavingSettings = false;
		renamingThreadId = null;
		renameDraftTitle = '';
		startNewChat();
	}

	function normalizeMemoryText(value: string): string {
		return value.trim().replace(/\s+/g, ' ').slice(0, MAX_MEMORY_ENTRY_CHARS);
	}

	function parseMemoryEntries(value: unknown): MemoryEntry[] {
		if (!Array.isArray(value)) {
			return [];
		}

		return value
			.map((item): MemoryEntry | null => {
				if (!item || typeof item !== 'object') {
					return null;
				}

				const record = item as Record<string, unknown>;
				const rawText =
					typeof record.content === 'string'
						? record.content
						: typeof record.text === 'string'
							? record.text
							: '';
				const text = normalizeMemoryText(rawText);
				if (!text) {
					return null;
				}

				const idCandidate =
					typeof record.id === 'number' ? record.id : Number.parseInt(String(record.id ?? ''), 10);
				if (!Number.isInteger(idCandidate) || idCandidate <= 0) {
					return null;
				}

				const createdAtCandidate =
					typeof record.createdAt === 'string' ? record.createdAt.trim() : new Date().toISOString();
				const updatedAtCandidate =
					typeof record.updatedAt === 'string' ? record.updatedAt.trim() : undefined;
				const source =
					record.source === 'auto' || record.source === 'manual'
						? record.source
						: undefined;
				const kind =
					record.kind === 'preference' ||
					record.kind === 'profile' ||
					record.kind === 'project' ||
					record.kind === 'other'
						? record.kind
						: undefined;
				const rawConfidence =
					typeof record.confidence === 'number' ? record.confidence : Number(record.confidence ?? NaN);
				const confidence = Number.isFinite(rawConfidence)
					? Math.min(Math.max(rawConfidence, 0), 1)
					: undefined;
				const entry: MemoryEntry = {
					id: idCandidate,
					text,
					createdAt: createdAtCandidate
				};
				if (updatedAtCandidate) {
					entry.updatedAt = updatedAtCandidate;
				}
				if (source) {
					entry.source = source;
				}
				if (kind) {
					entry.kind = kind;
				}
				if (typeof confidence === 'number') {
					entry.confidence = confidence;
				}
				return entry;
			})
			.filter((entry): entry is MemoryEntry => entry !== null)
			.slice(0, MAX_MEMORY_ENTRIES);
	}

	function parseSettingsRecord(value: unknown): {
		personalizationGuidance: string;
		memoryEnabled: boolean;
		autoMemoryEnabled: boolean;
	} | null {
		if (!value || typeof value !== 'object') {
			return null;
		}

		const record = value as Record<string, unknown>;
		const guidance =
			typeof record.personalizationGuidance === 'string'
				? record.personalizationGuidance.slice(0, MAX_PERSONALIZATION_CHARS)
				: '';
		const nextMemoryEnabled = record.memoryEnabled !== false;
		const nextAutoMemoryEnabled = record.autoMemoryEnabled !== false;

		return {
			personalizationGuidance: guidance,
			memoryEnabled: nextMemoryEnabled,
			autoMemoryEnabled: nextAutoMemoryEnabled
		};
	}

	async function loadAccountSettings(showErrors = false) {
		if (!session) {
			return;
		}

		isLoadingSettings = true;
		try {
			const response = await authorizedFetch('/api/settings');
			if (!response) {
				return;
			}

			const payload = await response.json();
			if (response.status === 401) {
				clearSessionState();
				authMessage = 'Session expired. Please sign in again.';
				return;
			}

			if (!response.ok) {
				throw new Error(payload?.error ?? 'Failed to load account settings.');
			}

			const settings = parseSettingsRecord(payload?.settings);
			personalizationGuidance = settings?.personalizationGuidance ?? '';
			memoryEnabled = settings?.memoryEnabled ?? true;
			autoMemoryEnabled = settings?.autoMemoryEnabled ?? true;
			memoryEntries = parseMemoryEntries(payload?.memories);
			settingsStorageAvailable = payload?.storageAvailable !== false;
			if (payload?.warning && !settingsStorageAvailable) {
				errorMessage = String(payload.warning);
			}
		} catch (error) {
			console.error(error);
			if (showErrors) {
				errorMessage =
					error instanceof Error ? error.message : 'Failed to load personalization and memory settings.';
			}
		} finally {
			isLoadingSettings = false;
		}
	}

	async function saveSettings(): Promise<boolean> {
		if (!session) {
			return false;
		}

		isSavingSettings = true;
		try {
			const response = await authorizedFetch('/api/settings', {
				method: 'PATCH',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					personalizationGuidance: personalizationGuidance.slice(0, MAX_PERSONALIZATION_CHARS),
					memoryEnabled,
					autoMemoryEnabled
				})
			});
			if (!response) {
				return false;
			}

			const payload = await response.json();
			if (response.status === 401) {
				clearSessionState();
				authMessage = 'Session expired. Please sign in again.';
				return false;
			}

			if (!response.ok) {
				throw new Error(payload?.error ?? 'Failed to save account settings.');
			}

			const settings = parseSettingsRecord(payload?.settings);
			personalizationGuidance = settings?.personalizationGuidance ?? personalizationGuidance;
			memoryEnabled = settings?.memoryEnabled ?? memoryEnabled;
			autoMemoryEnabled = settings?.autoMemoryEnabled ?? autoMemoryEnabled;
			settingsStorageAvailable = payload?.storageAvailable !== false;
			return true;
		} catch (error) {
			console.error(error);
			errorMessage =
				error instanceof Error ? error.message : 'Failed to save personalization and memory settings.';
			return false;
		} finally {
			isSavingSettings = false;
		}
	}

	async function saveSettingsAndClose() {
		const saved = await saveSettings();
		if (saved) {
			closeAccountSettings();
		}
	}

	function openAccountSettings() {
		accountSettingsOpen = true;
		void loadAccountSettings(true);
	}

	function closeAccountSettings() {
		accountSettingsOpen = false;
		newMemoryText = '';
	}

	async function addMemoryEntry() {
		if (!session) {
			return;
		}

		const text = normalizeMemoryText(newMemoryText);
		if (!text) {
			return;
		}

		try {
			const response = await authorizedFetch('/api/settings/memory', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({ content: text })
			});
			if (!response) {
				return;
			}

			const payload = await response.json();
			if (response.status === 401) {
				clearSessionState();
				authMessage = 'Session expired. Please sign in again.';
				return;
			}

			if (!response.ok) {
				throw new Error(payload?.error ?? 'Failed to save memory.');
			}

			const created = parseMemoryEntries([payload?.memory])[0];
			if (created) {
				memoryEntries = [created, ...memoryEntries.filter((entry) => entry.id !== created.id)].slice(
					0,
					MAX_MEMORY_ENTRIES
				);
			} else {
				await loadAccountSettings();
			}
			settingsStorageAvailable = payload?.storageAvailable !== false;
			newMemoryText = '';
		} catch (error) {
			console.error(error);
			errorMessage = error instanceof Error ? error.message : 'Failed to save memory.';
		}
	}

	async function deleteMemoryEntry(memoryId: number) {
		if (!session) {
			return;
		}

		try {
			const response = await authorizedFetch(`/api/settings/memory/${memoryId}`, {
				method: 'DELETE'
			});
			if (!response) {
				return;
			}

			const payload = await response.json();
			if (response.status === 401) {
				clearSessionState();
				authMessage = 'Session expired. Please sign in again.';
				return;
			}

			if (!response.ok) {
				throw new Error(payload?.error ?? 'Failed to delete memory.');
			}

			memoryEntries = memoryEntries.filter((entry) => entry.id !== memoryId);
			settingsStorageAvailable = payload?.storageAvailable !== false;
		} catch (error) {
			console.error(error);
			errorMessage = error instanceof Error ? error.message : 'Failed to delete memory.';
		}
	}

	function startThreadRename(thread: ChatThread) {
		renamingThreadId = thread.id;
		renameDraftTitle = thread.title;
	}

	function cancelThreadRename() {
		renamingThreadId = null;
		renameDraftTitle = '';
	}

	function pickThinkingHint(): string {
		const index = Math.floor(Math.random() * THINKING_HINTS.length);
		return THINKING_HINTS[index] ?? THINKING_HINTS[0];
	}

	function withAuthorizationHeader(headers: HeadersInit | undefined, accessToken: string): Headers {
		const merged = new Headers(headers ?? {});
		merged.set('Authorization', `Bearer ${accessToken}`);
		return merged;
	}

	function normalizeTextValue(value: unknown): string | null {
		if (typeof value !== 'string') {
			return null;
		}

		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : null;
	}

	function isGenericUserLabel(value: string | null): boolean {
		if (!value) {
			return true;
		}

		const normalized = value.trim().toLowerCase();
		return normalized === 'user' || normalized === 'unknown' || normalized === 'guest';
	}

	function stripThinkingArtifacts(text: string): string {
		const original = text.trim();
		if (!original) {
			return '';
		}

		const cleaned = original
			.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
			.replace(/<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi, '')
			.replace(/<\/?think\b[^>]*>/gi, '')
			.replace(/<\/?thinking\b[^>]*>/gi, '')
			.replace(/\n{3,}/g, '\n\n')
			.trim();

		return cleaned.length > 0 ? cleaned : original;
	}

	function toRecord(value: unknown): Record<string, unknown> | null {
		return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
	}

	function readStringFromRecord(record: Record<string, unknown> | null, keys: string[]): string | null {
		if (!record) {
			return null;
		}

		for (const key of keys) {
			const candidate = normalizeTextValue(record[key]);
			if (candidate) {
				return candidate;
			}
		}

		return null;
	}

	function readLiveClerkIdentity(user: unknown): { name: string | null; email: string | null } {
		const userRecord = toRecord(user);
		if (!userRecord) {
			return { name: null, email: null };
		}

		const primaryEmailRecord = toRecord(userRecord.primaryEmailAddress);
		let email =
			readStringFromRecord(primaryEmailRecord, ['emailAddress', 'email_address']) ??
			readStringFromRecord(userRecord, ['primaryEmailAddress', 'emailAddress', 'email_address']);

		if (!email) {
			const emailAddresses = Array.isArray(userRecord.emailAddresses) ? userRecord.emailAddresses : [];
			for (const item of emailAddresses) {
				const emailRecord = toRecord(item);
				const candidate = readStringFromRecord(emailRecord, ['emailAddress', 'email_address']);
				if (candidate) {
					email = candidate;
					break;
				}
			}
		}

		const fullName = readStringFromRecord(userRecord, ['fullName', 'full_name']);
		const firstName = readStringFromRecord(userRecord, ['firstName', 'first_name']);
		const lastName = readStringFromRecord(userRecord, ['lastName', 'last_name']);
		const username = readStringFromRecord(userRecord, ['username']);

		let name: string | null = null;
		if (fullName && !isGenericUserLabel(fullName)) {
			name = fullName;
		} else {
			const composed = [firstName, lastName]
				.filter((value): value is string => Boolean(value))
				.join(' ')
				.trim();
			if (composed && !isGenericUserLabel(composed)) {
				name = composed;
			} else if (username && !isGenericUserLabel(username)) {
				name = username;
			}
		}

		return { name, email };
	}

	async function syncLiveClerkIdentity(clerkInstance?: Awaited<ReturnType<typeof getClerkInstance>>) {
		try {
			const clerk = clerkInstance ?? (await getClerkInstance());
			const identity = readLiveClerkIdentity(clerk.user);
			clerkProfileName = identity.name;
			clerkProfileEmail = identity.email;
		} catch {
			clerkProfileName = null;
			clerkProfileEmail = null;
		}
	}

	async function refreshSessionFromClerk(showExpiryMessage: boolean): Promise<boolean> {
		try {
			const nextSession = await resolveClientSession();
			if (!nextSession) {
				clearSessionState();
				const clerk = await getClerkInstance();
				clerkSignedIn = Boolean(clerk.session && clerk.user);
				if (clerkSignedIn) {
					await unmountAuthView();
				}
				if (showExpiryMessage) {
					authMessage = clerkSignedIn
						? 'Signed in on Clerk, but backend token validation failed.'
						: 'Session expired. Please sign in again.';
				}
				return false;
			}

			session = {
				...nextSession,
				isAdmin: session?.isAdmin === true
			};
			clerkSignedIn = true;
			authMessage = '';
			if (accountSettingsOpen) {
				void loadAccountSettings();
			}
			return true;
		} catch (error) {
			console.error(error);
			clearSessionState();
			try {
				const clerk = await getClerkInstance();
				clerkSignedIn = Boolean(clerk.session && clerk.user);
				if (clerkSignedIn) {
					await unmountAuthView();
				}
			} catch {
				clerkSignedIn = false;
			}
			if (showExpiryMessage) {
				authMessage = error instanceof Error ? error.message : 'Authentication failed. Please sign in again.';
			}
			return false;
		}
	}

	async function authorizedFetch(
		input: RequestInfo | URL,
		init: RequestInit = {},
		retryOnUnauthorized = true
	): Promise<Response | null> {
		if (!session) {
			return null;
		}

		let response = await fetch(input, {
			...init,
			headers: withAuthorizationHeader(init.headers, session.accessToken)
		});

		if (response.status !== 401 || !retryOnUnauthorized) {
			return response;
		}

		const refreshed = await refreshSessionFromClerk(false);
		if (!refreshed || !session) {
			return response;
		}

		response = await fetch(input, {
			...init,
			headers: withAuthorizationHeader(init.headers, session.accessToken)
		});
		return response;
	}

	async function unmountAuthView() {
		if (!authContainer || !mountedAuthView) {
			return;
		}

		try {
			const clerk = await getClerkInstance();
			if (mountedAuthView === 'sign-in') {
				clerk.unmountSignIn(authContainer);
			} else {
				clerk.unmountSignUp(authContainer);
			}
			mountedAuthView = null;
			mountedAuthTheme = null;
		} catch (error) {
			console.error(error);
		}
	}

	function getClerkAppearance(currentTheme: Theme): { variables: Record<string, string> } | undefined {
		if (currentTheme === 'light') {
			return undefined;
		}

		return {
			variables: {
				colorBackground: '#090d16',
				colorText: '#e6ebff',
				colorTextSecondary: '#a6b0ce',
				colorPrimary: '#90a3ff',
				colorInputBackground: '#121a2d',
				colorInputText: '#e6ebff',
				colorNeutral: '#27365f',
				colorDanger: '#f87171',
				borderRadius: '0.9rem'
			}
		};
	}

	function getPostAuthRedirectUrl(): string {
		return `${window.location.pathname}${window.location.search}`;
	}

	async function mountAuthView() {
		if (!authReady || session || !authContainer) {
			return;
		}

		try {
			const clerk = await getClerkInstance();
			if (mountedAuthView === activeAuthView && mountedAuthTheme === theme) {
				return;
			}

			if (mountedAuthView === 'sign-in') {
				clerk.unmountSignIn(authContainer);
			} else if (mountedAuthView === 'sign-up') {
				clerk.unmountSignUp(authContainer);
			}

			const appearance = getClerkAppearance(theme);
			const redirectUrl = getPostAuthRedirectUrl();
			if (activeAuthView === 'sign-in') {
				clerk.mountSignIn(authContainer, {
					routing: 'virtual',
					appearance,
					forceRedirectUrl: redirectUrl,
					fallbackRedirectUrl: redirectUrl,
					signUpForceRedirectUrl: redirectUrl,
					signUpFallbackRedirectUrl: redirectUrl
				});
			} else {
				clerk.mountSignUp(authContainer, {
					routing: 'virtual',
					appearance,
					forceRedirectUrl: redirectUrl,
					fallbackRedirectUrl: redirectUrl,
					signInForceRedirectUrl: redirectUrl,
					signInFallbackRedirectUrl: redirectUrl
				});
			}

			mountedAuthView = activeAuthView;
			mountedAuthTheme = theme;
		} catch (error) {
			console.error(error);
			authMessage = error instanceof Error ? error.message : 'Failed to load authentication form.';
		}
	}

	function setAuthView(nextView: AuthView) {
		if (activeAuthView === nextView) {
			return;
		}

		activeAuthView = nextView;
		authMessage = '';
		void mountAuthView();
	}

	async function syncSessionState(showExpiryMessage = true) {
		if (!session) {
			return;
		}

		const response = await authorizedFetch('/api/session');
		if (!response) {
			return;
		}

		if (response.status === 401) {
			clearSessionState();
			if (showExpiryMessage) {
				authMessage = 'Session expired. Please sign in again.';
			}
			return;
		}

		const payload = await response.json();
		if (!response.ok) {
			throw new Error(payload?.error ?? 'Failed to initialize session role.');
		}

		if (
			payload?.role === 'base' ||
			payload?.role === 'vip' ||
			payload?.role === 'dev' ||
			payload?.role === 'creator'
		) {
			userRole = payload.role === 'creator' ? 'dev' : payload.role;
		}

		if (session) {
			const nextId = normalizeTextValue(payload?.user?.id);
			const nextEmail = normalizeTextValue(payload?.user?.email);
			const nextDisplayName = normalizeTextValue(payload?.user?.displayName);
			const nextAvatarUrl = normalizeTextValue(payload?.user?.avatarUrl);

			session = {
				...session,
				user: {
					id: nextId ?? session.user.id,
					email: nextEmail ?? session.user.email,
					displayName:
						nextDisplayName && !isGenericUserLabel(nextDisplayName)
							? nextDisplayName
							: session.user.displayName,
					avatarUrl: nextAvatarUrl ?? session.user.avatarUrl
				},
				isAdmin: payload?.isAdmin === true
			};
			if (accountSettingsOpen) {
				void loadAccountSettings();
			}
		}
	}

	async function loadThreads() {
		if (!session) {
			return;
		}

		isLoadingThreads = true;
		try {
			const response = await authorizedFetch('/api/chats');
			if (!response) {
				return;
			}

			if (response.status === 401) {
				clearSessionState();
				return;
			}

			const payload = await response.json();
			if (!response.ok) {
				throw new Error(payload?.error ?? 'Failed to load chats.');
			}

			chatThreads = Array.isArray(payload?.threads)
				? payload.threads.filter(
					(row: unknown): row is ChatThread =>
						Boolean(
							row &&
							typeof row === 'object' &&
							typeof (row as Record<string, unknown>).id === 'string' &&
							typeof (row as Record<string, unknown>).title === 'string' &&
							typeof (row as Record<string, unknown>).createdAt === 'string' &&
							typeof (row as Record<string, unknown>).updatedAt === 'string'
						)
				  )
				: [];
		} catch (error) {
			console.error(error);
		} finally {
			isLoadingThreads = false;
		}
	}

	async function loadThreadMessages(threadId: string) {
		if (!session) {
			return;
		}

		isLoadingThreadMessages = true;
		errorMessage = '';
		try {
			const response = await authorizedFetch(`/api/chats/${threadId}`);
			if (!response) {
				return;
			}

			if (response.status === 401) {
				clearSessionState();
				authMessage = 'Session expired. Please sign in again.';
				return;
			}

			const payload = await response.json();
			if (!response.ok) {
				throw new Error(payload?.error ?? 'Failed to load chat thread.');
			}

			currentThreadId = threadId;
			messages = Array.isArray(payload?.messages)
				? payload.messages
						.filter(
							(row: unknown): row is ChatMessage =>
								Boolean(
									row &&
									typeof row === 'object' &&
									((row as Record<string, unknown>).role === 'user' ||
										(row as Record<string, unknown>).role === 'assistant') &&
									typeof (row as Record<string, unknown>).content === 'string'
								)
						)
						.map((row: { role: 'user' | 'assistant'; content: string; attachments?: unknown[] }) => ({
							role: row.role,
							content: stripThinkingArtifacts(row.content),
							attachments: Array.isArray(row.attachments)
								? row.attachments.filter((item): item is string => typeof item === 'string')
								: []
						}))
				: [];
		} catch (error) {
			console.error(error);
			errorMessage = error instanceof Error ? error.message : 'Failed to load selected chat.';
		} finally {
			isLoadingThreadMessages = false;
		}
	}

	async function submitThreadRename(threadId: string) {
		if (!session) {
			return;
		}

		const title = renameDraftTitle.trim();
		if (!title) {
			errorMessage = 'Title cannot be empty.';
			return;
		}

		try {
			const response = await authorizedFetch(`/api/chats/${threadId}`, {
				method: 'PATCH',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({ title })
			});
			if (!response) {
				return;
			}

			const payload = await response.json();
			if (response.status === 401) {
				clearSessionState();
				authMessage = 'Session expired. Please sign in again.';
				return;
			}

			if (!response.ok) {
				throw new Error(payload?.error ?? 'Failed to rename chat.');
			}

			const updatedThread = payload?.thread as ChatThread | undefined;
			if (updatedThread && typeof updatedThread.id === 'string') {
				chatThreads = chatThreads.map((thread) => (thread.id === updatedThread.id ? updatedThread : thread));
			} else {
				await loadThreads();
			}

			cancelThreadRename();
		} catch (error) {
			console.error(error);
			errorMessage = error instanceof Error ? error.message : 'Failed to rename chat.';
		}
	}

	async function deleteThread(threadId: string) {
		if (!session) {
			return;
		}

		const thread = chatThreads.find((item) => item.id === threadId);
		const confirmed = window.confirm(`Delete "${thread?.title ?? 'this chat'}"? This cannot be undone.`);
		if (!confirmed) {
			return;
		}

		try {
			const response = await authorizedFetch(`/api/chats/${threadId}`, {
				method: 'DELETE'
			});
			if (!response) {
				return;
			}

			const payload = await response.json();
			if (response.status === 401) {
				clearSessionState();
				authMessage = 'Session expired. Please sign in again.';
				return;
			}

			if (!response.ok) {
				throw new Error(payload?.error ?? 'Failed to delete chat.');
			}

			chatThreads = chatThreads.filter((item) => item.id !== threadId);
			if (currentThreadId === threadId) {
				startNewChat();
			}
			cancelThreadRename();
		} catch (error) {
			console.error(error);
			errorMessage = error instanceof Error ? error.message : 'Failed to delete chat.';
		}
	}

	async function restoreSession() {
		try {
			const nextSession = await resolveClientSession();
			if (!nextSession) {
				clearSessionState();
				const clerk = await getClerkInstance();
				clerkSignedIn = Boolean(clerk.session && clerk.user);
				if (clerkSignedIn) {
					await unmountAuthView();
					if (!authMessage) {
						authMessage = 'Signed in on Clerk, but backend token validation failed.';
					}
				}
				return;
			}

			session = {
				...nextSession,
				isAdmin: session?.isAdmin === true
			};
			clerkSignedIn = true;
			authMessage = '';
			await unmountAuthView();
			await syncLiveClerkIdentity();
			await syncSessionState(false);
			await loadThreads();
			await loadAccountSettings();
		} catch (error) {
			console.error(error);
			clearSessionState();
			try {
				const clerk = await getClerkInstance();
				clerkSignedIn = Boolean(clerk.session && clerk.user);
				if (clerkSignedIn) {
					await unmountAuthView();
				}
			} catch {
				clerkSignedIn = false;
			}
			authMessage = error instanceof Error ? error.message : 'Failed to restore session.';
		} finally {
			authReady = true;
		}
	}

	async function logout() {
		try {
			const clerk = await getClerkInstance();
			await clerk.signOut();
		} catch (error) {
			console.error(error);
		} finally {
			clerkSignedIn = false;
			clerkProfileName = null;
			clerkProfileEmail = null;
			clearSessionState();
			authReady = true;
		}
	}

	async function retryAuthExchange() {
		authMessage = '';
		await restoreSession();
	}

	async function openClerkAccountSettings() {
		try {
			const clerk = await getClerkInstance();
			clerk.openUserProfile();
		} catch (error) {
			console.error(error);
			errorMessage = 'Unable to open account settings.';
		}
	}

	async function sendMessage() {
		if (isSending || !session) {
			return;
		}

		const cleanPrompt = prompt.trim();
		if (!cleanPrompt && selectedFiles.length === 0) {
			return;
		}

		const attachmentNames = selectedFiles.map((file) => file.name);
		const userText = cleanPrompt || `Attached files: ${attachmentNames.join(', ')}`;
		messages = [...messages, { role: 'user', content: userText, attachments: attachmentNames }];

		prompt = '';
		void syncComposerHeight();
		clearComposerFiles();
		errorMessage = '';
		thinkingHint = pickThinkingHint();
		isSending = true;

		try {
			const bodyPayload: Record<string, unknown> = {
				message: userText,
				attachments: attachmentNames,
				threadId: currentThreadId,
				reasoningEnabled
			};
			if (session.isAdmin) {
				bodyPayload.provider = provider;
			}

			const response = await authorizedFetch('/api/chat', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify(bodyPayload)
			});

			if (!response) {
				return;
			}

			const payload = await response.json();
			if (response.status === 401) {
				clearSessionState();
				authMessage = 'Session expired. Please sign in again.';
				return;
			}

			if (!response.ok) {
				errorMessage =
					response.status === 429
						? "You're cut off! Go outside. Touch some grass."
						: payload?.error ?? 'Request failed.';
				if (payload?.quota) {
					quota = payload.quota;
					userRole = payload.quota.role;
				}
				return;
			}

			if (payload?.quota) {
				quota = payload.quota;
				userRole = payload.quota.role;
			}

			if (typeof payload?.provider === 'string') {
				provider = payload.provider;
				localStorage.setItem('raven-provider', provider);
			}

			if (typeof payload?.threadId === 'string') {
				currentThreadId = payload.threadId;
			}

			messages = [
				...messages,
				{ role: 'assistant', content: stripThinkingArtifacts(payload?.reply ?? 'No response returned.') }
			];
			await loadThreads();
		} catch (error) {
			console.error(error);
			errorMessage = 'Unable to reach chat service.';
		} finally {
			isSending = false;
		}
	}

	function handleComposerKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			void sendMessage();
		}
	}

	function handleThreadRenameKeydown(event: KeyboardEvent, threadId: string) {
		if (event.key === 'Enter') {
			event.preventDefault();
			void submitThreadRename(threadId);
			return;
		}

		if (event.key === 'Escape') {
			event.preventDefault();
			cancelThreadRename();
		}
	}

	function handleComposerInput() {
		void syncComposerHeight();
	}

	function getDisplayName(
		currentSession: SessionData | null,
		liveClerkName: string | null,
		liveClerkEmail: string | null
	) {
		if (!currentSession) {
			return 'User';
		}

		const normalizedDisplayName = normalizeTextValue(currentSession.user.displayName);
		if (normalizedDisplayName && !isGenericUserLabel(normalizedDisplayName)) {
			return normalizedDisplayName;
		}

		const liveName = normalizeTextValue(liveClerkName);
		if (liveName && !isGenericUserLabel(liveName)) {
			return liveName;
		}

		const emailValue = normalizeTextValue(currentSession.user.email) ?? normalizeTextValue(liveClerkEmail);
		if (emailValue) {
			return emailValue.split('@')[0];
		}

		return 'User';
	}

	function getFirstName(name: string): string | null {
		const normalized = normalizeTextValue(name);
		if (!normalized || isGenericUserLabel(normalized)) {
			return null;
		}

		const firstToken = normalized.split(/[\s@._-]+/).filter(Boolean)[0];
		if (!firstToken) {
			return null;
		}

		return firstToken.charAt(0).toUpperCase() + firstToken.slice(1);
	}

	function getInitials(name: string) {
		const cleaned = name.trim();
		if (!cleaned) {
			return 'U';
		}

		const pieces = cleaned.split(/[\s@._-]+/).filter(Boolean);
		if (pieces.length === 0) {
			return cleaned.slice(0, 2).toUpperCase();
		}

		if (pieces.length === 1) {
			return pieces[0].slice(0, 2).toUpperCase();
		}

		return `${pieces[0][0]}${pieces[1][0]}`.toUpperCase();
	}

	function formatRelativeDate(value: string) {
		const parsed = Date.parse(value);
		if (Number.isNaN(parsed)) {
			return '';
		}

		return new Intl.DateTimeFormat(undefined, {
			month: 'short',
			day: 'numeric'
		}).format(new Date(parsed));
	}

	onMount(() => {

		const savedTheme = localStorage.getItem('raven-theme');
		if (savedTheme === 'raven' || savedTheme === 'light') {
			theme = savedTheme;
		} else if (savedTheme === 'dark') {
			theme = 'raven';
		}
		applyTheme(theme);

		const savedProvider = localStorage.getItem('raven-provider');
		if (savedProvider === 'koboldcpp' || savedProvider === 'openrouter') {
			provider = savedProvider;
		}
		reasoningEnabled = localStorage.getItem('raven-reasoning-enabled') === 'true';
		void syncComposerHeight();

		const query = window.matchMedia('(max-width: 1023px)');
		const syncViewportState = (matches: boolean) => {
			isMobileView = matches;
			if (matches) {
				desktopSidebarOpen = false;
			} else {
				mobileSidebarOpen = false;
			}
		};

		syncViewportState(query.matches);

		const handleViewportChange = (event: MediaQueryListEvent) => {
			syncViewportState(event.matches);
		};

		query.addEventListener('change', handleViewportChange);

		const setupAuth = async () => {
			try {
				const clerk = await getClerkInstance();
				removeClerkListener?.();
				removeClerkListener = clerk.addListener(() => {
					clerkSignedIn = Boolean(clerk.session && clerk.user);
					void syncLiveClerkIdentity(clerk);
				});
				await syncLiveClerkIdentity(clerk);
				await restoreSession();
			} catch (error) {
				console.error(error);
				authMessage = error instanceof Error ? error.message : 'Failed to initialize authentication.';
				authReady = true;
			}
		};

		void setupAuth();

		return () => {
			query.removeEventListener('change', handleViewportChange);
			removeClerkListener?.();
			removeClerkListener = null;
			void unmountAuthView();
		};
	});

	$: if (authReady && !session && !clerkSignedIn && authContainer) {
		void mountAuthView();
	}
	$: sidebarVisible = isMobileView ? mobileSidebarOpen : desktopSidebarOpen;
	$: roleLabel = userRole === 'dev' ? 'Dev' : userRole === 'vip' ? 'VIP' : 'Base';
	$: displayName = getDisplayName(session, clerkProfileName, clerkProfileEmail);
	$: greetingFirstName = getFirstName(displayName);
	$: accountInitials = getInitials(displayName);
	$: reasoningWillApply = session?.isAdmin ? provider === 'openrouter' : true;
</script>

<div class="h-[100dvh] overflow-hidden bg-base-100 text-base-content">
	{#if !authReady}
		<div class="flex h-full items-center justify-center">
			<span class="loading loading-spinner loading-lg"></span>
		</div>
	{:else if !session}
		<div class="relative flex h-full items-center justify-center overflow-y-auto px-4 py-8 sm:px-6">
			<div class="absolute right-4 top-4">
				<button type="button" class="btn btn-ghost btn-sm btn-square" on:click={toggleTheme} aria-label="Toggle theme">
					{#if theme === 'raven'}
						<svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2">
							<circle cx="12" cy="12" r="4"></circle>
							<path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"></path>
						</svg>
					{:else}
						<svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2">
							<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"></path>
						</svg>
					{/if}
				</button>
			</div>

			<div class="card w-full max-w-md max-h-[calc(100dvh-4rem)] overflow-y-auto border border-base-300/60 bg-base-200/70 shadow-xl">
				<div class="card-body gap-4">
					<div class="flex items-center gap-2">
						<div class="h-8 w-8 shrink-0">
							<img src={RAVEN_ICON_PATH} alt={`${APP_NAME} logo`} class="h-full w-full object-contain" />
						</div>
						<h1 class="text-lg font-semibold">{APP_NAME}</h1>
					</div>

					{#if clerkSignedIn}
						<p class="text-sm text-base-content/70">
							You are signed in with Clerk, but this app could not validate your backend session.
						</p>
						<div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
							<button type="button" class="btn btn-primary btn-sm" on:click={() => void retryAuthExchange()}>
								Retry session
							</button>
							<button type="button" class="btn btn-outline btn-sm" on:click={() => void logout()}>
								Sign out
							</button>
						</div>
					{:else}
						<p class="text-sm text-base-content/70">Sign in or create an account to start chatting.</p>
						<div class="tabs tabs-boxed bg-base-100/70">
							<button
								type="button"
								class={`tab flex-1 ${activeAuthView === 'sign-in' ? 'tab-active' : ''}`}
								on:click={() => {
									setAuthView('sign-in');
								}}
							>
								Sign in
							</button>
							<button
								type="button"
								class={`tab flex-1 ${activeAuthView === 'sign-up' ? 'tab-active' : ''}`}
								on:click={() => {
									setAuthView('sign-up');
								}}
							>
								Sign up
							</button>
						</div>
						<div class={`rounded-2xl border border-base-300/60 p-2 ${theme === 'raven' ? 'bg-[#0d1220]' : 'bg-base-100'}`}>
							<div bind:this={authContainer} class="min-h-[420px]"></div>
						</div>
					{/if}

					{#if authMessage}
						<div class="alert alert-info py-2 text-sm">
							<span>{authMessage}</span>
						</div>
					{/if}
				</div>
			</div>
		</div>
	{:else}
		<div class="relative flex h-full overflow-hidden bg-base-100 text-base-content">
			{#if isMobileView && mobileSidebarOpen}
				<button
					type="button"
					class="fixed inset-0 z-30 bg-black/45 lg:hidden"
					on:click={() => {
						mobileSidebarOpen = false;
					}}
					aria-label="Close sidebar backdrop"
				></button>
			{/if}

			{#if sidebarVisible}
				<aside
					class="fixed inset-y-0 left-0 z-40 flex w-[85vw] max-w-72 flex-col border-r border-base-300/60 bg-base-200/85 p-4 backdrop-blur lg:static lg:z-auto lg:h-[100dvh] lg:w-72 lg:max-w-none lg:shrink-0"
				>
					<div class="flex items-center justify-between">
						<div class="flex items-center gap-2">
							<div class="h-8 w-8 shrink-0">
								<img src={RAVEN_ICON_PATH} alt={`${APP_NAME} logo`} class="h-full w-full object-contain" />
							</div>
							<span class="text-base font-semibold">{APP_NAME}</span>
						</div>

						<button type="button" class="btn btn-ghost btn-sm btn-square" on:click={closeSidebar} aria-label="Close sidebar">
							<svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2">
								<path d="M3 4h18v16H3z" />
								<path d="M9 4v16" />
								<path d="M14 12h5" />
								<path d="M16 10l-2 2 2 2" />
							</svg>
						</button>
					</div>

					<button
						type="button"
						class="group relative mt-3 flex w-full items-center justify-start gap-2 overflow-hidden rounded-2xl border border-primary/40 bg-gradient-to-r from-primary/30 via-secondary/35 to-base-100/35 px-4 py-2.5 text-sm font-semibold text-base-content shadow-[0_14px_30px_-22px_rgba(144,163,255,0.95)] transition hover:-translate-y-0.5 hover:border-primary/60 hover:from-primary/45 hover:to-base-100/65"
						on:click={startNewChat}
					>
						<span class="grid h-6 w-6 place-items-center rounded-full bg-primary/25 text-primary transition group-hover:scale-110">
							<svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2">
								<path d="M12 5v14M5 12h14" />
							</svg>
						</span>
						<span>New chat</span>
					</button>

					<div class="mt-5 flex-1 overflow-y-auto pr-1">
						<p class="px-2 text-xs font-medium uppercase tracking-wide text-base-content/55">Older chats</p>
						<div class="mt-2 space-y-1">
							{#if isLoadingThreads}
								<p class="px-3 py-2 text-xs text-base-content/60">Loading chats...</p>
							{:else if chatThreads.length === 0}
								<p class="px-3 py-2 text-xs text-base-content/60">No previous chats yet.</p>
							{:else}
								{#each chatThreads as chat}
									<div class="group flex items-start gap-1">
										{#if renamingThreadId === chat.id}
											<div class="w-full rounded-xl border border-base-300/70 bg-base-100/80 px-2 py-2">
												<input
													class="input input-xs w-full"
													bind:value={renameDraftTitle}
													maxlength="60"
													on:keydown={(event) => {
														handleThreadRenameKeydown(event, chat.id);
													}}
												/>
												<div class="mt-2 flex items-center gap-2">
													<button
														type="button"
														class="btn btn-primary btn-xs"
														on:click={() => {
															void submitThreadRename(chat.id);
														}}
													>
														Save
													</button>
													<button type="button" class="btn btn-ghost btn-xs" on:click={cancelThreadRename}>
														Cancel
													</button>
												</div>
											</div>
										{:else}
											<button
												type="button"
												class={`min-w-0 flex-1 rounded-xl px-3 py-2 text-left text-sm transition hover:bg-base-300/60 ${
													currentThreadId === chat.id ? 'bg-base-300/70 text-base-content' : 'text-base-content/80'
												}`}
												on:click={() => {
													void loadThreadMessages(chat.id);
												}}
											>
												<p class="truncate">{chat.title}</p>
												<p class="mt-0.5 text-[11px] text-base-content/55">{formatRelativeDate(chat.updatedAt)}</p>
											</button>
											<div class="dropdown dropdown-end">
												<button
													type="button"
													tabindex="0"
													class="btn btn-ghost btn-xs btn-square opacity-100 lg:opacity-0 lg:group-hover:opacity-100 lg:group-focus-within:opacity-100"
													aria-label={`Chat options for ${chat.title}`}
												>
													<svg viewBox="0 0 24 24" class="h-4 w-4" fill="currentColor">
														<circle cx="5" cy="12" r="2"></circle>
														<circle cx="12" cy="12" r="2"></circle>
														<circle cx="19" cy="12" r="2"></circle>
													</svg>
												</button>
												<ul class="menu dropdown-content z-50 mt-1 w-40 rounded-box border border-base-300 bg-base-100 p-2 shadow-xl">
													<li>
														<button
															type="button"
															on:click={() => {
																startThreadRename(chat);
															}}
														>
															Rename
														</button>
													</li>
													<li>
														<button
															type="button"
															class="text-error"
															on:click={() => {
																void deleteThread(chat.id);
															}}
														>
															Delete
														</button>
													</li>
												</ul>
											</div>
										{/if}
									</div>
								{/each}
							{/if}
						</div>
					</div>

					<div class="mt-4 border-t border-base-300/60 pt-3">
						<div class="flex items-center justify-between">
							<div class="flex items-center gap-2">
								<div class="avatar h-9 w-9 overflow-hidden rounded-full border border-base-300">
									{#if session.user.avatarUrl}
										<img
											src={session.user.avatarUrl}
											alt={displayName}
											class="h-full w-full object-cover"
										/>
									{:else}
										<div class="grid h-full w-full place-items-center bg-neutral text-neutral-content">
											<span class="text-xs">{accountInitials}</span>
										</div>
									{/if}
								</div>
								<div class="leading-tight">
									<p class="max-w-36 truncate text-sm font-medium">{displayName}</p>
									<p class="text-xs text-base-content/60">{roleLabel}</p>
								</div>
							</div>

							<div class="dropdown dropdown-top dropdown-end">
								<button type="button" class="btn btn-ghost btn-sm btn-square" aria-label="Account options">
									<svg viewBox="0 0 24 24" class="h-5 w-5" fill="currentColor">
										<circle cx="5" cy="12" r="2"></circle>
										<circle cx="12" cy="12" r="2"></circle>
										<circle cx="19" cy="12" r="2"></circle>
									</svg>
								</button>
								<ul class="menu dropdown-content z-50 mt-2 w-52 rounded-box border border-base-300 bg-base-100 p-2 shadow-xl">
									{#if session.isAdmin}
										<li><a href="/admin">Admin panel</a></li>
									{/if}
									<li>
										<button type="button" on:click={openAccountSettings}>
											Account settings
										</button>
									</li>
									<li>
										<button type="button" on:click={() => void openClerkAccountSettings()}>
											Manage profile
										</button>
									</li>
									<li>
										<button type="button" on:click={toggleTheme}>
											Switch to {theme === 'raven' ? 'light' : 'raven'} mode
										</button>
									</li>
									<li><button type="button" on:click={() => void logout()}>Logout</button></li>
								</ul>
							</div>
						</div>
					</div>
				</aside>
			{/if}

			<div class="flex min-h-0 flex-1 flex-col">
				<header class="shrink-0 flex items-center justify-between gap-2 px-4 py-3 sm:px-6">
					<div class="flex items-center gap-2">
						{#if !sidebarVisible}
							<button type="button" class="btn btn-ghost btn-sm btn-square" on:click={openSidebar} aria-label="Open sidebar">
								<svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2">
									<path d="M4 6h16M4 12h16M4 18h16" />
								</svg>
							</button>
						{/if}
						<p class="text-sm text-base-content/70 lg:hidden">{APP_NAME}</p>
					</div>

					{#if session.isAdmin}
						<label class="flex items-center gap-2 text-xs text-base-content/70">
							Source
							<select class="select select-xs w-28" bind:value={provider}>
								<option value="koboldcpp">KoboldCpp</option>
								<option value="openrouter">OpenRouter</option>
							</select>
						</label>
					{/if}
				</header>

				<div class="min-h-0 flex-1 overflow-y-auto">
					<main class="mx-auto flex min-h-full w-full max-w-3xl flex-col px-4 pt-2 sm:px-6">
						{#if messages.length === 0}
							<div class="flex min-h-[45vh] flex-1 flex-col items-center justify-center py-8 text-center">
								<h1 class="text-3xl font-semibold tracking-tight sm:text-4xl">
									{greetingFirstName ? `How can I help you, ${greetingFirstName}?` : 'How can I help?'}
								</h1>
							</div>
						{:else}
							<div class="mb-5 space-y-4 pb-4">
								{#each messages as message}
									<div class={message.role === 'user' ? 'chat chat-end' : 'chat chat-start'}>
										<div class={message.role === 'user' ? 'chat-bubble chat-bubble-primary max-w-[88%]' : 'chat-bubble max-w-[88%]'}>
											<p class="whitespace-pre-wrap">{message.content}</p>
											{#if message.attachments && message.attachments.length > 0}
												<p class="mt-2 text-xs opacity-75">Files: {message.attachments.join(', ')}</p>
											{/if}
										</div>
									</div>
								{/each}

								{#if isSending}
									<div class="chat chat-start">
										<div class="chat-bubble max-w-[88%]">
											<div class="inline-flex items-center gap-2">
												<span class="loading loading-dots loading-xs"></span>
												<span class="text-sm">{thinkingHint}</span>
											</div>
										</div>
									</div>
								{/if}
							</div>
						{/if}
					</main>
				</div>

				<div class="mx-auto w-full max-w-3xl px-4 pb-4 sm:px-6 sm:pb-8">
					{#if isLoadingThreadMessages}
						<p class="mb-2 text-xs text-base-content/60">Loading selected chat...</p>
					{/if}

					{#if selectedFiles.length > 0}
						<div class="mb-3 flex flex-wrap gap-2">
							{#each selectedFiles as file}
								<div class="badge badge-outline gap-2 p-3 text-xs sm:text-sm">
									<span class="max-w-36 truncate sm:max-w-64">{file.name}</span>
									<button
										type="button"
										class="rounded-full p-0.5 text-base-content/70 hover:bg-base-300"
										on:click={() => {
											removeFile(file.name);
										}}
										aria-label={`Remove ${file.name}`}
									>
										<svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2">
											<path d="M6 6l12 12M18 6L6 18" />
										</svg>
									</button>
								</div>
							{/each}
						</div>
					{/if}

					<div class="rounded-3xl border border-base-300/70 bg-base-200/40 p-3 shadow-xl shadow-base-content/5 sm:p-4">
						<textarea
							class="textarea textarea-ghost min-h-0 w-full resize-none overflow-y-hidden border-0 bg-transparent px-2 py-2 text-sm leading-6 outline-none hover:bg-transparent focus:bg-transparent focus:outline-none sm:text-base"
							bind:value={prompt}
							bind:this={composerTextarea}
							rows="1"
							style="height: 44px;"
							placeholder="Type your message here"
							disabled={isSending}
							on:input={handleComposerInput}
							on:keydown={handleComposerKeydown}
						></textarea>

						<div class="mt-3 flex items-center justify-between gap-2">
							<div class="flex items-center gap-2">
								<input
									type="file"
									class="hidden"
									bind:this={fileInput}
									accept=".txt,.pdf,text/plain,application/pdf"
									multiple
									on:change={handleFileChange}
								/>
								<div class="tooltip tooltip-top" data-tip="Upload docs only">
									<button
										type="button"
										class="btn btn-ghost btn-sm btn-circle"
										on:click={triggerUpload}
										aria-label="Upload docs"
										disabled={isSending}
									>
										<svg
											viewBox="0 0 24 24"
											class="h-[18px] w-[18px]"
											fill="none"
											stroke="currentColor"
											stroke-width="2"
										>
											<path d="M21.44 11.05l-8.49 8.49a6 6 0 11-8.49-8.49l8.5-8.49a4 4 0 015.66 5.66L10 16.88a2 2 0 11-2.83-2.83l7.78-7.78" />
										</svg>
									</button>
								</div>
								<div
									class="tooltip tooltip-top"
									data-tip={
										reasoningWillApply
											? reasoningEnabled
												? 'Reasoning enabled'
												: 'Enable reasoning'
											: 'Reasoning requires OpenRouter'
									}
								>
									<button
										type="button"
										class={`btn btn-ghost btn-sm btn-circle ${
											reasoningEnabled ? 'bg-primary/15 text-primary' : ''
										} ${!reasoningWillApply ? 'opacity-60' : ''}`}
										on:click={toggleReasoning}
										aria-label="Toggle reasoning"
										disabled={isSending}
									>
										<svg
											viewBox="0 0 24 24"
											class="h-[18px] w-[18px]"
											fill="none"
											stroke="currentColor"
											stroke-width="2"
											stroke-linecap="round"
											stroke-linejoin="round"
										>
											<path d="M9.5 4.5a3 3 0 0 0-3 3v.5a2.5 2.5 0 0 0-2 2.45 2.5 2.5 0 0 0 1.5 2.3v1.75a3 3 0 0 0 3 3h.5"></path>
											<path d="M14.5 4.5a3 3 0 0 1 3 3v.5a2.5 2.5 0 0 1 2 2.45 2.5 2.5 0 0 1-1.5 2.3v1.75a3 3 0 0 1-3 3h-.5"></path>
											<path d="M12 7v10"></path>
											<path d="M9.5 10.5h1.5M13 10.5h1.5M9.5 14h1.5M13 14h1.5"></path>
										</svg>
									</button>
								</div>
							</div>

							<button
								type="button"
								class="btn btn-primary btn-sm btn-circle"
								on:click={() => void sendMessage()}
								disabled={isSending}
								aria-label={isSending ? 'Generating response' : 'Send message'}
							>
								{#if isSending}
									<span class="loading loading-spinner loading-xs"></span>
								{:else}
									<svg viewBox="0 0 24 24" class="h-[18px] w-[18px]" fill="currentColor" aria-hidden="true">
										<path d="M21.4 2.6a1.5 1.5 0 0 0-1.56-.33L3.53 8.14a1.5 1.5 0 0 0 .08 2.85l6.54 1.96 1.96 6.54a1.5 1.5 0 0 0 2.85.08l5.87-16.31a1.5 1.5 0 0 0-.43-1.66zM11.4 12.6l-1.2 4-.98-3.26a1 1 0 0 0-.66-.66L5.3 11.7l4-1.2 6.74-4.07-4.64 6.17z" />
									</svg>
								{/if}
							</button>
						</div>
					</div>

					{#if errorMessage}
						<div class="alert alert-warning mt-3 py-2 text-sm">
							<span>{errorMessage}</span>
						</div>
					{/if}
				</div>
			</div>
		</div>

		{#if accountSettingsOpen}
			<button
				type="button"
				class="fixed inset-0 z-50 bg-black/45"
				aria-label="Close account settings"
				on:click={closeAccountSettings}
			></button>
			<section
				class="fixed inset-x-4 top-1/2 z-[60] max-h-[88dvh] -translate-y-1/2 overflow-y-auto rounded-2xl border border-base-300 bg-base-100 p-4 shadow-2xl sm:left-1/2 sm:w-[40rem] sm:max-w-[calc(100vw-2rem)] sm:-translate-x-1/2 sm:p-5"
				aria-label="Account settings"
			>
				<div class="flex items-center justify-between gap-3">
					<div>
						<h2 class="text-lg font-semibold">Account settings</h2>
						<p class="text-xs text-base-content/65">Saved per account and synced from server when available.</p>
					</div>
					<button type="button" class="btn btn-ghost btn-sm btn-square" on:click={closeAccountSettings} aria-label="Close settings">
						<svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2">
							<path d="M6 6l12 12M18 6L6 18"></path>
						</svg>
					</button>
				</div>

				{#if isLoadingSettings}
					<p class="mt-2 text-xs text-base-content/60">Loading settings...</p>
				{:else if !settingsStorageAvailable}
					<div class="alert alert-warning mt-2 py-2 text-xs">
						<span>
							Server memory tables are not installed. Run `supabase/memory.sql` to enable cross-device memory.
						</span>
					</div>
				{/if}

				<div class="mt-4 space-y-4">
					<div class="rounded-xl border border-base-300/70 p-3">
						<h3 class="text-sm font-semibold">Personalization</h3>
						<p class="mt-1 text-xs text-base-content/65">
							Tell the model how you want responses written: tone, depth, format, and style.
						</p>
						<textarea
							class="textarea textarea-bordered mt-3 min-h-24 w-full text-sm"
							bind:value={personalizationGuidance}
							maxlength={MAX_PERSONALIZATION_CHARS}
							disabled={isLoadingSettings || isSavingSettings || !settingsStorageAvailable}
							placeholder="Example: Keep answers concise, use bullet points, and include practical examples."
						></textarea>
						<p class="mt-1 text-right text-[11px] text-base-content/55">
							{personalizationGuidance.length}/{MAX_PERSONALIZATION_CHARS}
						</p>
					</div>

					<div class="rounded-xl border border-base-300/70 p-3">
						<div class="flex items-center justify-between gap-3">
							<div>
								<h3 class="text-sm font-semibold">Memory</h3>
								<p class="mt-1 text-xs text-base-content/65">
									Save details you want remembered across chats.
								</p>
							</div>
							<label class="label cursor-pointer gap-2">
								<span class="label-text text-xs">Enabled</span>
								<input
									type="checkbox"
									class="toggle toggle-primary toggle-sm"
									bind:checked={memoryEnabled}
									disabled={isLoadingSettings || isSavingSettings || !settingsStorageAvailable}
									on:change={() => {
										void saveSettings();
									}}
								/>
							</label>
						</div>

						<div class="mt-2 flex items-center justify-between gap-3">
							<p class="text-xs text-base-content/60">Auto-save important stable memories from chat turns.</p>
							<label class="label cursor-pointer gap-2">
								<span class="label-text text-xs">Auto memory</span>
								<input
									type="checkbox"
									class="toggle toggle-secondary toggle-sm"
									bind:checked={autoMemoryEnabled}
									disabled={
										isLoadingSettings || isSavingSettings || !memoryEnabled || !settingsStorageAvailable
									}
									on:change={() => {
										void saveSettings();
									}}
								/>
							</label>
						</div>

						<div class="mt-3 flex items-center gap-2">
							<input
								type="text"
								class="input input-bordered input-sm flex-1"
								bind:value={newMemoryText}
								maxlength={MAX_MEMORY_ENTRY_CHARS}
								disabled={
									isLoadingSettings || isSavingSettings || !memoryEnabled || !settingsStorageAvailable
								}
								placeholder="Add a memory..."
								on:keydown={(event) => {
									if (event.key === 'Enter') {
										event.preventDefault();
										void addMemoryEntry();
									}
								}}
							/>
							<button
								type="button"
								class="btn btn-sm btn-primary"
								disabled={
									isLoadingSettings || isSavingSettings || !memoryEnabled || !settingsStorageAvailable
								}
								on:click={() => {
									void addMemoryEntry();
								}}
							>
								Add
							</button>
						</div>

						{#if memoryEntries.length === 0}
							<p class="mt-3 text-xs text-base-content/60">No saved memories yet.</p>
						{:else}
							<div class="mt-3 space-y-2">
								{#each memoryEntries as memory}
									<div class="flex items-start justify-between gap-2 rounded-lg border border-base-300/60 px-2 py-2">
										<p class="text-xs text-base-content/85">{memory.text}</p>
										<button
											type="button"
											class="btn btn-ghost btn-xs text-error"
											disabled={isLoadingSettings || isSavingSettings || !settingsStorageAvailable}
											on:click={() => {
												void deleteMemoryEntry(memory.id);
											}}
										>
											Delete
										</button>
									</div>
								{/each}
							</div>
						{/if}
					</div>
				</div>

				<div class="mt-5 flex flex-wrap items-center justify-end gap-2">
					<button type="button" class="btn btn-ghost btn-sm" on:click={() => void openClerkAccountSettings()}>
						Manage profile
					</button>
					<button type="button" class="btn btn-ghost btn-sm" on:click={closeAccountSettings}>Close</button>
					<button
						type="button"
						class="btn btn-primary btn-sm"
						disabled={isLoadingSettings || isSavingSettings || !settingsStorageAvailable}
						on:click={() => {
							void saveSettingsAndClose();
						}}
					>
						{#if isSavingSettings}Saving...{:else}Save changes{/if}
					</button>
				</div>
			</section>
		{/if}
	{/if}
</div>
