// The status machine is enforced server-side, not merely reflected in the
// admin UI. A UI that hides a button is a suggestion; this is the rule.

import type { ProjectStatus } from "./types";

const ALLOWED: Record<ProjectStatus, readonly ProjectStatus[]> = {
  submitted: ["estimated", "cancelled"],
  // Self-transition is legal: re-sending a revised estimate is a normal act
  // and must not require a contrived status detour.
  estimated: ["estimated", "signed", "declined", "cancelled"],
  signed: ["in_progress", "cancelled"],
  in_progress: ["completed", "cancelled"],
  completed: [],
  declined: [],
  cancelled: [],
};

export function canTransition(from: ProjectStatus, to: ProjectStatus): boolean {
  return (ALLOWED[from] ?? []).includes(to);
}

export function assertTransition(from: ProjectStatus, to: ProjectStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal transition: ${from} -> ${to}`);
  }
}
