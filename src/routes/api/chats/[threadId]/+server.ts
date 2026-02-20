import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getUserFromAccessToken, readBearerToken } from '$lib/server/supabase-auth';
import { getThreadForUser, listMessagesForThread } from '$lib/server/chats';

export const GET: RequestHandler = async ({ request, params }) => {
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

	const threadId = params.threadId;
	if (!threadId) {
		return json({ error: 'Missing thread id.' }, { status: 400 });
	}

	try {
		const thread = await getThreadForUser(user.id, threadId);
		if (!thread) {
			return json({ error: 'Chat not found.' }, { status: 404 });
		}

		const messages = await listMessagesForThread(user.id, thread.id);
		return json({ thread, messages });
	} catch (error) {
		const messageText = error instanceof Error ? error.message : 'Unexpected server error.';
		return json({ error: messageText }, { status: 500 });
	}
};
