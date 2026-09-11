import { randomUUID } from "node:crypto";

export type ReplyTrigger =
  "opening" | "user_turn" | "explicit_resume" | "approved_retry";
export type ReplyState =
  | "generating"
  | "streaming"
  | "draining"
  | "completed"
  | "cancelled"
  | "failed";
export type InputTurn = { id: string; revision: number; eventId: string };
export type Reply = {
  id: string;
  generation: number;
  trigger: ReplyTrigger;
  input?: InputTurn;
  state: ReplyState;
  controller: AbortController;
  reason?: string;
};
/** Only explicit triggers create replies; activity never fabricates a new answer. */
export class TurnCoordinator {
  private generation = 0;
  private handled = new Map<string, number>();
  private reply: Reply | null = null;
  private opened = false;
  begin(trigger: ReplyTrigger, input?: InputTurn): Reply | null {
    if (trigger === "opening" && this.opened) return null;
    if (trigger === "user_turn") {
      if (!input || (this.handled.get(input.id) ?? -1) >= input.revision)
        return null;
      this.handled.set(input.id, input.revision);
    }
    this.cancel("superseded");
    this.opened = true;
    return (this.reply = {
      id: randomUUID(),
      generation: ++this.generation,
      trigger,
      input,
      state: "generating",
      controller: new AbortController(),
    });
  }
  isCurrent(reply: Reply) {
    return (
      this.reply === reply &&
      reply.generation === this.generation &&
      !reply.controller.signal.aborted
    );
  }
  transition(reply: Reply, state: ReplyState) {
    if (
      !this.isCurrent(reply) ||
      ["completed", "cancelled", "failed"].includes(reply.state)
    )
      return false;
    reply.state = state;
    return true;
  }
  cancel(reason: string) {
    const previous = this.reply;
    if (
      !previous ||
      ["completed", "cancelled", "failed"].includes(previous.state)
    )
      return null;
    previous.state = "cancelled";
    previous.reason = reason;
    previous.controller.abort(new Error(reason));
    this.generation++;
    return previous;
  }
  fail(reply: Reply, reason: string) {
    if (!this.isCurrent(reply)) return false;
    reply.state = "failed";
    reply.reason = reason;
    reply.controller.abort(new Error(reason));
    this.generation++;
    return true;
  }
  get current() {
    return this.reply;
  }
  get canInterrupt() {
    return (
      !!this.reply &&
      ["generating", "streaming", "draining"].includes(this.reply.state)
    );
  }
}
