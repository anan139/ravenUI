import { env } from '$env/dynamic/private';
import type { SupabaseAuthUser } from './supabase-auth';

function normalize(value: string | null | undefined): string {
	return (value ?? '').trim().toLowerCase();
}

export function isAdminUser(user: SupabaseAuthUser): boolean {
	const adminClerkUserId = normalize(env.ADMIN_CLERK_USER_ID);
	if (adminClerkUserId) {
		return normalize(user.id) === adminClerkUserId;
	}

	const adminEmail = normalize(env.ADMIN_EMAIL);
	if (!adminEmail) {
		return false;
	}

	return normalize(user.email) === adminEmail;
}
