import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getUserFromAccessToken, readBearerToken } from '$lib/server/supabase-auth';
import { deactivateUserMemory, isMemorySchemaMissingError } from '$lib/server/user-settings';

export const DELETE: RequestHandler = async ({ request, params }) => {
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

	const memoryId = Number.parseInt(params.memoryId, 10);
	if (!Number.isInteger(memoryId) || memoryId <= 0) {
		return json({ error: 'Invalid memory id.' }, { status: 400 });
	}

	try {
		const deleted = await deactivateUserMemory(user.id, memoryId);
		if (!deleted) {
			return json({ error: 'Memory not found.' }, { status: 404 });
		}

		return json({ deleted: true, storageAvailable: true });
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
