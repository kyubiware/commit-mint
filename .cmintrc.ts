export default {
	"*.{js,ts,json}": "biome check --write --no-errors-on-unmatched --error-on-warnings --unsafe",
	"*.ts": () => ["tsc --noEmit", "vitest run --passWithNoTests", "npm run build"],
}
