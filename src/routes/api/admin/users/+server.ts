import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createClerkClient, type User } from '@clerk/backend';
import { env as privateEnv } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import { getUserFromAccessToken, readBearerToken } from '$lib/server/supabase-auth';
import { isAdminUser } from '$lib/server/admin';
import { setUserRole, type UserRole } from '$lib/server/quota';

interface AdminUserSummary {
	id: string;
	email: string | null;
	displayName: string | null;
	role: UserRole;
	createdAt: string | null;
	lastSignInAt: string | null;
}

const allowedRoles = new Set<UserRole>(['base', 'vip']);
let clerkClient: ReturnType<typeof createClerkClient> | null = null;

function normalizeText(value: string | null | undefined): string | null {
	if (typeof value !== 'string') {
		return null;
	}

	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function getSupabaseConfig() {
	const url = privateEnv.SUPABASE_URL || publicEnv.PUBLIC_SUPABASE_URL;
	const serviceRoleKey = privateEnv.SUPABASE_SERVICE_ROLE_KEY;

	if (!url) {
		throw new Error('Missing SUPABASE_URL or PUBLIC_SUPABASE_URL.');
	}
	if (!serviceRoleKey) {
		throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY.');
	}

	return {
		url: url.endsWith('/') ? url.slice(0, -1) : url,
		serviceRoleKey
	};
}

function getClerkClient() {
	const secretKey = normalizeText(privateEnv.CLERK_SECRET_KEY);
	if (!secretKey) {
		throw new Error('Missing CLERK_SECRET_KEY.');
	}

	if (!clerkClient) {
		clerkClient = createClerkClient({ secretKey });
	}

	return clerkClient;
}

function toRole(value: unknown): UserRole {
	if (value === 'vip') {
		return value;
	}
	if (value === 'dev' || value === 'creator') {
		return 'dev';
	}
	return 'base';
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

	return null;
}

function readDisplayName(user: User): string | null {
	const fullName = normalizeText(user.fullName);
	if (fullName) {
		return fullName;
	}

	const composedName = [normalizeText(user.firstName), normalizeText(user.lastName)]
		.filter((value): value is string => Boolean(value))
		.join(' ')
		.trim();
	if (composedName.length > 0) {
		return composedName;
	}

	return normalizeText(user.username);
}

function timestampToIso(value: number | null): string | null {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
		return null;
	}

	const dateValue = new Date(value);
	if (Number.isNaN(dateValue.valueOf())) {
		return null;
	}

	return dateValue.toISOString();
}

async function listRoleMap(): Promise<Map<string, UserRole>> {
	const { url, serviceRoleKey } = getSupabaseConfig();
	const response = await fetch(`${url}/rest/v1/chat_user_roles?select=user_id,role`, {
		headers: {
			apikey: serviceRoleKey,
			Authorization: `Bearer ${serviceRoleKey}`
		}
	});

	if (!response.ok) {
		const details = await response.text();
		throw new Error(`Failed to list roles (${response.status}): ${details}`);
	}

	const payload = (await response.json()) as unknown;
	const map = new Map<string, UserRole>();
	if (!Array.isArray(payload)) {
		return map;
	}

	for (const row of payload) {
		if (!row || typeof row !== 'object') {
			continue;
		}

		const record = row as Record<string, unknown>;
		if (typeof record.user_id !== 'string') {
			continue;
		}
		map.set(record.user_id, toRole(record.role));
	}

	return map;
}

async function listClerkUsers(): Promise<AdminUserSummary[]> {
	const clerk = getClerkClient();
	const roleMap = await listRoleMap();
	const users: User[] = [];
	const pageSize = 100;
	let offset = 0;
	let totalCount = Number.POSITIVE_INFINITY;

	while (offset < 1000 && users.length < totalCount) {
		const page = await clerk.users.getUserList({
			limit: pageSize,
			offset
		});

		if (!Array.isArray(page.data) || page.data.length === 0) {
			break;
		}

		users.push(...page.data);
		totalCount = typeof page.totalCount === 'number' ? page.totalCount : users.length;
		offset += page.data.length;
	}

	const summaries: AdminUserSummary[] = [];
	for (const user of users) {
		summaries.push({
			id: user.id,
			email: readPrimaryEmail(user),
			displayName: readDisplayName(user),
			role: roleMap.get(user.id) ?? 'base',
			createdAt: timestampToIso(user.createdAt),
			lastSignInAt: timestampToIso(user.lastSignInAt)
		});
	}

	return summaries.sort((a, b) => {
		const aTime = a.createdAt ? Date.parse(a.createdAt) : 0;
		const bTime = b.createdAt ? Date.parse(b.createdAt) : 0;
		return bTime - aTime;
	});
}

async function requireAdmin(request: Request) {
	const accessToken = readBearerToken(request.headers.get('authorization'));
	if (!accessToken) {
		return { ok: false as const, response: json({ error: 'Unauthorized.' }, { status: 401 }) };
	}

	let user: Awaited<ReturnType<typeof getUserFromAccessToken>>;
	try {
		user = await getUserFromAccessToken(accessToken);
	} catch (error) {
		const messageText = error instanceof Error ? error.message : 'Unexpected server error.';
		return { ok: false as const, response: json({ error: messageText }, { status: 500 }) };
	}

	if (!user) {
		return { ok: false as const, response: json({ error: 'Unauthorized.' }, { status: 401 }) };
	}

	if (!isAdminUser(user)) {
		return { ok: false as const, response: json({ error: 'Forbidden.' }, { status: 403 }) };
	}

	return { ok: true as const, user };
}

export const GET: RequestHandler = async ({ request }) => {
	const adminCheck = await requireAdmin(request);
	if (!adminCheck.ok) {
		return adminCheck.response;
	}

	try {
		const users = await listClerkUsers();
		return json({ users });
	} catch (error) {
		const messageText = error instanceof Error ? error.message : 'Unexpected server error.';
		return json({ error: messageText }, { status: 500 });
	}
};

export const PATCH: RequestHandler = async ({ request }) => {
	const adminCheck = await requireAdmin(request);
	if (!adminCheck.ok) {
		return adminCheck.response;
	}

	let body: { userId?: string; role?: UserRole };
	try {
		body = (await request.json()) as { userId?: string; role?: UserRole };
	} catch {
		return json({ error: 'Invalid JSON payload.' }, { status: 400 });
	}

	if (typeof body.userId !== 'string' || body.userId.trim().length === 0) {
		return json({ error: 'userId is required.' }, { status: 400 });
	}

	if (!body.role || !allowedRoles.has(body.role)) {
		return json({ error: 'Invalid role. Only base and vip can be assigned from admin panel.' }, { status: 400 });
	}

	try {
		const role = await setUserRole(body.userId.trim(), body.role);
		return json({ userId: body.userId.trim(), role });
	} catch (error) {
		const messageText = error instanceof Error ? error.message : 'Unexpected server error.';
		return json({ error: messageText }, { status: 500 });
	}
};
