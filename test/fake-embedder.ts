import type { Embedder } from "../src/cache/embedder";

/** Deterministic bag-of-words embedder for tests: shared words → high cosine similarity. */
export const fakeEmbedder: Embedder = {
	async embed(text) {
		const v = new Float32Array(64);
		for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
			let h = 0;
			for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) % 64;
			v[h] = (v[h] ?? 0) + 1;
		}
		const n = Math.hypot(...v) || 1;
		return v.map((x) => x / n);
	},
};
