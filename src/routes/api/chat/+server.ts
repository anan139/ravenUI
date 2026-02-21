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
import {
	defaultUserSettings,
	getOrCreateUserSettings,
	isMemorySchemaMissingError,
	listUserMemories,
	mergeAutoMemories,
	selectRelevantMemories,
	touchMemories,
	type AutoMemoryCandidate,
	type MemoryKind
} from '$lib/server/user-settings';

interface ChatRequestBody {
	message?: string;
	provider?: ChatProvider;
	attachments?: string[];
	threadId?: string;
	reasoningEnabled?: boolean;
}

const allowedProviders = new Set<ChatProvider>(['koboldcpp', 'openrouter']);
const MAX_MEMORY_PROMPT_ENTRIES = 8;
const MAX_EXTRACTED_MEMORIES = 6;
const MAX_EXTRACTED_CONTENT_LENGTH = 280;
const AUTO_MEMORY_SYSTEM_PROMPT = `You extract long-term user memory for an AI assistant.
Only save stable facts/preferences that should persist across future chats.
Do NOT save temporary requests, one-off tasks, or sensitive secrets.

Return strict JSON only with this shape:
{
  "save": [{"content":"string","kind":"preference|profile|project|other","confidence":0.0}],
  "delete": ["optional old memory text to remove if contradicted"]
}

Rules:
- Keep each "content" concise and standalone.
- Use confidence from 0.0 to 1.0.
- If nothing should be stored, return {"save":[],"delete":[]}.`;

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

function buildSettingsSystemPrompt(personalizationGuidance: string, memoryEntries: string[]): string | null {
	const sections: string[] = [];
	const normalizedGuidance = personalizationGuidance.trim();
	if (normalizedGuidance) {
		sections.push(`Personalization guidance from the user:\n${normalizedGuidance}`);
	}

	if (memoryEntries.length > 0) {
		const memoryList = memoryEntries.map((entry) => `- ${entry}`).join('\n');
		sections.push(`Saved memory about the user:\n${memoryList}`);
	}

	if (sections.length === 0) {
		return null;
	}

	return [
		'Apply these user-specific settings when answering. Follow them unless they conflict with safety rules or the user explicitly overrides them in this chat.',
		...sections
	].join('\n\n');
}

function shouldAttemptAutoMemoryCapture(userMessage: string): boolean {
	const normalized = userMessage.trim().toLowerCase();
	if (normalized.length < 14) {
		return false;
	}

	return /(i (prefer|like|love|hate|am|work|use|want)|my (name|timezone|project|role|company|goal)|call me|remember that|i usually|i always|i never)/.test(
		normalized
	);
}

function parseJsonObjectFromText(text: string): Record<string, unknown> | null {
	const candidates: string[] = [];
	const trimmed = text.trim();
	if (trimmed) {
		candidates.push(trimmed);
	}

	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenced && fenced[1]) {
		candidates.push(fenced[1].trim());
	}

	const objectStart = trimmed.indexOf('{');
	const objectEnd = trimmed.lastIndexOf('}');
	if (objectStart >= 0 && objectEnd > objectStart) {
		candidates.push(trimmed.slice(objectStart, objectEnd + 1));
	}

	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate) as unknown;
			if (parsed && typeof parsed === 'object') {
				return parsed as Record<string, unknown>;
			}
		} catch {
			continue;
		}
	}

	return null;
}

function normalizeKind(value: unknown): MemoryKind {
	return value === 'preference' || value === 'profile' || value === 'project' || value === 'other'
		? value
		: 'other';
}

function parseAutoMemoryCandidates(payload: Record<string, unknown> | null): AutoMemoryCandidate[] {
	if (!payload) {
		return [];
	}

	const saveList = payload.save;
	if (!Array.isArray(saveList)) {
		return [];
	}

	return saveList
		.map((entry) => {
			if (!entry || typeof entry !== 'object') {
				return null;
			}

			const record = entry as Record<string, unknown>;
			const rawContent = typeof record.content === 'string' ? record.content : '';
			const content = rawContent.trim().replace(/\s+/g, ' ').slice(0, MAX_EXTRACTED_CONTENT_LENGTH);
			if (!content) {
				return null;
			}

			const rawConfidence =
				typeof record.confidence === 'number' ? record.confidence : Number(record.confidence ?? 0);
			const confidence = Number.isFinite(rawConfidence)
				? Math.min(Math.max(rawConfidence, 0), 1)
				: 0;

			return {
				content,
				kind: normalizeKind(record.kind),
				confidence
			} satisfies AutoMemoryCandidate;
		})
		.filter((entry): entry is AutoMemoryCandidate => entry !== null)
		.slice(0, MAX_EXTRACTED_MEMORIES);
}

async function extractAutoMemoryCandidates(
	userMessage: string,
	assistantReply: string,
	provider: ChatProvider
): Promise<AutoMemoryCandidate[]> {
	const extractorInput = [
		`User message:\n${userMessage}`,
		`Assistant reply:\n${assistantReply}`,
		`Current UTC timestamp: ${new Date().toISOString()}`,
		'Return JSON only.'
	].join('\n\n');

	const extractionMessages: ChatCompletionMessage[] = [
		{
			role: 'system',
			content: AUTO_MEMORY_SYSTEM_PROMPT
		},
		{
			role: 'user',
			content: extractorInput
		}
	];

	const extraction = await completeChat(extractionMessages, provider, false);
	const parsedPayload = parseJsonObjectFromText(extraction.reply);
	return parseAutoMemoryCandidates(parsedPayload);
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

		let memoryStorageAvailable = true;
		let userSettings = defaultUserSettings(user.id);
		let userMemories: Awaited<ReturnType<typeof listUserMemories>> = [];

		try {
			userSettings = await getOrCreateUserSettings(user.id);
			if (userSettings.memoryEnabled) {
				userMemories = await listUserMemories(user.id, 80);
			}
		} catch (memoryError) {
			console.error(memoryError);
			memoryStorageAvailable = false;
			if (!isMemorySchemaMissingError(memoryError)) {
				userSettings = defaultUserSettings(user.id);
			}
		}

		const relevantMemories =
			userSettings.memoryEnabled && memoryStorageAvailable
				? selectRelevantMemories(userMemories, message, MAX_MEMORY_PROMPT_ENTRIES)
				: [];
		const settingsSystemPrompt = buildSettingsSystemPrompt(
			userSettings.personalizationGuidance,
			relevantMemories.map((memory) => memory.content)
		);

		const messagesForModel: ChatCompletionMessage[] = settingsSystemPrompt
			? [{ role: 'system', content: settingsSystemPrompt }, ...modelMessages]
			: modelMessages;
		const completion = await completeChat(messagesForModel, requestedProvider, reasoningEnabled);

		await addMessageToThread(user.id, thread.id, 'assistant', completion.reply, []);
		await touchThread(thread.id);

		if (memoryStorageAvailable && userSettings.memoryEnabled && relevantMemories.length > 0) {
			void touchMemories(
				user.id,
				relevantMemories.map((memory) => memory.id)
			).catch((error) => {
				console.error(error);
			});
		}

		if (
			memoryStorageAvailable &&
			userSettings.memoryEnabled &&
			userSettings.autoMemoryEnabled &&
			shouldAttemptAutoMemoryCapture(message)
		) {
			void extractAutoMemoryCandidates(message, completion.reply, completion.provider)
				.then(async (candidates) => {
					if (candidates.length === 0) {
						return;
					}
					await mergeAutoMemories(user.id, candidates, userMemories);
				})
				.catch((error) => {
					console.error(error);
				});
		}

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
