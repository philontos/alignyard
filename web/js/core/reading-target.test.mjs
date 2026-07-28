import test from "node:test";
import assert from "node:assert/strict";
import {
  canReadTarget,
  readingTarget,
  targetWaiting,
  transcriptUrl,
} from "./reading-target.js";

const localTasks = [
  { id: 7, kind: "repo", waiting: true },
  { id: 8, kind: "local", waiting: false },
];
const fleet = {
  2: {
    capabilities: ["transcript-v1"],
    tasks: [
      { id: 11, kind: "repo", waiting: true },
      { id: 12, kind: "local", waiting: false },
    ],
  },
  3: {
    capabilities: [],
    tasks: [{ id: 13, kind: "repo", waiting: false }],
  },
};

test("readingTarget keeps local and remote task ownership unambiguous", () => {
  assert.deepEqual(readingTarget(7), { paneId: 7, nodeId: null, taskId: 7 });
  assert.deepEqual(readingTarget("n2:11"), { paneId: "n2:11", nodeId: 2, taskId: 11 });
  for (const invalid of [0, -1, "7", "n0:11", "n2:0", "n2:11:4", "pending-7", null]) {
    assert.equal(readingTarget(invalid), null);
  }
});

test("transcriptUrl routes remote reads through the owning node endpoint", () => {
  assert.equal(transcriptUrl(7), "/api/tasks/7/transcript");
  assert.equal(transcriptUrl("n2:11"), "/api/nodes/2/tasks/11/transcript");
  assert.equal(transcriptUrl("pending-7"), null);
});

test("remote Read requires an agent task and transcript-v1 capability", () => {
  assert.equal(canReadTarget(7, localTasks, fleet), true);
  assert.equal(canReadTarget(8, localTasks, fleet), false);
  assert.equal(canReadTarget("n2:11", localTasks, fleet), true);
  assert.equal(canReadTarget("n2:12", localTasks, fleet), false);
  assert.equal(canReadTarget("n3:13", localTasks, fleet), false);
  assert.equal(canReadTarget("n2:99", localTasks, fleet), false);
});

test("waiting state follows the same owner mapping as transcript reads", () => {
  assert.equal(targetWaiting(7, localTasks, fleet), true);
  assert.equal(targetWaiting("n2:11", localTasks, fleet), true);
  assert.equal(targetWaiting("n3:13", localTasks, fleet), false);
});
