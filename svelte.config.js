import adapter from '@sveltejs/adapter-node';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		// Use a concrete production adapter so deployment does not depend on auto-detection.
		adapter: adapter()
	}
};

export default config;
