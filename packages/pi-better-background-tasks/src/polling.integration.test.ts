import { expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import extension from "./index.js";
import { formatWaitView, type WaitView } from "./observed-waits.js";
import { inspectStatusRevision } from "./shared-log-utils.js";
import { requestBackgroundTool } from "./managed-client.js";

vi.mock("./managed-client.js", () => ({ requestBackgroundTool: vi.fn() }));

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
    call: (toolName: string, input: Record<string, unknown>, ctx?: unknown) =>
      hooks.get("tool_call")?.map(handler => handler({ toolName, input }, ctx)).find(Boolean),
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
  pi.start();
  expect(pi.call("bg_task_status", { id, all: true })).toMatchObject({ block: true, terminate: true });
});

it("lets status and logs through a saturated budget as soon as terminal evidence is available", async () => {
  const pi = frontend(), id = "bgs_build", ctx = {};
  const request = vi.mocked(requestBackgroundTool);
  request.mockReset().mockResolvedValueOnce({ terminal: false })
    .mockRejectedValueOnce(new Error("observation unavailable"))
    .mockResolvedValue({ terminal: true });

  for (let i = 0; i < 3; i++) expect(pi.call("bg_task_status", { id }, ctx)).toBeUndefined();
  expect(request).not.toHaveBeenCalled();
  await expect(pi.call("bg_task_status", { id }, ctx)).resolves.toMatchObject({ block: true });
  await expect(pi.call("bg_task_log", { id }, ctx)).resolves.toMatchObject({ block: true });
  await expect(pi.call("bg_task", { action: "status", id }, ctx)).resolves.toBeUndefined();
  await expect(pi.call("bg_task_log", { id, cursor: "next" }, ctx)).resolves.toBeUndefined();
  expect(request).toHaveBeenLastCalledWith(expect.anything(), ctx, expect.any(String), "__background_is_terminal", { id, all: false });
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

it("limits bg_status and bg_logs without shadowing them, reopening slots on a rolling window", () => {
  vi.useFakeTimers({ toFake: ["performance"] });
  try {
    const pi = frontend();
    const taskId = "other";
    expect(pi.tools.has("bg_status")).toBe(false);
    expect(pi.tools.has("bg_logs")).toBe(false);
    pi.start();
    expect(pi.call("bg_status", { taskId })).toBeUndefined();
    vi.advanceTimersByTime(10_000);
    expect(pi.call("bg_logs", { taskId })).toBeUndefined();
    vi.advanceTimersByTime(10_000);
    expect(pi.call("bg_status", { taskId })).toBeUndefined();
    pi.start();
    vi.advanceTimersByTime(9_999);
    expect(pi.call("bg_logs", { taskId })).toMatchObject({
      block: true, terminate: true, reason: expect.stringMatching(/polling.*cost.*notification/i),
    });
    vi.advanceTimersByTime(1);
    expect(pi.call("bg_status", { taskId })).toBeUndefined();
    expect(pi.call("bg_status", { taskId })).toMatchObject({ block: true });
    vi.advanceTimersByTime(10_000);
    expect(pi.call("bg_logs", { taskId })).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

it("limits repeated task lists and wait lists without blocking mutations", () => {
  const pi = frontend();
  for (let i = 0; i < 3; i++) {
    expect(pi.call(i === 1 ? "bg_task" : "bg_task_list", { action: "list", limit: i + 1 })).toBeUndefined();
    expect(pi.call("bg_task_wait_list", { pending_only: i === 1 })).toBeUndefined();
  }
  expect(pi.call("bg_task", { action: "list" })).toMatchObject({ block: true });
  expect(pi.call("bg_task_wait_list", {})).toMatchObject({ block: true });
  expect(pi.call("bg_task", { action: "clear" })).toBeUndefined();
  expect(pi.call("wait_for_operations", { task_ids: ["bgs_build"] })).toBeUndefined();
});
