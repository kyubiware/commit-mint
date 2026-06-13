let agentMode = false;

export function setAgentMode(value: boolean): void {
	agentMode = value;
}

export function isAgentMode(): boolean {
	return agentMode;
}

export interface AgentCommit {
	message: string;
	hash: string;
	files: string[];
	groupName?: string;
}

export interface AgentResult {
	status: "success" | "failure" | "no_changes" | "cancelled";
	commits: AgentCommit[];
	errors?: string[];
}

export const EXIT_CODES = {
	SUCCESS: 0,
	GENERIC: 1,
	NO_CHANGES: 2,
	GIT: 3,
	AI: 4,
	CHECK: 5,
	HOOK: 6,
} as const;

export function writeAgentResult(result: AgentResult): void {
	process.stdout.write(`${JSON.stringify(result)}\n`);
}
