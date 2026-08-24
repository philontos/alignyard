import type Database from "better-sqlite3";
import type { Runner } from "../fleet/runner.js";
import { localHostId } from "../core/ownership.js";
import { findRepoByGitUrl } from "../repo/catalog.js";
import { readRemoteBranchFiles } from "../repo/git.js";
import {
  ALIGNYARD_MANIFEST,
  REQUIRED_BOOTSTRAP_FILES,
  parseRepositoryManifest,
} from "../protocol/repository.js";
import {
  getPlatformRepository,
  setPlatformRepositoryProtocolState,
  type PlatformRepository,
} from "./catalog.js";

export type RefreshRepositoryProtocolResult =
  | { ok: true; repository: PlatformRepository }
  | { ok: false; reason: "not_found" | "not_local" | "not_ready"; message: string };

/** Refresh the Repository bootstrap state from its default branch. The server
 * checks only the bounded protocol baseline; detailed content validation stays
 * authoritative in `ay validate` and must be synced before init review. */
export async function refreshRepositoryProtocol(
  db: Database.Database,
  runner: Runner,
  repositoryId: number,
): Promise<RefreshRepositoryProtocolResult> {
  const repository = getPlatformRepository(db, repositoryId);
  if (!repository) return { ok: false, reason: "not_found", message: "Repository 不存在" };
  const hostId = localHostId(db);
  const local = hostId == null ? undefined : findRepoByGitUrl(db, hostId, repository.git_url);
  if (!local) return { ok: false, reason: "not_local", message: "先在本机添加这个 Repository" };
  if (local.status !== "ready" || !local.mirror_path) {
    return { ok: false, reason: "not_ready", message: "本地 Repository 尚未就绪" };
  }

  const files = await readRemoteBranchFiles(
    runner,
    local.mirror_path,
    repository.default_branch,
    REQUIRED_BOOTSTRAP_FILES,
  );
  const manifestText = files[ALIGNYARD_MANIFEST];
  let updated: PlatformRepository | undefined;
  if (!manifestText) {
    updated = setPlatformRepositoryProtocolState(
      db,
      repository.id,
      repository.protocol_state === "initializing" ? "initializing" : "uninitialized",
      null,
    );
  } else {
    const parsed = parseRepositoryManifest(manifestText);
    if (!parsed.manifest) {
      updated = setPlatformRepositoryProtocolState(db, repository.id, "invalid", parsed.errors.join("\n"));
    } else {
      const missing = REQUIRED_BOOTSTRAP_FILES.filter((filePath) => files[filePath] == null);
      updated = missing.length
        ? setPlatformRepositoryProtocolState(
          db,
          repository.id,
          "invalid",
          `默认分支缺少初始化文件：${missing.join("、")}`,
        )
        : setPlatformRepositoryProtocolState(db, repository.id, "ready", null);
    }
  }
  if (!updated) return { ok: false, reason: "not_found", message: "Repository 不存在" };
  return { ok: true, repository: updated };
}
