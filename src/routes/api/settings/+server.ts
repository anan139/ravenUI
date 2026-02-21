import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getUserFromAccessToken, readBearerToken } from '$lib/server/supabase-auth';
import {
	defaultUserSettings,
	getOrCreateUserSettings,
	isMemorySchemaMissingError,
	listUserMemories,
	normalizePersonalizationGuidance,
	upsertUserSettings
} from '$lib/server/user-settings';

function parseBoolean(value: unknown): boolean | undefined {
	return typeof value === 'boolean' ? value : undefined;
}

export const GET: RequestHandler = async ({ request }) => {
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

	try {
		const settings = await getOrCreateUserSettings(user.id);
		const memories = settings.memoryEnabled ? await listUserMemories(user.id, 60) : [];
		return json({
			settings,
			memories,
			storageAvailable: true
		});
	} catch (error) {
		if (isMemorySchemaMissingError(error)) {
			return json({
				settings: defaultUserSettings(user.id),
				memories: [],
				storageAvailable: false,
				warning:
					'Memory schema is not installed yet. Run the SQL in supabase/memory.sql to enable cross-device memory.'
			});
		}

		const messageText = error instanceof Error ? error.message : 'Unexpected server error.';
		return json({ error: messageText }, { status: 500 });
	}
};

export const PATCH: RequestHandler = async ({ request }) => {
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

	const personalizationGuidance =
		typeof payload.personalizationGuidance === 'string'
			? normalizePersonalizationGuidance(payload.personalizationGuidance)
			: undefined;
	const memoryEnabled = parseBoolean(payload.memoryEnabled);
	const autoMemoryEnabled = parseBoolean(payload.autoMemoryEnabled);

	try {
		const settings = await upsertUserSettings(user.id, {
			personalizationGuidance,
			memoryEnabled,
			autoMemoryEnabled
		});

		return json({ settings, storageAvailable: true });
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
