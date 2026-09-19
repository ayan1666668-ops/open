// Runs guard entry points without credentials or network access. Every API read
// must have an explicit fixture; writes are recorded for contract assertions.
import { appendFileSync, readFileSync } from "node:fs";

const fixture = JSON.parse(readFileSync(process.env.OPENCLAW_GUARD_TEST_FIXTURE, "utf8"));
globalThis.fetch = async (url, options = {}) => {
  const parsed = new URL(url);
  const method = options.method ?? "GET";
  const body = options.body ? JSON.parse(options.body) : undefined;
  appendFileSync(fixture.logPath, `${JSON.stringify({ method, path: parsed.pathname, body })}\n`);
  const key = `${method} ${parsed.pathname}`;
  const route = fixture.routes[key];
  if (route === undefined) {
    if (method !== "GET" && /\/(?:statuses\/|issues\/)/u.test(parsed.pathname)) {
      return new Response(JSON.stringify({ id: 123 }), { status: 200 });
    }
    throw new Error(`Unexpected GitHub request: ${key}`);
  }
  const value = route.responses
    ? route.responses.length > 1
      ? route.responses.shift()
      : route.responses[0]
    : route;
  if (value?.httpError) {
    return new Response(JSON.stringify({ message: "Fixture API failure" }), {
      status: value.httpError,
    });
  }
  return new Response(JSON.stringify(value), { status: 200 });
};
