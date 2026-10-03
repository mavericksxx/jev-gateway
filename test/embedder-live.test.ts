import { expect, test } from "bun:test";
import { createLocalEmbedder } from "../src/cache/embedder";

// Downloads the model on first run; opt in with LIVE_EMBEDDINGS=1.
test.skipIf(process.env.LIVE_EMBEDDINGS !== "1")(
	"local embedder: 384-dim unit vectors, paraphrases closer than unrelated",
	async () => {
		const e = createLocalEmbedder();
		const [a, b, c] = await Promise.all([
			e.embed("What is the capital of France?"),
			e.embed("Which city is France's capital?"),
			e.embed("How do I bake sourdough bread?"),
		]);
		expect(e.id.endsWith(":q8")).toBe(true);
		expect(a.length).toBe(384);
		expect(Math.hypot(...a)).toBeCloseTo(1, 3);
		const dot = (x: Float32Array, y: Float32Array) =>
			x.reduce((s, v, i) => s + v * (y[i] ?? 0), 0);
		console.log("paraphrase", dot(a, b), "unrelated", dot(a, c));
		expect(dot(a, b)).toBeGreaterThan(dot(a, c));
	},
	120_000,
);
