<script lang="ts">
	import './layout.css';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" type="image/png" sizes="32x32" href="/raven/favicon-32.png" />
	<link rel="icon" type="image/png" sizes="256x256" href="/raven/logo-cutout.png" />
	<link rel="apple-touch-icon" href="/raven/logo-cutout.png" />
</svelte:head>
{@render children()}
