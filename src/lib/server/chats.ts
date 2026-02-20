import { env as privateEnv } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';

export type StoredMessageRole = 'user' | 'assistant';

export interface ChatThreadSummary {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
}

export interface ChatMessageRecord {
	id: number;
	threadId: string;
	role: StoredMessageRole;
	content: string;
	attachments: string[];
	createdAt: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
	return UUID_PATTERN.test(value);
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

async function restRequest(pathWithQuery: string, init: RequestInit = {}) {
	const { url, serviceRoleKey } = getSupabaseConfig();
	const headers = new Headers(init.headers ?? {});
	headers.set('apikey', serviceRoleKey);
	headers.set('Authorization', `Bearer ${serviceRoleKey}`);
	if (!headers.has('Content-Type') && init.body) {
		headers.set('Content-Type', 'application/json');
	}

	return fetch(`${url}${pathWithQuery}`, {
		...init,
		headers
	});
}

function normalizeAttachments(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
}

function parseThreadRow(row: unknown): ChatThreadSummary | null {
	if (!row || typeof row !== 'object') {
		return null;
	}

	const record = row as Record<string, unknown>;
	if (
		typeof record.id !== 'string' ||
		typeof record.title !== 'string' ||
		typeof record.created_at !== 'string' ||
		typeof record.updated_at !== 'string'
	) {
		return null;
	}

	return {
		id: record.id,
		title: record.title,
		createdAt: record.created_at,
		updatedAt: record.updated_at
	};
}

function parseMessageRow(row: unknown): ChatMessageRecord | null {
	if (!row || typeof row !== 'object') {
		return null;
	}

	const record = row as Record<string, unknown>;
	if (
		typeof record.id !== 'number' ||
		typeof record.thread_id !== 'string' ||
		(record.role !== 'user' && record.role !== 'assistant') ||
		typeof record.content !== 'string' ||
		typeof record.created_at !== 'string'
	) {
		return null;
	}

	return {
		id: record.id,
		threadId: record.thread_id,
		role: record.role,
		content: record.content,
		attachments: normalizeAttachments(record.attachments),
		createdAt: record.created_at
	};
}

export function normalizeThreadTitle(message: string): string {
	const normalized = message.trim().replace(/\s+/g, ' ');
	if (!normalized) {
		return 'New chat';
	}
	return normalized.slice(0, 60);
}

export async function listThreadsForUser(userId: string): Promise<ChatThreadSummary[]> {
	const response = await restRequest(
		`/rest/v1/chat_threads?select=id,title,created_at,updated_at&user_id=eq.${userId}&order=updated_at.desc`
	);
	if (!response.ok) {
		const details = await response.text();
		throw new Error(`Failed to list chats (${response.status}): ${details}`);
	}

	const payload = (await response.json()) as unknown;
	if (!Array.isArray(payload)) {
		return [];
	}

	return payload.map(parseThreadRow).filter((row): row is ChatThreadSummary => row !== null);
}

export async function getThreadForUser(userId: string, threadId: string): Promise<ChatThreadSummary | null> {
	if (!isUuid(threadId)) {
		return null;
	}

	const response = await restRequest(
		`/rest/v1/chat_threads?select=id,title,created_at,updated_at&id=eq.${threadId}&user_id=eq.${userId}&limit=1`
	);
	if (!response.ok) {
		const details = await response.text();
		throw new Error(`Failed to fetch chat (${response.status}): ${details}`);
	}

	const payload = (await response.json()) as unknown;
	if (!Array.isArray(payload) || payload.length === 0) {
		return null;
	}

	return parseThreadRow(payload[0]);
}

export async function createThreadForUser(userId: string, title: string): Promise<ChatThreadSummary> {
	const response = await restRequest('/rest/v1/chat_threads', {
		method: 'POST',
		headers: {
			Prefer: 'return=representation'
		},
		body: JSON.stringify([
			{
				user_id: userId,
				title: normalizeThreadTitle(title)
			}
		])
	});

	if (!response.ok) {
		const details = await response.text();
		throw new Error(`Failed to create chat (${response.status}): ${details}`);
	}

	const payload = (await response.json()) as unknown;
	if (!Array.isArray(payload) || payload.length === 0) {
		throw new Error('Failed to create chat: empty response.');
	}

	const thread = parseThreadRow(payload[0]);
	if (!thread) {
		throw new Error('Failed to create chat: invalid response.');
	}

	return thread;
}

export async function listMessagesForThread(userId: string, threadId: string): Promise<ChatMessageRecord[]> {
	if (!isUuid(threadId)) {
		return [];
	}

	const response = await restRequest(
		`/rest/v1/chat_messages?select=id,thread_id,role,content,attachments,created_at&thread_id=eq.${threadId}&user_id=eq.${userId}&order=created_at.asc`
	);
	if (!response.ok) {
		const details = await response.text();
		throw new Error(`Failed to list chat messages (${response.status}): ${details}`);
	}

	const payload = (await response.json()) as unknown;
	if (!Array.isArray(payload)) {
		return [];
	}

	return payload.map(parseMessageRow).filter((row): row is ChatMessageRecord => row !== null);
}

export async function addMessageToThread(
	userId: string,
	threadId: string,
	role: StoredMessageRole,
	content: string,
	attachments: string[] = []
): Promise<ChatMessageRecord> {
	if (!isUuid(threadId)) {
		throw new Error('Invalid thread id.');
	}

	const response = await restRequest('/rest/v1/chat_messages', {
		method: 'POST',
		headers: {
			Prefer: 'return=representation'
		},
		body: JSON.stringify([
			{
				thread_id: threadId,
				user_id: userId,
				role,
				content,
				attachments
			}
		])
	});

	if (!response.ok) {
		const details = await response.text();
		throw new Error(`Failed to save chat message (${response.status}): ${details}`);
	}

	const payload = (await response.json()) as unknown;
	if (!Array.isArray(payload) || payload.length === 0) {
		throw new Error('Failed to save chat message: empty response.');
	}

	const message = parseMessageRow(payload[0]);
	if (!message) {
		throw new Error('Failed to save chat message: invalid response.');
	}

	return message;
}

export async function touchThread(threadId: string): Promise<void> {
	if (!isUuid(threadId)) {
		return;
	}

	const response = await restRequest(`/rest/v1/chat_threads?id=eq.${threadId}`, {
		method: 'PATCH',
		headers: {
			Prefer: 'return=minimal'
		},
		body: JSON.stringify({
			updated_at: new Date().toISOString()
		})
	});

	if (!response.ok) {
		const details = await response.text();
		throw new Error(`Failed to update chat timestamp (${response.status}): ${details}`);
	}
}
