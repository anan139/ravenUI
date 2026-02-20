<script lang="ts">
	import { onMount } from 'svelte';
	import { resolveClientSession } from '$lib/client/auth';

	type Role = 'base' | 'vip' | 'dev';

	interface AdminUser {
		id: string;
		email: string | null;
		displayName: string | null;
		role: Role;
		createdAt: string | null;
		lastSignInAt: string | null;
	}

	let isLoading = true;
	let errorMessage = '';
	let users: AdminUser[] = [];
	let savingRoleFor: Record<string, boolean> = {};
	let selectedRoleByUserId: Record<string, Role> = {};
	let accessToken = '';

	function formatDate(value: string | null): string {
		if (!value) {
			return '-';
		}
		const parsed = Date.parse(value);
		if (Number.isNaN(parsed)) {
			return '-';
		}
		return new Intl.DateTimeFormat(undefined, {
			dateStyle: 'medium',
			timeStyle: 'short'
		}).format(new Date(parsed));
	}

	async function refreshAccessToken(): Promise<boolean> {
		const session = await resolveClientSession();
		if (!session) {
			accessToken = '';
			return false;
		}

		accessToken = session.accessToken;
		return true;
	}

	async function authorizedFetch(
		input: RequestInfo | URL,
		init: RequestInit = {},
		retryOnUnauthorized = true
	): Promise<Response | null> {
		if (!accessToken) {
			const refreshed = await refreshAccessToken();
			if (!refreshed) {
				return null;
			}
		}

		const headers = new Headers(init.headers ?? {});
		headers.set('Authorization', `Bearer ${accessToken}`);

		let response = await fetch(input, {
			...init,
			headers
		});

		if (response.status !== 401 || !retryOnUnauthorized) {
			return response;
		}

		const refreshed = await refreshAccessToken();
		if (!refreshed) {
			return response;
		}

		headers.set('Authorization', `Bearer ${accessToken}`);
		response = await fetch(input, {
			...init,
			headers
		});
		return response;
	}

	async function loadUsers() {
		isLoading = true;
		errorMessage = '';
		try {
			const response = await authorizedFetch('/api/admin/users');
			if (!response) {
				errorMessage = 'No active session found. Please sign in first.';
				return;
			}

			const payload = await response.json();
			if (!response.ok) {
				throw new Error(payload?.error ?? 'Failed to load admin users.');
			}

			users = Array.isArray(payload?.users)
				? payload.users.filter(
					(row: unknown): row is AdminUser =>
						Boolean(
							row &&
							typeof row === 'object' &&
							typeof (row as Record<string, unknown>).id === 'string' &&
							((row as Record<string, unknown>).role === 'base' ||
								(row as Record<string, unknown>).role === 'vip' ||
								(row as Record<string, unknown>).role === 'dev')
						)
				  )
				: [];

			selectedRoleByUserId = {};
			for (const user of users) {
				selectedRoleByUserId[user.id] = user.role;
			}
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Failed to load users.';
		} finally {
			isLoading = false;
		}
	}

	async function saveRole(userId: string) {
		const role = selectedRoleByUserId[userId];
		if (!role) {
			return;
		}

		savingRoleFor = { ...savingRoleFor, [userId]: true };
		errorMessage = '';
		try {
			const response = await authorizedFetch('/api/admin/users', {
				method: 'PATCH',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					userId,
					role
				})
			});

			if (!response) {
				throw new Error('No active session found. Please sign in first.');
			}

			const payload = await response.json();
			if (!response.ok) {
				throw new Error(payload?.error ?? 'Failed to update role.');
			}

			users = users.map((user) => (user.id === userId ? { ...user, role } : user));
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Failed to update role.';
		} finally {
			savingRoleFor = { ...savingRoleFor, [userId]: false };
		}
	}

	onMount(() => {
		void loadUsers();
	});
</script>

<div class="min-h-screen bg-base-100 px-4 py-6 text-base-content sm:px-6">
	<div class="mx-auto max-w-6xl">
		<div class="mb-4 flex items-center justify-between gap-3">
			<div>
				<h1 class="text-2xl font-semibold">Admin Panel</h1>
				<p class="text-sm text-base-content/65">Manage user roles for Raven</p>
			</div>
			<a class="btn btn-outline btn-sm" href="/">Back to chat</a>
		</div>

		{#if errorMessage}
			<div class="alert alert-warning mb-4">
				<span>{errorMessage}</span>
			</div>
		{/if}

		<div class="overflow-x-auto rounded-box border border-base-300 bg-base-200/50">
			<table class="table table-sm sm:table-md">
				<thead>
					<tr>
						<th>Name</th>
						<th>Email</th>
						<th>Role</th>
						<th>Created</th>
						<th>Last Sign In</th>
						<th></th>
					</tr>
				</thead>
				<tbody>
					{#if isLoading}
						<tr>
							<td colspan="6" class="py-8 text-center text-sm text-base-content/60">Loading users...</td>
						</tr>
					{:else if users.length === 0}
						<tr>
							<td colspan="6" class="py-8 text-center text-sm text-base-content/60">No users found.</td>
						</tr>
					{:else}
						{#each users as user}
							<tr>
								<td>{user.displayName ?? '-'}</td>
								<td>{user.email ?? '-'}</td>
								<td>
									<select
										class="select select-bordered select-sm w-28"
										bind:value={selectedRoleByUserId[user.id]}
									>
										<option value="base">Base</option>
										<option value="vip">VIP</option>
										<option value="dev">Dev</option>
									</select>
								</td>
								<td>{formatDate(user.createdAt)}</td>
								<td>{formatDate(user.lastSignInAt)}</td>
								<td>
									<button
										type="button"
										class="btn btn-primary btn-sm"
										on:click={() => {
											void saveRole(user.id);
										}}
										disabled={savingRoleFor[user.id] === true}
									>
										{savingRoleFor[user.id] === true ? 'Saving...' : 'Save'}
									</button>
								</td>
							</tr>
						{/each}
					{/if}
				</tbody>
			</table>
		</div>
	</div>
</div>
