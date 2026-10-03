export interface Embedder {
	/** Unit-length vector. */
	embed(text: string): Promise<Float32Array>;
}

const CACHE_DIR = new URL("../../.cache/transformers", import.meta.url)
	.pathname;

/** Lazily loads the model on first embed(). Models are cached under <repo>/.cache/transformers. */
export function createLocalEmbedder(opts?: { model?: string }): Embedder {
	const model = opts?.model ?? "Xenova/all-MiniLM-L6-v2";
	let extractor: Promise<
		(
			text: string,
			o: { pooling: "mean"; normalize: boolean },
		) => Promise<{ data: Float32Array }>
	> | null = null;
	const load = () => {
		extractor ??= import("@huggingface/transformers").then(
			async ({ env, pipeline }) => {
				env.cacheDir = CACHE_DIR;
				return (await pipeline("feature-extraction", model)) as never;
			},
		);
		extractor.catch(() => {
			extractor = null;
		});
		return extractor;
	};
	return {
		async embed(text) {
			const run = await load();
			const out = await run(text, { pooling: "mean", normalize: true });
			return Float32Array.from(out.data);
		},
	};
}
