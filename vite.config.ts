import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	build: {
		rollupOptions: {
			output: {
				manualChunks(id) {
					if (!id.includes('node_modules')) {
						return;
					}

					if (id.includes('node_modules/@clerk/')) {
						return 'vendor-clerk';
					}
					if (id.includes('node_modules/@solana/')) {
						return 'vendor-solana';
					}
					if (id.includes('node_modules/react-native') || id.includes('node_modules/@react-native/')) {
						return 'vendor-react-native';
					}
					return 'vendor';
				}
			}
		}
	}
});
