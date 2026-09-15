type Draft = { name: string; description: string; prompt: string };
type Transfer = { draft: Draft; saved: string; revision: number };

// The new-role route unmounts on creation. Carry its newer edits to the saved
// role's editor without changing the successful request's saved baseline.
const transfers = new Map<string, Transfer>();
export function rememberCreatedRoleDraft(id: string, transfer: Transfer) {
  transfers.set(id, transfer);
}
export function takeCreatedRoleDraft(id: string) {
  const transfer = transfers.get(id);
  transfers.delete(id);
  return transfer;
}
