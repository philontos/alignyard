// Pure addressing/capability helpers for mobile Read. Local panes use their
// numeric task id; remote terminal panes use "n<host>:<task>". Keeping the parser
// here means terminal selection, capability checks and transcript URLs cannot
// quietly disagree about which owner a task belongs to.

export const TRANSCRIPT_CAPABILITY = "transcript-v1";

export function readingTarget(paneId) {
  if (Number.isSafeInteger(paneId) && paneId > 0) {
    return { paneId, nodeId: null, taskId: paneId };
  }
  const match = typeof paneId === "string" ? /^n([1-9]\d*):([1-9]\d*)$/.exec(paneId) : null;
  if (!match) return null;
  const nodeId = Number(match[1]);
  const taskId = Number(match[2]);
  if (!Number.isSafeInteger(nodeId) || !Number.isSafeInteger(taskId)) return null;
  return { paneId, nodeId, taskId };
}

export function transcriptUrl(paneId) {
  const target = readingTarget(paneId);
  if (!target) return null;
  return target.nodeId == null
    ? `/api/tasks/${target.taskId}/transcript`
    : `/api/nodes/${target.nodeId}/tasks/${target.taskId}/transcript`;
}

export function canReadTarget(paneId, localTasks, fleet) {
  const target = readingTarget(paneId);
  if (!target) return false;
  const task = target.nodeId == null
    ? localTasks?.find((candidate) => candidate.id === target.taskId)
    : fleet?.[target.nodeId]?.tasks?.find((candidate) => candidate.id === target.taskId);
  if (!task || task.kind === "local") return false;
  return target.nodeId == null
    || !!fleet?.[target.nodeId]?.capabilities?.includes(TRANSCRIPT_CAPABILITY);
}

export function targetWaiting(paneId, localTasks, fleet) {
  const target = readingTarget(paneId);
  if (!target) return false;
  const task = target.nodeId == null
    ? localTasks?.find((candidate) => candidate.id === target.taskId)
    : fleet?.[target.nodeId]?.tasks?.find((candidate) => candidate.id === target.taskId);
  return !!task?.waiting;
}
