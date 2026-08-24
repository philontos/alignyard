import type Database from "better-sqlite3";
import type { Runner } from "../fleet/runner.js";
import { localHostId } from "../core/ownership.js";
import { findRepoByGitUrl } from "../repo/catalog.js";
import { readRemoteBranchFile } from "../repo/git.js";
import { ALIGNYARD_MANIFEST, parseRepositoryManifest } from "../protocol/repository.js";
import {
  getPlatformRepository,
  setPlatformRepositoryProtocolInitialized,
  type PlatformRepository,
} from "./catalog.js";

export type RefreshRepositoryProtocolResult =
  | { ok: true; repository: PlatformRepository }
  | { ok: false; reason: "not_found" | "not_local" | "not_ready"; message: string };

/** Explicitly refresh the platform's sole protocol signal from Git. The server
 * uses the local user's mirror and credentials; no credential or file content
 * is persisted in the shared catalog. */
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

  const manifestText = await readRemoteBranchFile(
    runner,
    local.mirror_path,
    repository.default_branch,
    ALIGNYARD_MANIFEST,
  );
  const initialized = !!manifestText && !!parseRepositoryManifest(manifestText).manifest;
  const updated = setPlatformRepositoryProtocolInitialized(db, repository.id, initialized);
  if (!updated) return { ok: false, reason: "not_found", message: "Repository 不存在" };
  return { ok: true, repository: updated };
}
