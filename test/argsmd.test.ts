import { describe, expect, it } from "vitest";
import { argumentsMarkdown } from "../src/argsmd.js";
import { escalationBody } from "../src/escalate.js";

describe("argumentsMarkdown", () => {
	it("shows a shell command in a bash fence with its real newlines", () => {
		const md = argumentsMarkdown({ arguments: { command: "mkdir -p /srv/a\nls /srv" } });
		expect(md).toBe("Command:\n```bash\nmkdir -p /srv/a\nls /srv\n```");
	});

	it("lists a shell call's other arguments as pretty JSON", () => {
		const md = argumentsMarkdown({ arguments: { command: "ls", timeout: 30 } });
		expect(md).toContain("Command:\n```bash\nls\n```");
		expect(md).toContain('Other arguments:\n```json\n{\n  "timeout": 30\n}\n```');
	});

	it("pretty-prints non-shell arguments", () => {
		const md = argumentsMarkdown({ arguments: { ids: [7, 9] } });
		expect(md).toBe('Arguments:\n```json\n{\n  "ids": [\n    7,\n    9\n  ]\n}\n```');
	});

	it("outgrows backtick runs inside the command so the fence cannot close early", () => {
		const md = argumentsMarkdown({ arguments: { command: "echo '```'" } });
		expect(md.startsWith("Command:\n````bash\n")).toBe(true);
		expect(md.endsWith("\n````")).toBe(true);
	});

	it("redacts credentials in the command", () => {
		const md = argumentsMarkdown({ arguments: { command: "curl -H 'Authorization: Bearer abcdef123456' https://acme.example" } });
		expect(md).not.toContain("abcdef123456");
	});

	it("the escalation body carries the readable command", () => {
		const body = escalationBody({ name: "bash", arguments: { command: "rm -rf /tmp/x" } }, ["destructive"]);
		expect(body).toBe("The warden held `bash` in a job run.\n\nCommand:\n```bash\nrm -rf /tmp/x\n```\n\n- destructive");
	});
});
