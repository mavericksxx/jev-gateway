// Serves the dashboard page plus sample API data, for previewing without the real gateway.
const root = new URL("../", import.meta.url);
const file = (p: string, type: string) => () =>
	new Response(Bun.file(new URL(p, root)), {
		headers: { "content-type": type },
	});

const html = file("src/dashboard/index.html", "text/html; charset=utf-8");
const stats = file("fixtures/dashboard/stats.json", "application/json");
const requests = file("fixtures/dashboard/requests.json", "application/json");

const server = Bun.serve({
	port: Number(process.env.PORT) || 8790,
	fetch(req) {
		const { pathname } = new URL(req.url);
		if (pathname === "/" || pathname === "/dashboard") return html();
		if (pathname === "/api/stats") return stats();
		if (pathname === "/api/requests") return requests();
		return new Response("Not found", { status: 404 });
	},
});
console.log(`Dashboard preview: http://localhost:${server.port}/dashboard`);
