process.env.NIGHT_VOYAGE_SERVE_DIST = '1';
process.env.NIGHT_VOYAGE_PORT = '3000';
await import('../server/index.mjs');
