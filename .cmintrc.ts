export default {
	"*.{js,ts,json}": "biome check --write --no-errors-on-unmatched",
	"*.ts": () => ["tsc --noEmit", "vitest run --passWithNoTests", "npm run build"],
};
