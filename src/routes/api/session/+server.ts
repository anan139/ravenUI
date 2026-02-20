import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ensureUserRole, setUserRole } from '$lib/server/quota';
import { getUserFromAccessToken, readBearerToken } from '$lib/server/supabase-auth';
import { isAdminUser } from '$lib/server/admin';

export const GET: RequestHandler = async ({ request }) => {
	const accessToken = readBearerToken(request.headers.get('authorization'));
	if (!accessToken) {
		return json({ error: 'Unauthorized. Missing bearer token.' }, { status: 401 });
	}

	try {
		const user = await getUserFromAccessToken(accessToken);
		if (!user) {
			return json({ error: 'Unauthorized. Invalid or expired session.' }, { status: 401 });
		}

		let role = await ensureUserRole(user.id);
		const isAdmin = isAdminUser(user);
		if (isAdmin && role !== 'dev') {
			role = await setUserRole(user.id, 'dev');
		}

		return json({
			user,
			role,
			isAdmin
		});
	} catch (error) {
		const messageText = error instanceof Error ? error.message : 'Unexpected server error.';
		return json({ error: messageText }, { status: 500 });
	}
};
