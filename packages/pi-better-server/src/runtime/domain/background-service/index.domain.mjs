// Generated fixed launch domain from packages/pi-better-background-tasks/src/index.ts. Do not edit directly.
import { shouldRestoreWorkObservation } from "./shared-work-client.mjs";
import { randomUUID } from "node:crypto";
import { requestBackgroundTool } from "./managed-client.domain.mjs";
import { initializeNavigatorPanels } from "./shared-navigator-panels.domain.mjs";
import { registerBackgroundTasksGoalProvider } from "./goal-provider.domain.mjs";
import { createBackgroundTasksNavigator } from "./navigator-provider.domain.mjs";
import { createManagedBackgroundFrontend } from "./managed-frontend.domain.mjs";
import { observeForegroundSandboxPolicy } from "./sandbox.domain.mjs";
import { registerTools } from "./tools.domain.mjs";
import { deliverBackgroundTasksPrompt } from "./prompt.domain.mjs";
import { closeBackgroundObservation } from "./work-observation.domain.mjs";
const INSPECTION_LIMIT = 3;
const INSPECTION_WINDOW_MS = 30_000;
function inspectionKey(toolName, input) {
    switch (toolName) {
        case "bg_status":
        case "bg_logs":
            return input.taskId ? `standalone:task:${input.taskId}` : "standalone:list";
        case "bg_task_wait_list":
            return "better:wait-list";
        case "bg_task_list":
            return "better:list";
        case "bg_task_status":
        case "bg_task_log":
            return `better:task:${input.id}`;
        case "bg_task":
            if (input.action === "list")
                return "better:list";
            if (input.action === "status" || input.action === "log")
                return `better:task:${input.id}`;
    }
}
const INSPECTION_LIMIT_REASON = "Background inspection limit reached (3 checks in 30 seconds). Repeated polling costs tokens and money. Do not retry through another tool or shell. Yield for the completion notification, or check less often if no notification is available. If an owned durable task has no pending wait, register wait_for_operations once before yielding.";
const RUNNING_TASK_LIMIT_REASON = "Background inspection limit reached (3 checks in 30 seconds), and the runtime reports this task is still running. Repeated polling costs tokens and money. Do not retry through another tool or shell. Yield for its completion notification. If it has no pending wait, register wait_for_operations once before yielding.";
function guardRepeatedInspection(pi) {
    // A read takes its slot when it is called, so parallel calls count; a read that
    // ends in a tool error gives the slot back, since it showed the agent nothing.
    const reads = new Map();
    pi.on("session_before_switch", () => { reads.clear(); });
    pi.on("tool_result", ({ toolName, input, toolCallId, isError }) => {
        const key = isError ? inspectionKey(toolName, input) : undefined;
        if (key === undefined)
            return;
        const remaining = reads.get(key)?.filter(read => read.callId !== toolCallId);
        if (remaining?.length)
            reads.set(key, remaining);
        else
            reads.delete(key);
    });
    pi.on("tool_call", ({ toolName, input, toolCallId }, ctx) => {
        const key = inspectionKey(toolName, input);
        if (key === undefined)
            return;
        const now = performance.now();
        const cutoff = now - INSPECTION_WINDOW_MS;
        for (const [readKey, entries] of reads) {
            if (entries.at(-1).time <= cutoff)
                reads.delete(readKey);
        }
        const recent = reads.get(key)?.filter(read => read.time > cutoff) ?? [];
        if (recent.length >= INSPECTION_LIMIT) {
            if (key.startsWith("better:task:") && "id" in input && typeof input.id === "string" && ctx) {
                // No cached running verdict: a task can finish between blocked reads.
                // Probe only the terminal bit, without fetching logs or consuming evidence.
                // Block only on a confirmed running task: when the runtime cannot answer
                // (for example a runtime older than this probe), the task may be done and
                // its one notification already delivered, so a block would strand the agent.
                return requestBackgroundTool(pi, ctx, randomUUID(), "__background_is_terminal", { id: input.id, all: "all" in input && input.all === true })
                    .then(result => result?.terminal === false ? { block: true, terminate: true, reason: RUNNING_TASK_LIMIT_REASON } : undefined, () => undefined);
            }
            return { block: true, terminate: true, reason: INSPECTION_LIMIT_REASON };
        }
        reads.set(key, [...recent, { time: now, callId: toolCallId }]);
    });
}
export default function backgroundTasksExtension(pi) {
    // The frontend owns native UI/delivery only. Mechanical tools run in the
    // fixed server service. Register their native definitions before the first turn.
    const { host: observedWaits, proxy, ui } = createManagedBackgroundFrontend(pi);
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
