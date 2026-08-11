import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { NotificationAdapter, TaskNotification } from "@karissa/long-tasks";

const execFileAsync = promisify(execFile);

export class DesktopNotificationAdapter implements NotificationAdapter {
	async send(notification: TaskNotification): Promise<void> {
		if (process.platform !== "darwin") {
			process.stderr.write(`${notification.title}: ${notification.body}\n`);
			return;
		}
		await execFileAsync("osascript", [
			"-e",
			"on run argv",
			"-e",
			"display notification (item 2 of argv) with title (item 1 of argv)",
			"-e",
			"end run",
			"--",
			notification.title,
			notification.body,
		]);
	}
}
