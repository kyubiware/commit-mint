import { beforeEach, describe, expect, it, vi } from "vitest"

// Mock execa before importing the module under test so the module picks up
// the mock when it captures `execa` at import time.
vi.mock("execa", () => ({
	execa: vi.fn(),
}))

vi.mock("../utils/debug.js", () => ({
	debug: vi.fn(),
}))

import { execa } from "execa"
import {
	buildUpdateCommand,
	detectPackageManager,
	fetchLatestVersion,
	isUpdateAvailable,
	PACKAGE_NAME,
	runUpdate,
} from "./updater.js"

describe("detectPackageManager", () => {
	it("returns npm for undefined userAgent", () => {
		expect(detectPackageManager(undefined)).toBe("npm")
	})

	it("returns npm for empty string userAgent", () => {
		expect(detectPackageManager("")).toBe("npm")
	})

	it("detects npm from user agent prefix", () => {
		expect(detectPackageManager("npm/10.2.0 node/v20.10.0")).toBe("npm")
	})

	it("detects pnpm from user agent prefix", () => {
		expect(detectPackageManager("pnpm/8.15.0 node/v20.10.0")).toBe("pnpm")
	})

	it("detects yarn from user agent prefix", () => {
		expect(detectPackageManager("yarn/1.22.19")).toBe("yarn")
	})

	it("detects bun from user agent prefix", () => {
		expect(detectPackageManager("bun/1.0.0")).toBe("bun")
	})

	it("falls back to npm for an unknown prefix", () => {
		expect(detectPackageManager("cargo/1.0.0")).toBe("npm")
	})
})

describe("buildUpdateCommand", () => {
	it("builds the npm install command with @latest", () => {
		expect(buildUpdateCommand("npm")).toBe(`npm install -g ${PACKAGE_NAME}@latest`)
	})

	it("builds the pnpm add command with @latest", () => {
		expect(buildUpdateCommand("pnpm")).toBe(`pnpm add -g ${PACKAGE_NAME}@latest`)
	})

	it("builds the yarn global add command with @latest", () => {
		expect(buildUpdateCommand("yarn")).toBe(`yarn global add ${PACKAGE_NAME}@latest`)
	})

	it("builds the bun add command with @latest", () => {
		expect(buildUpdateCommand("bun")).toBe(`bun add -g ${PACKAGE_NAME}@latest`)
	})

	it("respects a custom package name override", () => {
		expect(buildUpdateCommand("pnpm", "foo-bar")).toBe("pnpm add -g foo-bar@latest")
	})
})

describe("isUpdateAvailable", () => {
	it("returns true when latest is greater than current", () => {
		expect(isUpdateAvailable("1.0.0", "2.0.0")).toBe(true)
	})

	it("returns false when latest equals current", () => {
		expect(isUpdateAvailable("1.2.3", "1.2.3")).toBe(false)
	})

	it("returns false when latest is less than current", () => {
		expect(isUpdateAvailable("2.0.0", "1.0.0")).toBe(false)
	})

	it("returns false on invalid current version (does not throw)", () => {
		expect(isUpdateAvailable("not-semver", "1.0.0")).toBe(false)
	})

	it("returns false on invalid latest version (does not throw)", () => {
		expect(isUpdateAvailable("1.0.0", "not-semver")).toBe(false)
	})
})

describe("fetchLatestVersion", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("returns the trimmed version on success", async () => {
		vi.mocked(execa).mockResolvedValue({ exitCode: 0, stdout: "1.2.3\n" } as never)
		expect(await fetchLatestVersion()).toBe("1.2.3")
		expect(execa).toHaveBeenCalledWith("npm", ["view", PACKAGE_NAME, "version"], { reject: false })
	})

	it("returns null when exit code is non-zero", async () => {
		vi.mocked(execa).mockResolvedValue({ exitCode: 1, stdout: "" } as never)
		expect(await fetchLatestVersion()).toBeNull()
	})

	it("returns null when execa rejects (does not throw)", async () => {
		vi.mocked(execa).mockRejectedValue(new Error("network down"))
		expect(await fetchLatestVersion()).toBeNull()
	})
})

describe("runUpdate", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("returns true when the install exits with code 0", async () => {
		vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
		expect(await runUpdate("npm")).toBe(true)
	})

	it("returns false when the install exits with a non-zero code", async () => {
		vi.mocked(execa).mockResolvedValue({ exitCode: 1 } as never)
		expect(await runUpdate("npm")).toBe(false)
	})

	it("invokes execa with shell, reject: false, and inherited stdio", async () => {
		vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
		await runUpdate("pnpm")
		expect(execa).toHaveBeenCalledWith("pnpm add -g @kyubiware/commit-mint@latest", [], {
			shell: true,
			reject: false,
			stdio: "inherit",
		})
	})
})
