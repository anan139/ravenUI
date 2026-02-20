# Raven

Raven is a SvelteKit chat app using:
- Clerk for authentication
- Supabase (REST/RPC) for data
- OpenRouter or KoboldCpp for LLM completions

## Local Development

1. Install dependencies:
   ```bash
   npm install
   ```
2. Create env file:
   ```bash
   cp .env.example .env.local
   ```
3. Fill required env values in `.env.local`.
4. Start dev server:
   ```bash
   npm run dev
   ```

## Build And Run

This project uses `@sveltejs/adapter-node`.

1. Build:
   ```bash
   npm run build
   ```
2. Run:
   ```bash
   npm run start
   ```

## Checks

- Type/runtime checks:
  ```bash
  npm run check
  ```