import { test } from "node:test";
import assert from "node:assert/strict";
import { executionFailureEvent } from "./client.ts";

test("read-only worktree errors never fail a live Runner execution", () => {
  const params = { execution_id: "rex_example123", runner_task_id: 3 };
  assert.equal(executionFailureEvent("execution.knowledge", params, "文档尚未创建"), null);
  assert.equal(executionFailureEvent("execution.inspect-worktree", params, "文件尚未创建"), null);
  assert.equal(executionFailureEvent("execution.status", params, "暂时不可用"), null);
});

test("actual Agent startup failures still fail the Runner execution", () => {
  const event = executionFailureEvent("execution.start", { execution_id: "rex_example123" }, "启动失败");
  assert.deepEqual(event, {
    type: "execution.event",
    execution_id: "rex_example123",
    status: "failed",
    error: "启动失败",
  });
});
