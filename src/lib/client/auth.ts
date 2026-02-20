import { PUBLIC_CLERK_PUBLISHABLE_KEY } from '$env/static/public';

export interface ClientSessionUser {
	id: string;
	email: string | null;
	displayName: string | null;
	avatarUrl: string | null;
}

export interface ClientSessionData {
	accessToken: string;
	user: ClientSessionUser;
}

interface ClerkEmailAddress {
	emailAddress?: string;
	email_address?: string;
	verification?: {
		status?: string;
	};
}

interface ClerkExternalAccount {
	provider?: string;
	emailAddress?: string;
	email_address?: string;
	firstName?: string;
	first_name?: string;
	lastName?: string;
	last_name?: string;
	username?: string | null;
	imageUrl?: string;
	image_url?: string;
}

interface ClerkUser {
	id: string;
	primaryEmailAddress?: ClerkEmailAddress | null;
	emailAddresses: ClerkEmailAddress[];
	fullName?: string | null;
	full_name?: string | null;
	firstName?: string | null;
	first_name?: string | null;
	lastName?: string | null;
	last_name?: string | null;
	username?: string | null;
	imageUrl?: string | null;
	image_url?: string | null;
	externalAccounts?: ClerkExternalAccount[];
}

interface ClerkSession {
	id?: string;
	getToken(options?: { template?: string }): Promise<string | null>;
}

interface ClerkAppearance {
	variables?: Record<string, string>;
	elements?: Record<string, string>;
}

interface ClerkMountProps {
	routing?: 'path' | 'hash' | 'virtual';
	appearance?: ClerkAppearance;
	forceRedirectUrl?: string | null;
	fallbackRedirectUrl?: string | null;
	signUpForceRedirectUrl?: string | null;
	signUpFallbackRedirectUrl?: string | null;
	signInForceRedirectUrl?: string | null;
	signInFallbackRedirectUrl?: string | null;
}

interface ClerkInstance {
	load(): Promise<void>;
	session: ClerkSession | null;
	user: ClerkUser | null;
	addListener(listener: () => void): () => void;
	signOut(): Promise<void>;
	openUserProfile(): void;
	mountSignIn(node: HTMLDivElement, props?: ClerkMountProps): void;
	unmountSignIn(node: HTMLDivElement): void;
	mountSignUp(node: HTMLDivElement, props?: ClerkMountProps): void;
	unmountSignUp(node: HTMLDivElement): void;
}

type ClerkConstructor = new (publishableKey: string) => ClerkInstance;

let clerkPromise: Promise<ClerkInstance> | null = null;

async function loadClerkConstructor(): Promise<ClerkConstructor> {
	const moduleRecord = (await import('@clerk/clerk-js')) as {
		Clerk?: unknown;
		default?: unknown;
	};

	const candidate = moduleRecord.Clerk ?? moduleRecord.default;
	if (typeof candidate !== 'function') {
		throw new Error('Unable to load Clerk constructor from @clerk/clerk-js.');
	}

	return candidate as ClerkConstructor;
}

export async function getClerkInstance(): Promise<ClerkInstance> {
	if (!clerkPromise) {
		clerkPromise = (async () => {
			if (!PUBLIC_CLERK_PUBLISHABLE_KEY) {
				throw new Error('Missing PUBLIC_CLERK_PUBLISHABLE_KEY.');
			}

			const Clerk = await loadClerkConstructor();
			const clerk = new Clerk(PUBLIC_CLERK_PUBLISHABLE_KEY);
			await clerk.load();
			return clerk;
		})();
	}

	return clerkPromise;
}

function normalizeText(value: unknown): string | null {
	if (typeof value !== 'string') {
		return null;
	}

	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function isGenericDisplayName(value: string | null): boolean {
	if (!value) {
		return true;
	}

	const normalized = value.trim().toLowerCase();
	return normalized === 'user' || normalized === 'unknown' || normalized === 'guest';
}

function readPrimaryEmail(user: ClerkUser | null): string | null {
	if (!user) {
		return null;
	}

	const primaryEmail =
		normalizeText(user.primaryEmailAddress?.emailAddress) ??
		normalizeText(user.primaryEmailAddress?.email_address);
	if (primaryEmail) {
		return primaryEmail;
	}

	for (const emailAddress of user.emailAddresses) {
		const candidate = normalizeText(emailAddress.emailAddress) ?? normalizeText(emailAddress.email_address);
		if (candidate) {
			return candidate;
		}
	}

	for (const account of user.externalAccounts ?? []) {
		const candidate = normalizeText(account.emailAddress) ?? normalizeText(account.email_address);
		if (candidate) {
			return candidate;
		}
	}

	return null;
}

function readDisplayName(user: ClerkUser | null): string | null {
	if (!user) {
		return null;
	}

	const fullName = normalizeText(user.fullName) ?? normalizeText(user.full_name);
	if (fullName) {
		return fullName;
	}

	const composedName = [
		normalizeText(user.firstName) ?? normalizeText(user.first_name),
		normalizeText(user.lastName) ?? normalizeText(user.last_name)
	]
		.filter((value): value is string => Boolean(value))
		.join(' ')
		.trim();

	if (composedName.length > 0) {
		return composedName;
	}

	const username = normalizeText(user.username);
	if (username && !isGenericDisplayName(username)) {
		return username;
	}

	for (const account of user.externalAccounts ?? []) {
		const accountName = [
			normalizeText(account.firstName) ?? normalizeText(account.first_name),
			normalizeText(account.lastName) ?? normalizeText(account.last_name)
		]
			.filter((value): value is string => Boolean(value))
			.join(' ')
			.trim();
		if (accountName.length > 0) {
			return accountName;
		}

		const accountUsername = normalizeText(account.username);
		if (accountUsername && !isGenericDisplayName(accountUsername)) {
			return accountUsername;
		}
	}

	const email = readPrimaryEmail(user);
	if (email && email.includes('@')) {
		return email.split('@')[0];
	}

	return email;
}

function readAvatarUrl(user: ClerkUser): string | null {
	const directAvatar = normalizeText(user.imageUrl) ?? normalizeText(user.image_url);
	if (directAvatar) {
		return directAvatar;
	}

	for (const account of user.externalAccounts ?? []) {
		const candidate = normalizeText(account.imageUrl) ?? normalizeText(account.image_url);
		if (candidate) {
			return candidate;
		}
	}

	return null;
}

export function mapClerkUser(user: ClerkUser | null): ClientSessionUser | null {
	if (!user) {
		return null;
	}

	return {
		id: user.id,
		email: readPrimaryEmail(user),
		displayName: readDisplayName(user),
		avatarUrl: readAvatarUrl(user)
	};
}

async function readClerkSessionToken(session: ClerkSession): Promise<string | null> {
	return session.getToken();
}

export async function resolveClientSession(): Promise<ClientSessionData | null> {
	const clerk = await getClerkInstance();
	if (!clerk.session || !clerk.user) {
		return null;
	}

	const accessToken = await readClerkSessionToken(clerk.session);
	if (!accessToken) {
		return null;
	}

	const user = mapClerkUser(clerk.user);
	if (!user) {
		return null;
	}

	return {
		accessToken,
		user
	};
}
