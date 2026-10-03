export interface RouterState {
	system_excerpt: string;
	last_user_turn: string;
	turn_count: number;
	last_turn_is_tool_result: boolean;
	tool_names: string[];
	estimated_input_tokens: number;
	max_tokens: number | null;
	has_images: boolean;
	has_documents: boolean;
	requested_thinking: string | null;
}

type Block = Record<string, unknown>;

const isObj = (v: unknown): v is Block =>
	typeof v === "object" && v !== null && !Array.isArray(v);

const blocks = (content: unknown): Block[] =>
	Array.isArray(content) ? content.filter(isObj) : [];

const textOf = (content: unknown): string => {
	if (typeof content === "string") return content;
	return blocks(content)
		.filter((b) => b.type === "text" && typeof b.text === "string")
		.map((b) => b.text as string)
		.join("\n");
};

const blockText = (b: Block): string =>
	b.type === "tool_result" ? textOf(b.content) : textOf([b]);

export function buildRouterState(body: Record<string, unknown>): RouterState {
	const messages = Array.isArray(body.messages)
		? body.messages.filter(isObj)
		: [];
	const allBlocks = messages.flatMap((m) => blocks(m.content));
	const lastUser = messages.findLast((m) => m.role === "user");
	const lastBlocks = lastUser ? blocks(lastUser.content) : [];
	let last = lastUser
		? typeof lastUser.content === "string"
			? lastUser.content
			: lastBlocks.map(blockText).filter(Boolean).join("\n")
		: "";
	if (last.length > 4000)
		last = `${last.slice(0, 3000)} … ${last.slice(-1000)}`;
	let size = 0;
	try {
		size = JSON.stringify(body).length;
	} catch {}
	const thinking = body.thinking;
	return {
		system_excerpt: textOf(body.system).slice(0, 1500),
		last_user_turn: last,
		turn_count: Array.isArray(body.messages) ? body.messages.length : 0,
		last_turn_is_tool_result: lastBlocks.some((b) => b.type === "tool_result"),
		tool_names: (Array.isArray(body.tools) ? body.tools : [])
			.filter(isObj)
			.map((t) => t.name)
			.filter((n): n is string => typeof n === "string")
			.slice(0, 100),
		estimated_input_tokens: Math.ceil(size / 4),
		max_tokens: typeof body.max_tokens === "number" ? body.max_tokens : null,
		has_images: allBlocks.some((b) => b.type === "image"),
		has_documents: allBlocks.some((b) => b.type === "document"),
		requested_thinking:
			isObj(thinking) && typeof thinking.type === "string"
				? thinking.type
				: null,
	};
}
