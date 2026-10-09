// Browser-side state (query history, guided progress) is kept per local workspace so two workspaces never
// share history or results. The default workspace keeps the original, unscoped keys (no data loss on upgrade).
const ACTIVE_KEY = "contoso-active-workspace";

export function activeWorkspaceId(): string {
  try { return localStorage.getItem(ACTIVE_KEY) || "default"; } catch { return "default"; }
}

/** Returns true when the remembered id changed (callers remount pages so they reread scoped state). */
export function rememberWorkspaceId(id: string): boolean {
  const previous = activeWorkspaceId();
  try { localStorage.setItem(ACTIVE_KEY, id); } catch { /* storage unavailable */ }
  return previous !== id;
}

export function scopedKey(base: string, workspaceId: string = activeWorkspaceId()): string {
  return workspaceId === "default" ? base : `${base}@${workspaceId}`;
}
