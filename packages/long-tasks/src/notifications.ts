import type { SqliteTaskStore } from "./store.ts";
import type { TaskNotification } from "./types.ts";

export interface NotificationAdapter {
	send(notification: TaskNotification): Promise<void>;
}

export class TaskNotificationDispatcher {
	private readonly store: SqliteTaskStore;
	private readonly adapter: NotificationAdapter;

	constructor(store: SqliteTaskStore, adapter: NotificationAdapter) {
		this.store = store;
		this.adapter = adapter;
	}

	async dispatchPending(): Promise<number> {
		this.store.queueStateNotifications();
		let sent = 0;
		for (const notification of this.store.listPendingNotifications()) {
			try {
				await this.adapter.send(notification);
				this.store.markNotificationSent(notification.id);
				sent++;
			} catch (error) {
				this.store.markNotificationFailed(notification.id, error instanceof Error ? error.message : String(error));
			}
		}
		return sent;
	}
}
