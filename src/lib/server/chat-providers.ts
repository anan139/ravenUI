import { env } from '$env/dynamic/private';

export type ChatProvider = 'openrouter' | 'koboldcpp';
export type ChatCompletionRole = 'system' | 'user' | 'assistant';

export interface ChatCompletionMessage {
	role: ChatCompletionRole;
	content: string;
}

interface ProviderResult {
	provider: ChatProvider;
	reply: string;
}

const DEFAULT_SYSTEM_PROMPT =
	'You are a helpful assistant. Give concise, useful answers. Do not output chain-of-thought, internal reasoning, or tags like <think>...</think>. Provide only the final answer.';

function getSystemPrompt(): string {
	const customPrompt = typeof env.CHAT_SYSTEM_PROMPT === 'string' ? env.CHAT_SYSTEM_PROMPT.trim() : '';
	return customPrompt.length > 0 ? customPrompt : DEFAULT_SYSTEM_PROMPT;
}

function stripThinkingArtifacts(text: string): string {
	const original = text.trim();
	if (!original) {
		return '';
	}

	const cleaned = original
		.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
		.replace(/<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi, '')
		.replace(/<\/?think\b[^>]*>/gi, '')
		.replace(/<\/?thinking\b[^>]*>/gi, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim();

	return cleaned.length > 0 ? cleaned : original;
}

function ensureTextResponse(payload: unknown): string {
	if (!payload || typeof payload !== 'object') {
		return '';
	}

	const record = payload as Record<string, unknown>;
	const choices = record.choices;
	if (!Array.isArray(choices) || choices.length === 0) {
		return '';
	}

	const first = choices[0];
	if (!first || typeof first !== 'object') {
		return '';
	}

	const firstRecord = first as Record<string, unknown>;
	const message = firstRecord.message;
	if (!message || typeof message !== 'object') {
		return '';
	}

	const content = (message as Record<string, unknown>).content;
	if (typeof content === 'string') {
		return stripThinkingArtifacts(content);
	}

	if (!Array.isArray(content)) {
		return '';
	}

	const merged = content
		.map((part) => {
			if (!part || typeof part !== 'object') {
				return '';
			}
			const text = (part as Record<string, unknown>).text;
			return typeof text === 'string' ? text : '';
		})
		.join('')
		.trim();

	return stripThinkingArtifacts(merged);
}

function normalizeOptionalText(value: unknown): string | null {
	if (typeof value !== 'string') {
		return null;
	}

	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : 'Unknown error.';
}

function parseJsonSafe(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

function readOpenRouterError(payload: unknown): string | null {
	if (!payload || typeof payload !== 'object') {
		return null;
	}

	const record = payload as Record<string, unknown>;
	const errorNode = record.error;
	if (!errorNode || typeof errorNode !== 'object') {
		return null;
	}

	const errorRecord = errorNode as Record<string, unknown>;
	const message = normalizeOptionalText(errorRecord.message) ?? 'Provider returned an error.';
	const code =
		typeof errorRecord.code === 'number' || typeof errorRecord.code === 'string'
			? String(errorRecord.code)
			: null;

	let provider: string | null = null;
	let raw: string | null = null;
	const metadata = errorRecord.metadata;
	if (metadata && typeof metadata === 'object') {
		const metadataRecord = metadata as Record<string, unknown>;
		provider = normalizeOptionalText(metadataRecord.provider_name);
		raw = normalizeOptionalText(metadataRecord.raw);
	}

	const details: string[] = [message];
	if (code) {
		details.push(`code ${code}`);
	}
	if (provider) {
		details.push(`provider ${provider}`);
	}
	if (raw) {
		details.push(raw);
	}

	return details.join(' | ');
}

function getOpenRouterTimeoutMs(): number {
	const rawValue = typeof env.OPENROUTER_TIMEOUT_MS === 'string' ? env.OPENROUTER_TIMEOUT_MS.trim() : '';
	if (!rawValue) {
		return 60_000;
	}

	const parsed = Number(rawValue);
	if (!Number.isFinite(parsed)) {
		return 60_000;
	}

	return Math.min(Math.max(Math.floor(parsed), 1_000), 300_000);
}

function normalizeProvider(value: string | undefined): ChatProvider {
	if (value === 'openrouter') {
		return 'openrouter';
	}
	return 'koboldcpp';
}

function withNoTrailingSlash(url: string): string {
	return url.endsWith('/') ? url.slice(0, -1) : url;
}

function sanitizeMessages(messages: ChatCompletionMessage[]): ChatCompletionMessage[] {
	const sanitized: ChatCompletionMessage[] = messages
		.map((message): ChatCompletionMessage => ({
			role: message.role,
			content: message.content.trim()
		}))
		.filter((message) => message.content.length > 0);

	const baseMessages: ChatCompletionMessage[] =
		sanitized.length > 0 ? sanitized : [{ role: 'user', content: 'Hello' }];
	if (baseMessages.some((message) => message.role === 'system')) {
		return baseMessages;
	}

	return [{ role: 'system', content: getSystemPrompt() }, ...baseMessages];
}

async function callOpenRouter(messages: ChatCompletionMessage[]): Promise<string> {
	const apiKey = env.OPENROUTER_API_KEY;
	if (!apiKey) {
		throw new Error('Missing OPENROUTER_API_KEY.');
	}

	const model = env.OPENROUTER_MODEL || 'deepseek/deepseek-chat';
	const fallbackModel =
		typeof env.OPENROUTER_FALLBACK_MODEL === 'string' ? env.OPENROUTER_FALLBACK_MODEL.trim() : '';
	const siteUrl = env.OPENROUTER_SITE_URL || 'http://localhost:5173';
	const appName = env.OPENROUTER_APP_NAME || 'Raven';
	const timeoutMs = getOpenRouterTimeoutMs();

	const requestOnce = async (modelId: string): Promise<string> => {
		const controller = new AbortController();
		const timeoutHandle = setTimeout(() => {
			controller.abort();
		}, timeoutMs);

		let response: Response;
		try {
			response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
				method: 'POST',
				signal: controller.signal,
				headers: {
					Authorization: `Bearer ${apiKey}`,
					'Content-Type': 'application/json',
					'HTTP-Referer': siteUrl,
					'X-Title': appName
				},
				body: JSON.stringify({
					model: modelId,
					messages: sanitizeMessages(messages)
				})
			});
		} catch (error) {
			if (error instanceof Error && error.name === 'AbortError') {
				throw new Error(`OpenRouter timed out after ${timeoutMs}ms for model "${modelId}".`);
			}
			throw new Error(`OpenRouter request failed for model "${modelId}": ${toErrorMessage(error)}`);
		} finally {
			clearTimeout(timeoutHandle);
		}

		const rawBody = await response.text();
		const payload = rawBody ? parseJsonSafe(rawBody) : null;
		const providerError = readOpenRouterError(payload);

		if (!response.ok) {
			if (providerError) {
				throw new Error(`OpenRouter error (${response.status}) for model "${modelId}": ${providerError}`);
			}
			const details = rawBody.trim() || 'No response body.';
			throw new Error(`OpenRouter error (${response.status}) for model "${modelId}": ${details}`);
		}

		if (providerError) {
			throw new Error(`OpenRouter provider error for model "${modelId}": ${providerError}`);
		}

		const reply = ensureTextResponse(payload);
		if (!reply) {
			throw new Error(`OpenRouter returned an empty completion for model "${modelId}".`);
		}

		return reply;
	};

	try {
		return await requestOnce(model);
	} catch (primaryError) {
		if (!fallbackModel || fallbackModel === model) {
			throw primaryError;
		}

		try {
			return await requestOnce(fallbackModel);
		} catch (fallbackError) {
			throw new Error(
				`OpenRouter primary model "${model}" failed: ${toErrorMessage(primaryError)} Fallback model "${fallbackModel}" failed: ${toErrorMessage(fallbackError)}`
			);
		}
	}
}

async function callKoboldCpp(messages: ChatCompletionMessage[]): Promise<string> {
	const baseUrl = withNoTrailingSlash(env.KOBOLDCPP_URL || 'http://127.0.0.1:5001');
	const model = env.KOBOLDCPP_MODEL || 'koboldcpp';

	const response = await fetch(`${baseUrl}/v1/chat/completions`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			model,
			messages: sanitizeMessages(messages)
		})
	});

	if (!response.ok) {
		const details = await response.text();
		throw new Error(`KoboldCpp error (${response.status}): ${details}`);
	}

	const payload = await response.json();
	const reply = ensureTextResponse(payload);
	if (!reply) {
		throw new Error('KoboldCpp returned an empty completion.');
	}

	return reply;
}

export async function completeChat(messages: ChatCompletionMessage[], requestedProvider?: ChatProvider): Promise<ProviderResult> {
	const defaultProvider = normalizeProvider(env.LLM_PROVIDER);
	const allowProviderOverride = env.ALLOW_PROVIDER_OVERRIDE === 'true';
	const provider = allowProviderOverride && requestedProvider ? requestedProvider : defaultProvider;

	if (provider === 'openrouter') {
		return {
			provider,
			reply: await callOpenRouter(messages)
		};
	}

	return {
		provider,
		reply: await callKoboldCpp(messages)
	};
}
