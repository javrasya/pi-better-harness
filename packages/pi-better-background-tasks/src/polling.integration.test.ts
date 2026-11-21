import { expect, it } from "vitest";
import { EventEmitter } from "node:events";
import extension from "./index.js";
import { formatWaitView, type WaitView } from "./observed-waits.js";
import { inspectStatusRevision } from "./shared-log-utils.js";

type Handler = (event?: any, ctx?: any) => unknown;
function frontend() {
  const hooks = new Map<string, Handler[]>();
  const tools = new Set<string>();
  extension({
    events: new EventEmitter(),
    on(name: string, handler: Handler) {
      const handlers = hooks.get(name) ?? [];
      handlers.push(handler);
      hooks.set(name, handlers);
    },
    registerTool(tool: { name: string }) { tools.add(tool.name); },
  } as any);
  return {
    tools,
    start: () => hooks.get("agent_start")?.forEach(handler => handler({}, { isIdle: () => false })),
    call: (toolName: string, input: Record<string, unknown>) =>
      hooks.get("tool_call")?.map(handler => handler({ toolName, input })).find(Boolean),
  };
}

it("stops repeated observation within one agent run, across standalone tools and wrapper actions", () => {
  const pi = frontend();
  const id = "bgs_build";
  pi.start();
  expect(pi.call("bg_task_status", { id })).toBeUndefined();
  expect(pi.call("bg_task", { action: "status", id, verbose: true })).toBeUndefined();
  expect(pi.call("bg_task_log", { id })).toBeUndefined();
  for (let i = 0; i < 10; i++) {
    expect(pi.call("bg_task_status", { id })).toMatchObject({
      block: true, terminate: true, reason: expect.stringContaining("completion notification"),
    });
  }
  expect(pi.call("bg_task_status", { id: "another" })).toBeUndefined();
  expect(pi.call("bg_task", { action: "stop", id })).toBeUndefined();
  pi.start(); // A new user request or completion follow-up can read fresh evidence.
  expect(pi.call("bg_task_status", { id })).toBeUndefined();
});

it("counts changed status revisions as repeated reads", () => {
  const pi = frontend();
  const id = "bgs_build";
  pi.start();
  for (let i = 0; i < 4; i++) {
    const cursor = inspectStatusRevision({ resource: id, contentRevision: String(i), failureRevision: "" }).nextCursor;
    const result = pi.call("bg_task_status", { id, cursor });
    if (i === 3) expect(result).toMatchObject({ block: true, terminate: true });
    else expect(result).toBeUndefined();
  }
});

it("tells a pending parent to yield, not to fetch evidence before settlement", () => {
  const wait: WaitView = {
    waitId: "wait", generation: 1, phase: "waiting", settled: false, park: false, cancelEpoch: 0,
    ownerKind: "parent-session", continuationNote: "read results", taskIds: ["bgs_build"], dependencies: [], evidence: [],
  };
  expect(formatWaitView(wait)).toContain("end the turn and let the completion notification resume you");
  expect(formatWaitView(wait)).not.toContain("acknowledge_operation_result");
  expect(formatWaitView({ ...wait, phase: "ready", settled: true })).toContain("acknowledge_operation_result");
});

it("does not shadow pi-background-tasks' bg_status tool or guard its calls", () => {
  const pi = frontend();
  expect(pi.tools.has("bg_task_status")).toBe(true);
  expect(pi.tools.has("bg_status")).toBe(false);
  for (let i = 0; i < 5; i++) expect(pi.call("bg_status", { taskId: "other" })).toBeUndefined();
});
