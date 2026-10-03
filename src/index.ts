import { costUsd } from "./pricing";
import { createApp } from "./server";
import { createStore } from "./store/db";

const port = Number(process.env.PORT ?? 8787);
const upstreamBaseURL =
	process.env.UPSTREAM_BASE_URL ?? "https://api.anthropic.com";
const store = createStore(process.env.GATEWAY_DB ?? "jev-gateway.db");

const app = createApp({
	upstreamBaseURL,
	onRecord: (record) =>
		store.insert(
			record,
			record.usage ? costUsd(record.upstreamModel, record.usage) : null,
		),
});

// idleTimeout 0: streamed responses can sit quiet for longer than Bun's 10s default.
Bun.serve({ port, fetch: app.fetch, idleTimeout: 0 });
console.log(
	`jev-gateway listening on http://localhost:${port} → ${upstreamBaseURL}`,
);
