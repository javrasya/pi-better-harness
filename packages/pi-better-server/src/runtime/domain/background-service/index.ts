import { shouldRestoreWorkObservation } from "./shared-work-client.mjs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { initializeNavigatorPanels } from "./shared-navigator-panels.ts";
import { registerBackgroundTasksGoalProvider } from "./goal-provider.js";
import { createBackgroundTasksNavigator } from "./navigator-provider.js";
import { createManagedBackgroundFrontend } from "./managed-frontend.js";
import { observeForegroundSandboxPolicy } from "./sandbox.js";
import { registerTools } from "./tools.js";
import { deliverBackgroundTasksPrompt } from "./prompt.js";
import { closeBackgroundObservation } from "./work-observation.js";
import { cursorKind } from "./shared-log-utils.js";

function guardRepeatedInspection(pi: ExtensionAPI): void {
  const reads = new Map<string, number>();
  pi.on("agent_start", () => { reads.clear(); });
  pi.on("tool_call", ({ toolName, input: toolInput }) => {
    const input: Record<string, unknown> = toolInput;
    const action = toolName === "bg_task" ? input.action
      : toolName === "bg_task_status" ? "status"
      : toolName === "bg_task_log" ? "log"
      : toolName === "bg_task_list" ? "list" : undefined;
    if (action !== "status" && action !== "log" && action !== "list") return;

    const cursor = typeof input.cursor === "string" ? input.cursor : undefined;
    const kind = cursorKind(cursor);
    // New evidence pages are distinct reads; a changing status revision is still polling.
    const page = kind === "s" || !kind ? undefined : cursor;
    const key = JSON.stringify([action === "list" ? null : input.id, input.all === true, page]);
    const count = reads.get(key) ?? 0;
    if (count >= 3) {
      return {
        block: true,
        terminate: true,
        reason: "Repeated background inspection blocked for this agent run. Do not retry through another tool or shell. If a durable wait is already pending, end the turn and let the completion notification resume you. Otherwise register one wait for owned durable tasks, or leave callbacks enabled and yield for legacy tasks.",
      };
    }
    reads.set(key, count + 1);
  });
}

export default function backgroundTasksExtension(pi: ExtensionAPI): void {
  // The frontend owns native UI/delivery only. Mechanical tools run in the
  // fixed server service. Register their native definitions before the first turn.
  const {host: observedWaits, proxy, ui} = createManagedBackgroundFrontend(pi);
  const navigator = createBackgroundTasksNavigator(undefined, ui);
  initializeNavigatorPanels(pi);
  // Sections on a host that renders them; text only where it renders none.
  // Returning a prompt on modern pi would set forceSystemPrompt, and the request
  // would then carry a snapshot, so sections published after it never arrive.
  pi.on("before_agent_start", (event) => deliverBackgroundTasksPrompt(event));
  registerBackgroundTasksGoalProvider(pi);
  navigator.ensureBackgroundTasksNavigatorProvider(pi);
  // Subscribed at load so a sandbox extension that publishes later is heard, and
  // asked for a snapshot in case one published before this extension existed.
  observeForegroundSandboxPolicy(pi);
  // Registered before registerTools(pi), so this runs before running tasks are resumed.
  pi.on("session_start", async (_event, ctx) => {
    registerBackgroundTasksGoalProvider(pi);
    navigator.ensureBackgroundTasksNavigator(ctx);
  });
  pi.on("session_before_switch", async () => {
    closeBackgroundObservation(pi);
    observedWaits.close();
    navigator.clearBackgroundTasksNavigatorSession();
  });
  pi.on("session_shutdown", async () => {
    closeBackgroundObservation(pi);
    // /reload, session replacement, and quit load a fresh instance; stop this one's timers (#324).
    observedWaits.close();
    navigator.clearBackgroundTasksNavigatorSession();
  });
  guardRepeatedInspection(pi);
  // The standalone pi-background-tasks package owns this name in our Pi setup.
  registerTools(proxy, undefined, navigator.refreshBackgroundTasksNavigator, { resumeLocal: false, statusAlias: false });
  // Registered after registerTools so the callback batcher has its session
  // context before a reconciled delivery can enqueue a parent notification.
  pi.on("session_start", (event, ctx) => {
    observedWaits.start(ctx, shouldRestoreWorkObservation(event, ctx.sessionManager));
  });
  // A fork or branch navigation does not restart the session, but it changes
  // which continuation may receive a queued callback. Update the host snapshot
  // on the same event the callback batcher uses.
  pi.on("session_tree", async (_event, ctx) => {
    observedWaits.noteParentContext(ctx);
  });
}
