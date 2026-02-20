import { env as privateEnv } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';

export type UserRole = 'base' | 'vip' | 'dev';

export interface QuotaResult {
	allowed: boolean;
	role: UserRole;
	used: number;
	limit: number;
	remaining: number;
}

function toNumber(value: unknown): number {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === 'string') {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}
	return 0;
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

function toDatabaseRole(role: UserRole): 'base' | 'vip' | 'creator' {
	if (role === 'dev') {
		return 'creator';
	}
	return role;
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

	return { url, serviceRoleKey };
}

async function callRpc(functionName: string, payload: Record<string, unknown>) {
	const { url, serviceRoleKey } = getSupabaseConfig();
	const response = await fetch(`${url}/rest/v1/rpc/${functionName}`, {
		method: 'POST',
		headers: {
			apikey: serviceRoleKey,
			Authorization: `Bearer ${serviceRoleKey}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(payload)
	});

	if (!response.ok) {
		const details = await response.text();
		if (details.includes('invalid input syntax for type uuid')) {
			throw new Error(
				'Supabase schema still expects UUID user ids. Re-run supabase/setup.sql to migrate user_id columns/functions to text.'
			);
		}
		throw new Error(`Supabase RPC ${functionName} failed (${response.status}): ${details}`);
	}

	return (await response.json()) as unknown;
}

async function callTable(
	pathWithQuery: string,
	init: RequestInit
): Promise<unknown> {
	const { url, serviceRoleKey } = getSupabaseConfig();
	const headers = new Headers(init.headers ?? {});
	headers.set('apikey', serviceRoleKey);
	headers.set('Authorization', `Bearer ${serviceRoleKey}`);
	if (!headers.has('Content-Type')) {
		headers.set('Content-Type', 'application/json');
	}

	const response = await fetch(`${url}/rest/v1/${pathWithQuery}`, {
		...init,
		headers
	});

	if (!response.ok) {
		const details = await response.text();
		if (details.includes('invalid input syntax for type uuid')) {
			throw new Error(
				'Supabase schema still expects UUID user ids. Re-run supabase/setup.sql to migrate user_id columns/functions to text.'
			);
		}
		throw new Error(`Supabase table request failed (${response.status}): ${details}`);
	}

	return (await response.json()) as unknown;
}

export async function ensureUserRole(userId: string): Promise<UserRole> {
	const payload = await callRpc('ensure_chat_user_role', { p_user_id: userId });
	if (typeof payload === 'string') {
		return toRole(payload);
	}

	if (Array.isArray(payload) && typeof payload[0] === 'string') {
		return toRole(payload[0]);
	}

	return 'base';
}

export async function consumeDailyQuota(userId: string): Promise<QuotaResult> {
	const payload = await callRpc('consume_daily_message_quota', { p_user_id: userId });
	const row = Array.isArray(payload) ? payload[0] : payload;

	if (!row || typeof row !== 'object') {
		throw new Error('Supabase quota RPC returned an invalid payload.');
	}

	const record = row as Record<string, unknown>;
	const used = toNumber(record.used);
	const limit = toNumber(record.quota_limit);
	const remaining = toNumber(record.remaining);

	return {
		allowed: Boolean(record.allowed),
		role: toRole(record.role_name),
		used,
		limit,
		remaining
	};
}

export async function setUserRole(userId: string, role: UserRole): Promise<UserRole> {
	const databaseRole = toDatabaseRole(role);
	const payload = await callTable('chat_user_roles?on_conflict=user_id', {
		method: 'POST',
		headers: {
			Prefer: 'resolution=merge-duplicates,return=representation'
		},
		body: JSON.stringify([
			{
				user_id: userId,
				role: databaseRole,
				updated_at: new Date().toISOString()
			}
		])
	});

	const row = Array.isArray(payload) ? payload[0] : payload;
	if (!row || typeof row !== 'object') {
		return role;
	}

	const record = row as Record<string, unknown>;
	return toRole(record.role);
}
