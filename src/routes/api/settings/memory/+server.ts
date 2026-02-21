import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getUserFromAccessToken, readBearerToken } from '$lib/server/supabase-auth';
import {
	createUserMemory,
	isMemorySchemaMissingError,
	normalizeManualMemoryText,
	type MemoryKind
} from '$lib/server/user-settings';

function normalizeKind(value: unknown): MemoryKind {
	return value === 'preference' || value === 'profile' || value === 'project' || value === 'other'
		? value
		: 'other';
}

export const POST: RequestHandler = async ({ request }) => {
	const accessToken = readBearerToken(request.headers.get('authorization'));
	if (!accessToken) {
		return json({ error: 'Unauthorized. Missing bearer token.' }, { status: 401 });
	}

	let user: Awaited<ReturnType<typeof getUserFromAccessToken>>;
	try {
		user = await getUserFromAccessToken(accessToken);
	} catch (error) {
		const messageText = error instanceof Error ? error.message : 'Unexpected server error.';
		return json({ error: messageText }, { status: 500 });
	}

	if (!user) {
		return json({ error: 'Unauthorized. Invalid or expired session.' }, { status: 401 });
	}

	let payload: Record<string, unknown>;
	try {
		payload = (await request.json()) as Record<string, unknown>;
	} catch {
		return json({ error: 'Invalid JSON payload.' }, { status: 400 });
	}

	const content = normalizeManualMemoryText(payload.content);
	if (!content) {
		return json({ error: 'Memory text is required.' }, { status: 400 });
	}

	try {
		const memory = await createUserMemory(user.id, content, {
			kind: normalizeKind(payload.kind),
			source: 'manual',
			confidence: 1
		});
		return json({ memory, storageAvailable: true });
	} catch (error) {
		if (isMemorySchemaMissingError(error)) {
			return json(
				{
					error:
						'Memory schema is not installed yet. Run the SQL in supabase/memory.sql to enable cross-device memory.'
				},
				{ status: 503 }
			);
		}

		const messageText = error instanceof Error ? error.message : 'Unexpected server error.';
		return json({ error: messageText }, { status: 500 });
	}
};
