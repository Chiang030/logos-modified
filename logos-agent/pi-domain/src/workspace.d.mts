import type { FileHandle } from "node:fs/promises";
export class WorkspaceError extends Error { status: number; }
export function projectWorkspace(root: string | FileHandle, request: Record<string, unknown>): Promise<unknown>;
