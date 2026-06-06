import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		coverage: {
			provider: "v8",
			reporter: ["text", "html", "json"],
			thresholds: {
				lines: 50,
				branches: 70,
				functions: 55,
				statements: 50,
			},
		},
	},
});
