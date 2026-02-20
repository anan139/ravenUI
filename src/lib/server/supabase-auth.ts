import { createClerkClient, verifyToken, type User } from '@clerk/backend';
import { env } from '$env/dynamic/private';

export interface SupabaseAuthUser {
	id: string;
	email: string | null;
	displayName: string | null;
	avatarUrl: string | null;
}

let clerkClient: ReturnType<typeof createClerkClient> | null = null;

function normalizeText(value: string | null | undefined): string | null {
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

function getClerkSecretKey(): string {
	const secretKey = normalizeText(env.CLERK_SECRET_KEY);
	if (!secretKey) {
		throw new Error('Missing CLERK_SECRET_KEY.');
	}
	return secretKey;
}

function getAuthorizedParties(): string[] | undefined {
	const rawValue = normalizeText(env.CLERK_AUTHORIZED_PARTIES);
	if (!rawValue) {
		return undefined;
	}

	const values = rawValue
		.split(',')
		.map((value) => value.trim())
		.filter((value) => value.length > 0);

	return values.length > 0 ? values : undefined;
}

function getClockSkewInMs(): number {
	const rawValue = normalizeText(env.CLERK_CLOCK_SKEW_MS);
	if (!rawValue) {
		return 60_000;
	}

	const parsed = Number(rawValue);
	if (!Number.isFinite(parsed) || parsed < 0) {
		return 60_000;
	}

	return Math.min(Math.floor(parsed), 300_000);
}

function getClerkClient() {
	if (!clerkClient) {
		clerkClient = createClerkClient({
			secretKey: getClerkSecretKey()
		});
	}

	return clerkClient;
}

export function readBearerToken(headerValue: string | null): string | null {
	if (!headerValue) {
		return null;
	}

	const match = headerValue.match(/^Bearer\s+(.+)$/i);
	if (!match || !match[1]) {
		return null;
	}

	return match[1].trim();
}

function readDisplayNameFromMetadata(value: unknown): string | null {
	if (!value || typeof value !== 'object') {
		return null;
	}

	const metadata = value as Record<string, unknown>;
	const preferredKeys = ['display_name', 'full_name', 'name'];
	for (const key of preferredKeys) {
		const candidate = metadata[key];
		if (typeof candidate === 'string' && candidate.trim().length > 0) {
			return candidate.trim();
		}
	}

	return null;
}

function readPrimaryEmail(user: User): string | null {
	const primaryEmail = normalizeText(user.primaryEmailAddress?.emailAddress);
	if (primaryEmail) {
		return primaryEmail;
	}

	for (const emailAddress of user.emailAddresses) {
		const candidate = normalizeText(emailAddress.emailAddress);
		if (candidate) {
			return candidate;
		}
	}

	for (const externalAccount of user.externalAccounts ?? []) {
		const candidate = normalizeText(externalAccount.emailAddress);
		if (candidate) {
			return candidate;
		}
	}

	return null;
}

function readDisplayName(user: User): string | null {
	if (typeof user.fullName === 'string') {
		const fullName = normalizeText(user.fullName);
		if (fullName) {
			return fullName;
		}
	}

	const composedName = [normalizeText(user.firstName), normalizeText(user.lastName)]
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

	for (const externalAccount of user.externalAccounts ?? []) {
		const accountName = [normalizeText(externalAccount.firstName), normalizeText(externalAccount.lastName)]
			.filter((value): value is string => Boolean(value))
			.join(' ')
			.trim();
		if (accountName.length > 0) {
			return accountName;
		}

		const accountUsername = normalizeText(externalAccount.username);
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

function readAvatarUrl(user: User): string | null {
	const directAvatar = normalizeText(user.imageUrl);
	if (directAvatar) {
		return directAvatar;
	}

	for (const externalAccount of user.externalAccounts ?? []) {
		const candidate = normalizeText(externalAccount.imageUrl);
		if (candidate) {
			return candidate;
		}
	}

	return null;
}

export async function getUserFromAccessToken(accessToken: string): Promise<SupabaseAuthUser | null> {
	const token = normalizeText(accessToken);
	if (!token) {
		return null;
	}

	let payload: Awaited<ReturnType<typeof verifyToken>>;
	const secretKey = getClerkSecretKey();
	const authorizedParties = getAuthorizedParties();
	const clockSkewInMs = getClockSkewInMs();
	try {
		payload = await verifyToken(token, {
			secretKey,
			authorizedParties,
			clockSkewInMs
		});
	} catch {
		if (authorizedParties && authorizedParties.length > 0) {
			try {
				payload = await verifyToken(token, {
					secretKey,
					clockSkewInMs
				});
			} catch {
				return null;
			}
		} else {
			return null;
		}
	}

	const id = normalizeText(payload?.sub);
	if (!id) {
		return null;
	}

	try {
		const user = await getClerkClient().users.getUser(id);
		return {
			id: user.id,
			email: readPrimaryEmail(user),
			displayName: readDisplayName(user),
			avatarUrl: readAvatarUrl(user)
		};
	} catch {
		const payloadRecord = payload as Record<string, unknown>;
		return {
			id,
			email: typeof payloadRecord.email === 'string' ? normalizeText(payloadRecord.email) : null,
			displayName:
				readDisplayNameFromMetadata(payloadRecord) ??
				(typeof payloadRecord.name === 'string' ? normalizeText(payloadRecord.name) : null),
			avatarUrl:
				typeof payloadRecord.picture === 'string' ? normalizeText(payloadRecord.picture) : null
		};
	}
}
