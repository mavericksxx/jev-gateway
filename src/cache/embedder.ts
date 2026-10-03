export interface Embedder {
	/** Identifies the model and precision, e.g. "Xenova/all-MiniLM-L6-v2:q8". Entries embedded by a different id are never compared. */
	readonly id: string;
	/** Unit-length vector. */
	embed(text: string): Promise<Float32Array>;
}

const CACHE_DIR = new URL("../../.cache/transformers", import.meta.url)
	.pathname;

/** Lazily loads the model on first embed(). Models are cached under <repo>/.cache/transformers. */
export function createLocalEmbedder(opts?: {
	model?: string;
	dtype?: "fp32" | "q8";
}): Embedder {
	const model = opts?.model ?? "Xenova/all-MiniLM-L6-v2";
	const dtype = opts?.dtype ?? "q8";
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
				return (await pipeline("feature-extraction", model, {
					dtype,
				})) as never;
			},
		);
		extractor.catch(() => {
			extractor = null;
		});
		return extractor;
	};
	return {
		id: `${model}:${dtype}`,
		async embed(text) {
			const run = await load();
			const out = await run(text, { pooling: "mean", normalize: true });
			return Float32Array.from(out.data);
		},
	};
}
