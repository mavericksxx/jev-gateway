import type {
	Fetch,
	Question,
	SystemOneRequestPayload,
} from "@typesafe-ai/sdk";

/** Fixed answers by question name: a choice label, a score level, or a noul probability. */
export type MockAnswers = Record<string, string | number>;

/**
 * A fetch that answers `POST /v1/systemone` locally with schema-valid answers.
 * Unless overridden: choice picks the first label, score picks level 0, noul returns 0.5.
 */
export function createMockFetch(overrides: MockAnswers = {}): Fetch {
	return async (_input, init) => {
		const body = JSON.parse(String(init?.body)) as SystemOneRequestPayload;
		const answers = Object.fromEntries(
			Object.entries(body.questions).map(([name, q]) => [
				name,
				answer(q, overrides[name]),
			]),
		);
		return Response.json({
			model: body.model,
			answers,
			// Rough estimate (~4 chars/token) so spend tracking has something to count.
			usage: {
				input_tokens: Math.ceil(String(init?.body).length / 4),
				output_tokens: 0,
			},
		});
	};
}

function answer(q: Question, override: string | number | undefined) {
	switch (q.type) {
		case "noul":
			return {
				type: "noul",
				noul: typeof override === "number" ? override : 0.5,
			};
		case "choice": {
			const labels = Object.keys(q.criteria);
			const pick = typeof override === "string" ? override : labels[0];
			if (!pick || !labels.includes(pick)) {
				throw new Error(`mock: "${pick}" is not one of ${labels.join(", ")}`);
			}
			return {
				type: "choice",
				choice: pick,
				confidence: 1,
				probabilities: Object.fromEntries(
					labels.map((l) => [l, l === pick ? 1 : 0]),
				),
			};
		}
		case "score": {
			const level = typeof override === "number" ? override : 0;
			const levels = q.criteria.map((_, i) => i);
			return {
				type: "score",
				score: level,
				confidence: 1,
				legend: Object.fromEntries(q.criteria.map((c, i) => [i, c])),
				probabilities: Object.fromEntries(
					levels.map((i) => [i, i === level ? 1 : 0]),
				),
			};
		}
	}
}
