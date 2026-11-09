import type { CommitmentStatus } from "@prisma/client";

export const homemakerTransitions: Record<CommitmentStatus, CommitmentStatus[]> = {
  COMMITTED: ["PREPARING"],
  PREPARING: ["READY_FOR_COLLECTION"],
  READY_FOR_COLLECTION: [],
  COLLECTED: [],
  REJECTED: [],
  COMPLETED: [],
};

export const adminTransitions: Record<CommitmentStatus, CommitmentStatus[]> = {
  COMMITTED: ["REJECTED"],
  PREPARING: ["REJECTED"],
  READY_FOR_COLLECTION: ["COLLECTED", "REJECTED"],
  REJECTED: [],
  COLLECTED: ["COMPLETED", "REJECTED"],
  COMPLETED: [],
};
