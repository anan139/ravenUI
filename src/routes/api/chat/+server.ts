import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { completeChat, type ChatProvider, type ChatCompletionMessage } from '$lib/server/chat-providers';
import { consumeDailyQuota } from '$lib/server/quota';
import { getUserFromAccessToken, readBearerToken } from '$lib/server/supabase-auth';
import {
	addMessageToThread,
	createThreadForUser,
	getThreadForUser,
	listMessagesForThread,
	normalizeThreadTitle,
	touchThread
} from '$lib/server/chats';
import { isAdminUser } from '$lib/server/admin';

interface ChatRequestBody {
	message?: string;
	provider?: ChatProvider;
	attachments?: string[];
	threadId?: string;
	reasoningEnabled?: boolean;
}

const allowedProviders = new Set<ChatProvider>(['koboldcpp', 'openrouter']);

function normalizeAttachments(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
}

function formatUserMessageForModel(content: string, attachments: string[]): string {
	if (attachments.length === 0) {
		return content;
	}

	return `${content}\n\nAttached files (names only): ${attachments.join(', ')}`;
}

function toModelMessages(history: Awaited<ReturnType<typeof listMessagesForThread>>): ChatCompletionMessage[] {
	const slice = history.slice(-20);
	return slice.map((message) => {
		if (message.role === 'user' && message.attachments.length > 0) {
			return {
				role: 'user',
				content: formatUserMessageForModel(message.content, message.attachments)
			};
		}

		return {
			role: message.role,
			content: message.content
		};
	});
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

	let body: ChatRequestBody;
	try {
		body = (await request.json()) as ChatRequestBody;
	} catch {
		return json({ error: 'Invalid JSON payload.' }, { status: 400 });
	}

	const message = typeof body.message === 'string' ? body.message.trim() : '';
	if (!message) {
		return json({ error: 'Message is required.' }, { status: 400 });
	}

	const attachments = normalizeAttachments(body.attachments);
	const reasoningEnabled = body.reasoningEnabled === true;
	const isAdmin = isAdminUser(user);
	const requestedProvider =
		isAdmin && body.provider && allowedProviders.has(body.provider) ? body.provider : undefined;

	try {
		const quota = await consumeDailyQuota(user.id);
		if (!quota.allowed) {
			return json(
				{
					error: "You're cut off! Go outside. Touch some grass.",
					quota
				},
				{ status: 429 }
			);
		}

		let thread =
			typeof body.threadId === 'string' && body.threadId.trim().length > 0
				? await getThreadForUser(user.id, body.threadId.trim())
				: null;

		if (!thread) {
			thread = await createThreadForUser(user.id, normalizeThreadTitle(message));
		}

		await addMessageToThread(user.id, thread.id, 'user', message, attachments);

		const persistedMessages = await listMessagesForThread(user.id, thread.id);
		const modelMessages = toModelMessages(persistedMessages);
		const completion = await completeChat(modelMessages, requestedProvider, reasoningEnabled);

		await addMessageToThread(user.id, thread.id, 'assistant', completion.reply, []);
		await touchThread(thread.id);

		return json({
			reply: completion.reply,
			provider: completion.provider,
			quota,
			threadId: thread.id
		});
	} catch (error) {
		const messageText = error instanceof Error ? error.message : 'Unexpected server error.';
		return json({ error: messageText }, { status: 500 });
	}
};
