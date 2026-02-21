import { env as privateEnv } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';

export type MemoryKind = 'preference' | 'profile' | 'project' | 'other';
export type MemorySource = 'manual' | 'auto';

export interface UserSettingsRecord {
	userId: string;
	personalizationGuidance: string;
	memoryEnabled: boolean;
	autoMemoryEnabled: boolean;
	updatedAt: string;
}

export interface UserMemoryRecord {
	id: number;
	userId: string;
	content: string;
	kind: MemoryKind;
	source: MemorySource;
	confidence: number;
	createdAt: string;
	updatedAt: string;
	lastUsedAt: string | null;
}

export interface AutoMemoryCandidate {
	content: string;
	kind: MemoryKind;
	confidence: number;
}

const MAX_PERSONALIZATION_LENGTH = 1_200;
const MAX_MEMORY_LENGTH = 280;
const MAX_MEMORY_FETCH = 100;
const MAX_AUTO_INSERT_PER_TURN = 3;
const MIN_AUTO_MEMORY_CONFIDENCE = 0.78;

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

function normalizeText(value: unknown, maxLength: number): string {
	if (typeof value !== 'string') {
		return '';
	}

	return value.trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function normalizeMemoryKind(value: unknown): MemoryKind {
	if (value === 'preference' || value === 'profile' || value === 'project' || value === 'other') {
		return value;
	}
	return 'other';
}

function normalizeMemorySource(value: unknown): MemorySource {
	return value === 'auto' ? 'auto' : 'manual';
}

function parseSettingsRow(row: unknown): UserSettingsRecord | null {
	if (!row || typeof row !== 'object') {
		return null;
	}

	const record = row as Record<string, unknown>;
	if (typeof record.user_id !== 'string' || typeof record.updated_at !== 'string') {
		return null;
	}

	return {
		userId: record.user_id,
		personalizationGuidance: normalizeText(record.personalization_guidance, MAX_PERSONALIZATION_LENGTH),
		memoryEnabled: record.memory_enabled !== false,
		autoMemoryEnabled: record.auto_memory_enabled !== false,
		updatedAt: record.updated_at
	};
}

function parseMemoryRow(row: unknown): UserMemoryRecord | null {
	if (!row || typeof row !== 'object') {
		return null;
	}

	const record = row as Record<string, unknown>;
	if (
		typeof record.id !== 'number' ||
		typeof record.user_id !== 'string' ||
		typeof record.content !== 'string' ||
		typeof record.created_at !== 'string' ||
		typeof record.updated_at !== 'string'
	) {
		return null;
	}

	const normalizedContent = normalizeText(record.content, MAX_MEMORY_LENGTH);
	if (!normalizedContent) {
		return null;
	}

	const rawConfidence =
		typeof record.confidence === 'number' ? record.confidence : Number(record.confidence ?? 1);
	const confidence = Number.isFinite(rawConfidence)
		? Math.min(Math.max(rawConfidence, 0), 1)
		: 1;

	return {
		id: record.id,
		userId: record.user_id,
		content: normalizedContent,
		kind: normalizeMemoryKind(record.kind),
		source: normalizeMemorySource(record.source),
		confidence,
		createdAt: record.created_at,
		updatedAt: record.updated_at,
		lastUsedAt: typeof record.last_used_at === 'string' ? record.last_used_at : null
	};
}

function scoreMemoryAgainstPrompt(memory: UserMemoryRecord, promptTokens: Set<string>): number {
	if (promptTokens.size === 0) {
		return 0;
	}

	const memoryTokens = tokenize(memory.content);
	let overlap = 0;
	for (const token of memoryTokens) {
		if (promptTokens.has(token)) {
			overlap += 1;
		}
	}

	return overlap;
}

function tokenize(value: string): Set<string> {
	const words = value
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, ' ')
		.split(/\s+/)
		.filter((token) => token.length >= 3);
	return new Set(words);
}

function toIsoNow(): string {
	return new Date().toISOString();
}

function encodeEq(value: string): string {
	return encodeURIComponent(value);
}

function normalizeCandidate(candidate: AutoMemoryCandidate): AutoMemoryCandidate | null {
	const content = normalizeText(candidate.content, MAX_MEMORY_LENGTH);
	if (!content) {
		return null;
	}

	const confidence = Number.isFinite(candidate.confidence)
		? Math.min(Math.max(candidate.confidence, 0), 1)
		: 0;
	if (confidence < MIN_AUTO_MEMORY_CONFIDENCE) {
		return null;
	}

	return {
		content,
		kind: normalizeMemoryKind(candidate.kind),
		confidence
	};
}

export function defaultUserSettings(userId: string): UserSettingsRecord {
	return {
		userId,
		personalizationGuidance: '',
		memoryEnabled: true,
		autoMemoryEnabled: true,
		updatedAt: toIsoNow()
	};
}

export function normalizePersonalizationGuidance(value: unknown): string {
	return normalizeText(value, MAX_PERSONALIZATION_LENGTH);
}

export function normalizeManualMemoryText(value: unknown): string {
	return normalizeText(value, MAX_MEMORY_LENGTH);
}

export function isMemorySchemaMissingError(error: unknown): boolean {
	const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
	return (
		message.includes('chat_user_settings') ||
		message.includes('chat_user_memories')
	) && message.includes('does not exist');
}

export async function getOrCreateUserSettings(userId: string): Promise<UserSettingsRecord> {
	const encodedUserId = encodeEq(userId);
	const response = await restRequest(
		`/rest/v1/chat_user_settings?select=user_id,personalization_guidance,memory_enabled,auto_memory_enabled,updated_at&user_id=eq.${encodedUserId}&limit=1`
	);
	if (!response.ok) {
		const details = await response.text();
		throw new Error(`Failed to fetch user settings (${response.status}): ${details}`);
	}

	const payload = (await response.json()) as unknown;
	if (Array.isArray(payload) && payload.length > 0) {
		const parsed = parseSettingsRow(payload[0]);
		if (parsed) {
			return parsed;
		}
	}

	return upsertUserSettings(userId, {});
}

export async function upsertUserSettings(
	userId: string,
	patch: {
		personalizationGuidance?: string;
		memoryEnabled?: boolean;
		autoMemoryEnabled?: boolean;
	}
): Promise<UserSettingsRecord> {
	const nextGuidance =
		typeof patch.personalizationGuidance === 'string'
			? normalizePersonalizationGuidance(patch.personalizationGuidance)
			: undefined;
	const nowIso = toIsoNow();

	const row: Record<string, unknown> = {
		user_id: userId,
		updated_at: nowIso
	};
	if (typeof nextGuidance === 'string') {
		row.personalization_guidance = nextGuidance;
	}
	if (typeof patch.memoryEnabled === 'boolean') {
		row.memory_enabled = patch.memoryEnabled;
	}
	if (typeof patch.autoMemoryEnabled === 'boolean') {
		row.auto_memory_enabled = patch.autoMemoryEnabled;
	}

	const response = await restRequest('/rest/v1/chat_user_settings?on_conflict=user_id', {
		method: 'POST',
		headers: {
			Prefer: 'resolution=merge-duplicates,return=representation'
		},
		body: JSON.stringify([row])
	});

	if (!response.ok) {
		const details = await response.text();
		throw new Error(`Failed to update user settings (${response.status}): ${details}`);
	}

	const payload = (await response.json()) as unknown;
	if (!Array.isArray(payload) || payload.length === 0) {
		throw new Error('Failed to update user settings: empty response.');
	}

	const parsed = parseSettingsRow(payload[0]);
	if (!parsed) {
		throw new Error('Failed to update user settings: invalid response.');
	}

	return parsed;
}

export async function listUserMemories(
	userId: string,
	limit = MAX_MEMORY_FETCH
): Promise<UserMemoryRecord[]> {
	const cappedLimit = Math.min(Math.max(Math.floor(limit), 1), MAX_MEMORY_FETCH);
	const encodedUserId = encodeEq(userId);
	const response = await restRequest(
		`/rest/v1/chat_user_memories?select=id,user_id,content,kind,source,confidence,created_at,updated_at,last_used_at&user_id=eq.${encodedUserId}&is_active=eq.true&order=updated_at.desc&limit=${cappedLimit}`
	);
	if (!response.ok) {
		const details = await response.text();
		throw new Error(`Failed to list memories (${response.status}): ${details}`);
	}

	const payload = (await response.json()) as unknown;
	if (!Array.isArray(payload)) {
		return [];
	}

	return payload.map(parseMemoryRow).filter((row): row is UserMemoryRecord => row !== null);
}

export async function createUserMemory(
	userId: string,
	content: string,
	options: {
		kind?: MemoryKind;
		source?: MemorySource;
		confidence?: number;
	} = {}
): Promise<UserMemoryRecord> {
	const normalizedContent = normalizeManualMemoryText(content);
	if (!normalizedContent) {
		throw new Error('Memory text is required.');
	}

	const kind = normalizeMemoryKind(options.kind);
	const source = normalizeMemorySource(options.source);
	const rawConfidence = typeof options.confidence === 'number' ? options.confidence : 1;
	const confidence = Math.min(Math.max(rawConfidence, 0), 1);
	const nowIso = toIsoNow();

	const response = await restRequest('/rest/v1/chat_user_memories', {
		method: 'POST',
		headers: {
			Prefer: 'return=representation'
		},
		body: JSON.stringify([
			{
				user_id: userId,
				content: normalizedContent,
				kind,
				source,
				confidence,
				updated_at: nowIso
			}
		])
	});

	if (!response.ok) {
		const details = await response.text();
		throw new Error(`Failed to create memory (${response.status}): ${details}`);
	}

	const payload = (await response.json()) as unknown;
	if (!Array.isArray(payload) || payload.length === 0) {
		throw new Error('Failed to create memory: empty response.');
	}

	const parsed = parseMemoryRow(payload[0]);
	if (!parsed) {
		throw new Error('Failed to create memory: invalid response.');
	}

	return parsed;
}

export async function deactivateUserMemory(userId: string, memoryId: number): Promise<boolean> {
	if (!Number.isInteger(memoryId) || memoryId <= 0) {
		return false;
	}

	const encodedUserId = encodeEq(userId);
	const response = await restRequest(
		`/rest/v1/chat_user_memories?id=eq.${memoryId}&user_id=eq.${encodedUserId}&is_active=eq.true`,
		{
			method: 'PATCH',
			headers: {
				Prefer: 'return=representation'
			},
			body: JSON.stringify({
				is_active: false,
				updated_at: toIsoNow()
			})
		}
	);

	if (!response.ok) {
		const details = await response.text();
		throw new Error(`Failed to delete memory (${response.status}): ${details}`);
	}

	const payload = (await response.json()) as unknown;
	return Array.isArray(payload) && payload.length > 0;
}

export async function touchMemories(userId: string, memoryIds: number[]): Promise<void> {
	if (memoryIds.length === 0) {
		return;
	}

	const uniqueIds = Array.from(new Set(memoryIds.filter((id) => Number.isInteger(id) && id > 0)));
	const encodedUserId = encodeEq(userId);
	const nowIso = toIsoNow();

	for (const id of uniqueIds) {
		const response = await restRequest(
			`/rest/v1/chat_user_memories?id=eq.${id}&user_id=eq.${encodedUserId}&is_active=eq.true`,
			{
				method: 'PATCH',
				headers: {
					Prefer: 'return=minimal'
				},
				body: JSON.stringify({
					last_used_at: nowIso,
					updated_at: nowIso
				})
			}
		);

		if (!response.ok) {
			const details = await response.text();
			throw new Error(`Failed to touch memory ${id} (${response.status}): ${details}`);
		}
	}
}

export function selectRelevantMemories(
	memories: UserMemoryRecord[],
	latestPrompt: string,
	limit = 8
): UserMemoryRecord[] {
	if (memories.length === 0 || limit <= 0) {
		return [];
	}

	const promptTokens = tokenize(latestPrompt);
	const now = Date.now();

	const scored = memories.map((memory) => {
		const overlap = scoreMemoryAgainstPrompt(memory, promptTokens);
		const updatedAtEpoch = Date.parse(memory.updatedAt);
		const ageDays = Number.isFinite(updatedAtEpoch)
			? Math.max((now - updatedAtEpoch) / (1000 * 60 * 60 * 24), 0)
			: 30;
		const recencyBonus = Math.max(0, 1.5 - ageDays / 20);
		const manualBonus = memory.source === 'manual' ? 0.3 : 0;
		const confidenceBonus = memory.confidence * 0.7;
		const score = overlap * 2 + recencyBonus + manualBonus + confidenceBonus;

		return { memory, overlap, score };
	});

	const hasOverlap = scored.some((item) => item.overlap > 0);
	const sorted = scored
		.filter((item) => (hasOverlap ? item.overlap > 0 : true))
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map((item) => item.memory);

	return sorted;
}

export async function mergeAutoMemories(
	userId: string,
	candidates: AutoMemoryCandidate[],
	existingMemories: UserMemoryRecord[]
): Promise<void> {
	if (candidates.length === 0) {
		return;
	}

	const normalizedExisting = new Set(existingMemories.map((memory) => normalizeMemoryText(memory.content)));
	const deduped: AutoMemoryCandidate[] = [];

	for (const candidate of candidates) {
		const normalized = normalizeCandidate(candidate);
		if (!normalized) {
			continue;
		}

		const key = normalizeMemoryText(normalized.content);
		if (!key || normalizedExisting.has(key)) {
			continue;
		}

		normalizedExisting.add(key);
		deduped.push(normalized);
		if (deduped.length >= MAX_AUTO_INSERT_PER_TURN) {
			break;
		}
	}

	for (const candidate of deduped) {
		await createUserMemory(userId, candidate.content, {
			kind: candidate.kind,
			source: 'auto',
			confidence: candidate.confidence
		});
	}
}

function normalizeMemoryText(value: string): string {
	return value.trim().replace(/\s+/g, ' ').toLowerCase();
}
