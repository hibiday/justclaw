#!/usr/bin/env bun

function writeLine(obj: unknown): void {
	process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function main(): Promise<void> {
	const decoder = new TextDecoder();
	const reader = Bun.stdin.stream().getReader();
	let buffer = "";

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });

		let newlineIndex = buffer.indexOf("\n");
		while (newlineIndex >= 0) {
			const line = buffer.slice(0, newlineIndex).trimEnd();
			buffer = buffer.slice(newlineIndex + 1);
			newlineIndex = buffer.indexOf("\n");

			if (!line) continue;

			let msg: unknown;
			try {
				msg = JSON.parse(line);
			} catch {
				continue;
			}

			if (
				typeof msg !== "object" ||
				msg === null ||
				(msg as Record<string, unknown>).jsonrpc !== "2.0"
			) {
				continue;
			}

			const record = msg as Record<string, unknown>;
			if (typeof record.id === "number" && record.method === "initialize") {
				writeLine({ jsonrpc: "2.0", id: record.id, result: { tools: [] } });

				const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
				writeLine({
					jsonrpc: "2.0",
					method: "event",
					params: {
						type: "event.v1",
						kind: "daily.update",
						date: today,
						text: `ワークスペース直下の daily/${today}.md に本日の日記を追記・更新してください。直近の会話・作業内容を簡潔にまとめ、Markdownで記録してください。ファイルが存在しない場合は新規作成してください。`,
					},
				});

				process.exit(0);
			}
		}
	}
}

void main();
