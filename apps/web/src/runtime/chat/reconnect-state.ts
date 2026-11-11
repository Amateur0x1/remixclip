/**
 * Component 22 · reconnect (cells 82–84 of the 84-cell state matrix) · the **state** of S29 "network
 * connection lost / reconnecting".
 *
 * Product decision (2026-08-26, `specs/current/run-error-catalog.md` §6):
 * S29 uses the design already in the design spec, positioned at **the last row in the session**.
 *
 * This layer answers exactly one question: **should that row be at the tail of the stream right
 * now, and what fraction is written on it.**
 * It's a pure function, doesn't touch the DOM, doesn't know React —— the look is in
 * `components/chat/Reconnect.tsx`,
 * the mount point is `ChatPane`, the signal comes from `providers/daemon.ts`'s `onReconnect`.
 *
 * Why a separate reducer is worth it, rather than stuffing two `setState` calls into `ProjectView`:
 * this row has three mutually constraining boundaries, and scattered across components they'd rely
 * on every caller remembering to get each one right ——
 *
 *   1. **The whole row disappears after recovery, leaving no "recovered"**(cmp-ops' exact words). So
 *      "recovered" has exactly one expression: the state goes back to `null`. No branch here can
 *      produce a "recovered" terminal reading.
 *   2. **When attempts run out, swap in [Reconnect] and hand it back to the human**(22-3). When the
 *      transport layer exhausts its budget, the call order is
 *      `onRunStatus('failed')` → `emitReconnect('exhausted')` → `onError(...)`,
 *      and the error path fires another `failed`. So `exhausted` must withstand the `failed` that
 *      arrives after it, otherwise that button flashes by.
 *   2b. **Pressing that button must have feedback, and the feedback must expire**(`manual-retry` /
 *      `manual-retry-expired`). The whole chain after pressing is asynchronous; if the daemon
 *      doesn't come back it breaks midway and the screen is unchanged —— and "nothing changed when I
 *      clicked" looks exactly like "the button is broken".
 *      So pressing **unconditionally** flips back to "reconnecting", and one unified expiry gate
 *      sends it back to 22-3.
 *   3. **The whole row disappears once the run settles**. `canceled` is reported by
 *      AssistantMessage's turn footer as "stopped manually", with no PauseLine appended; `succeeded`
 *      likewise leaves no "recovered". So here any terminal status immediately withdraws the
 *      reconnect row, so history replay doesn't leave a stale connection state behind.
 */
import type { ChatRunStatus } from '@remixclip/contracts';

/**
 * Which piece of "the system is healing itself" this row is talking about.
 *
 *   `transport`   the SSE between browser ↔ daemon broke, reconnecting (the original meaning of
 *                 component 22)
 *   `agent-retry` the connection is fine; it's the daemon that re-ran that agent turn
 *
 * The two belong to different layers, but to the user they're the same thing: the system is healing
 * itself, wait a bit. The delivery spec
 * (`docs/design/chat-panel-next.html:4058`) ruled on this explicitly —— "a dropped connection is
 * fully owned by 22 · reconnect……**standing up another module would only add a third way of
 * saying it**". So they share this row's shape and
 * share the rule "the whole row disappears after recovery, leaving no 'recovered'", and only differ
 * in that sentence: when a turn is re-run the line is up, so saying "reconnecting" is a lie.
 *
 * It's also the criterion for which budget "of how many" takes: the transport layer is 5
 * (`DAEMON_STREAM_RECONNECT_LIMIT`),
 * auto-retry is that turn's `retry_max_attempts`. One row states one thing, so the two budgets never
 * mix.
 */
export type ChatSelfHealReason = 'transport' | 'agent-retry' | 'agent-reconnect';

/** The reading of the row at the tail of the stream. `null` = there should be no such row right now. */
export interface ChatReconnectView {
  /** Which piece of self-healing this row is about. See {@link ChatSelfHealReason}. */
  reason: ChatSelfHealReason;
  /**
   * Which run this row belongs to. Switching a turn, paging through history, another stream
   * reattached in the background recovering —— all align on this,
   * so a stale reconnect doesn't linger in the stream (the other half of "disappears automatically
   * after recovery").
   */
  runId: string;
  /**
   * Which session this row belongs to. Background reattachment runs on a **different** session, and
   * the tail of the current session's stream shouldn't
   * grow a row about someone else's reconnect. Run it through `reconnectViewForConversation` before
   * rendering.
   */
  conversationId: string;
  /** Which attempt in this disconnection episode, starting at 1. The transport layer guarantees
   * monotonic increase (see `DaemonReconnectState`). */
  attempt: number;
  /** The transport layer's reconnect budget, the design spec's "of how many". */
  max: number;
  /** Budget exhausted: auto-reconnect stops, handed back to the human (22-3). */
  exhausted: boolean;
  /**
   * What this row shows now is the **optimistic reading after the user pressed [Reconnect]**, not
   * the transport layer's own words.
   *
   * Its only reason to exist is to give the press feedback: whether a reattachment can start has to
   * pass several preconditions,
   * and those conditions are all asynchronous, with nothing on screen speaking for that press (real
   * device 2026-08-27,
   * the user's words "nothing happens when I click reconnect").
   *
   * Optimistic must expire: every optimistic reading is uniformly fallen back to 22-3 by
   * `manual-retry-expired`, the time limit is in {@link MANUAL_RECONNECT_FEEDBACK_MS}. This flag is
   * that gate's key ——
   * the real reading the transport layer later takes over with doesn't carry it, so the gate has no
   * effect on real readings.
   */
  manualRetry: boolean;
  /**
   * This row was derived from **the browser itself saying this screen has no network**, not counted
   * by the transport layer.
   *
   * Why record it separately: the two cocking points end differently. The transport layer's episode
   * closes itself via `cleared` / `exhausted`;
   * the offline episode only closes via `online` —— and `online` shouldn't touch the row the
   * transport layer is counting (whether the line is broken and whether this screen has network are
   * two things; the latter being fine doesn't mean the former is through).
   * This flag is that dividing line.
   *
   * It's also the criterion for "who can cover whom": the transport layer's reading is more specific
   * (it can count which attempt, its up to 22-3),
   * so as soon as it arrives it covers this tier; the reverse isn't allowed.
   */
  offline?: boolean;
}

/**
 * How long the optimistic reading of that press may stay at most, after which it falls back to 22-3
 * (with the button).
 *
 * The two ends of the value:
 *   · Lower bound —— when a reattachment really does start, the real device measured the whole row
 *     disappearing within **0.4s** (2026-08-27).
 *     So any limit below that would flash "connection failed" first and then disappear, adding a
 *     gratuitous extra transition.
 *   · Upper bound —— this is the silence the user has to wait through on the **failure** path. Too
 *     long and it turns from "it's trying" into "it's stuck again".
 *
 * 3 seconds: slow enough to see "it really did try", fast enough that the failure verdict isn't late.
 */
export const MANUAL_RECONNECT_FEEDBACK_MS = 3000;

export type ChatReconnectSignal =
  /** The transport layer's own words, verbatim from `DaemonStreamHandlers.onReconnect`. */
  | {
      kind: 'transport';
      runId: string;
      conversationId: string;
      attempt: number;
      max: number;
      phase: 'reconnecting' | 'cleared' | 'exhausted';
    }
  /** This turn settled. The `canceled` outcome is shown by the turn footer, see item 3 at the top of
   * the file. */
  | { kind: 'settled'; runId: string; status: ChatRunStatus }
  /**
   * The daemon re-ran that agent turn —— verbatim from `run_retry_attempted` on the SSE
   * (turned into a reading by `DaemonStreamHandlers.onAgentRetry`).
   *
   * There's no `exhausted` tier: when the budget burns out, what takes over is the error card (the
   * design spec S10's wording for the timing
   * is "after all automatic retries fail"), not a [Reconnect] button. This row is only responsible for saying "still
   * trying".
   */
  | {
      kind: 'agent-retry';
      runId: string;
      conversationId: string;
      attempt: number;
      max: number;
      phase: 'retrying' | 'cleared';
    }
  /** Agent CLI is reconnecting its upstream model stream (for example Codex). */
  | {
      kind: 'agent-reconnect';
      runId: string;
      conversationId: string;
      attempt: number;
      max: number;
      phase: 'reconnecting' | 'cleared';
    }
  /**
   * Locally no longer following this stream: switching sessions, leaving the project, component
   * unmount. No `runId` means clear everything.
   * Kept separate from `settled` because it doesn't express a run outcome —— that turn may still be
   * running on the daemon.
   */
  | { kind: 'dropped'; runId?: string }
  /**
   * The user pressed [Reconnect]. **Immediately** flips the row that was handed back to the human to
   * "reconnecting 1/5".
   *
   * Why it must flip: what runs after the press is "clear the retry ledger → wake the reattach
   * scanner → pull run status →
   * start the reattachment", and if the daemon doesn't come back the chain breaks at the third step,
   * while nothing along the chain
   * touches this row —— so the screen stays unchanged. Real device 2026-08-27, the user's words
   * "nothing happens when I click reconnect". **"Nothing changed when I clicked" and "the button is broken" look exactly the same
   * on screen.**
   *
   * Why it can't flip to "the whole row disappears": an earlier version did exactly that
   * (optimistically pushing a `dropped`),
   * and when the reattachment doesn't start nobody draws the row back, leaving only the shell header
   * saying "run failed", while the error card per R9
   * is also supposed to be suppressed —— the user has no way to press again. The only proper moment
   * to withdraw the whole row is still
   * "the reattachment really started", and that spot is held by `dropped`.
   *
   * Only valid for the row **already handed back to the human**: the row still counting has no
   * button anyway, and it displays
   * the transport layer's real reading, which shouldn't be rewritten to 1 by a press.
   *
   * Repeated pressing can't happen: after the flip `exhausted` is false, and `Reconnect`'s tier
   * doesn't draw the button at all
   * (see `components/chat/Reconnect.tsx`) —— there's nothing pressable in the window, one press only
   * buys one reattach scan, and nothing presses again by itself.
   */
  | { kind: 'manual-retry'; runId: string }
  /**
   * The optimistic reading of that press has expired (`MANUAL_RECONNECT_FEEDBACK_MS`).
   *
   * An optimistic reading **must** have exactly this one ending: the shapes of a reattachment that
   * didn't start are too many (status can't be pulled,
   * the daemon itself says this turn already failed, blocked by the cooldown window, the scan itself
   * never ran because `daemonLive`
   * turned false), and recognizing them one by one equals splitting an invariant into a dozen places
   * that must be written correctly. This only recognizes one thing:
   * **after all this time this row is still that optimistic reading, so it didn't connect** —— fall
   * back to 22-3 and give the button back to the human.
   *
   * Rows that aren't the optimistic reading are never touched, so once the transport layer really
   * takes over this gate is void automatically.
   */
  | { kind: 'manual-retry-expired'; runId: string }
  /**
   * **Reported by the browser itself** for this screen's network status (`online` / `offline`
   * events +
   * `navigator.onLine`). The second cocking point besides the transport layer's ladder.
   *
   * Why a second one is needed: today that row only cocks when the socket actually breaks. But the
   * daemon runs on
   * a **loopback interface** —— when the tab loses network that stream often doesn't notice at all,
   * the 25-second keepalive
   * still arrives, the 75-second silence gate (`DAEMON_STREAM_IDLE_TIMEOUT_MS`) never cocks,
   * so the "reconnect budget" stays at 0 from start to finish. Real device 2026-09-03: one minute
   * after losing network
   * `navigator.onLine` was already `false`, while the shell header still said "in progress" and the
   * seconds were still counting up,
   * with not a single word on screen. **The browser knew all along; we never asked it.**
   *
   * The reading is fixed at `1/1`: there's **no ladder counting** behind this tier, and writing
   * "1/5" would be a lie.
   * `Reconnect`'s `showCount = max > 1` therefore automatically draws just the sentence, not the
   * fraction.
   *
   * There's no `exhausted` either: having no network doesn't "retry until exhausted", it's closed by
   * `online`,
   * and putting a [Reconnect] there would have no corresponding action —— what can be done is on the
   * browser's side, not on this button.
   */
  | { kind: 'network'; runId: string; conversationId: string; online: boolean };

/**
 * One signal advances the state once. Returning `prev` unchanged means "this signal is unrelated to
 * the row on screen".
 */
export function nextChatReconnectView(
  prev: ChatReconnectView | null,
  signal: ChatReconnectSignal,
): ChatReconnectView | null {
  if (signal.kind === 'manual-retry') {
    if (!prev || prev.runId !== signal.runId) return prev;
    if (!prev.exhausted) return prev;
    // Starting at 1: this is the first attempt of **the human-pressed** episode, not a continuation
    // of the transport layer's count.
    // "Of how many" reuses the same transport layer budget, and the ladder restarts from 1/5 after
    // the break too.
    return { ...prev, attempt: 1, exhausted: false, manualRetry: true };
  }

  if (signal.kind === 'manual-retry-expired') {
    if (!prev || prev.runId !== signal.runId || !prev.manualRetry) return prev;
    return { ...prev, attempt: prev.max, exhausted: true, manualRetry: false };
  }

  if (signal.kind === 'network') {
    /*
     * When the network comes back, only close its own episode. The row the transport layer is
     * counting must not be touched: whether this screen has network,
     * and whether the browser ↔ daemon stream is through, are two things —— whether the latter is
     * fine is for its own
     * `cleared` to decide, and using `online` to withdraw it is announcing "already connected" on
     * its behalf.
     */
    if (signal.online) return prev?.offline ? null : prev;
    // The transport layer's reading is more specific (it can count which attempt, it reaches 22-3),
    // so no downgrade while it's present.
    if (prev && !prev.offline) return prev;
    // A repeated offline report in the same run doesn't create a new object, to avoid a wasted
    // re-render.
    if (prev && prev.runId === signal.runId) return prev;
    return {
      reason: 'transport',
      runId: signal.runId,
      conversationId: signal.conversationId,
      attempt: 1,
      max: 1,
      exhausted: false,
      manualRetry: false,
      offline: true,
    };
  }

  if (signal.kind === 'agent-retry' || signal.kind === 'agent-reconnect') {
    if (prev && prev.runId !== signal.runId) return prev;
    /*
     * The disconnected row can cover the retry row; the reverse can't.
     *
     * In today's implementation these two never meet: the daemon sending an `error` frame doesn't
     * close the stream
     * (`runtimes/runs.ts` only `sse.end()`s in `finish()`, and same-run retries don't go through
     * `finish()`), and on the web side an `error` frame is just cached and reading continues,
     * without recording a reconnect.
     * But that's a property of the current implementation, not a guarantee of this layer.
     *
     * If they really do arrive together: a broken line is the bigger fact, and that row carries a
     * [Reconnect] ——
     * the user at least has something to press. The retry row has no button at all, so covering it
     * loses no way out.
     */
    if (prev?.reason === 'transport') return prev;
    if (signal.phase === 'cleared') return null;
    return {
      reason: signal.kind,
      runId: signal.runId,
      conversationId: signal.conversationId,
      attempt: signal.attempt,
      max: signal.max,
      exhausted: false,
      manualRetry: false,
      offline: false,
    };
  }

  if (signal.kind === 'dropped') {
    if (signal.runId && prev && prev.runId !== signal.runId) return prev;
    /*
     * What "the reattachment really started" withdraws is **the transport layer's episode reading** ——
     * switching to another stream voids the previous episode's attempt count. But whether this
     * screen has network has nothing to do with switching streams: the reattachment starting doesn't
     * mean the network is back,
     * and that reattach stream will fail by itself, after which the transport layer reports its own
     * reading on top. Withdraw it and
     * the screen goes blank between "reattach started" and "reattach failed", leaving the shell
     * header saying only "in progress".
     *
     * A full clear without `runId` (switching sessions, leaving the project, unmounting) still
     * withdraws it as well: at that point
     * locally we're not following this stream at all, and no row should stay on screen.
     */
    if (signal.runId && prev?.offline) return prev;
    return null;
  }

  if (signal.kind === 'settled') {
    if (!prev || prev.runId !== signal.runId) return prev;
    switch (signal.status) {
      case 'queued':
      case 'running':
        // Hearing this turn running again after handing it back to the human = the outer
        // reattachment connected. The post-exhaustion reattachment's
        // own reading starts from 0, so it won't send `cleared`, and "alive again" is the only
        // recovery evidence.
        // While still counting we don't accept this: that's only a status echo, and real recovery is
        // for `cleared` to decide.
        return prev.exhausted ? null : prev;
      case 'cancelled':
        // remixclip's ChatRunStatus uses cancelled (OD calls it canceled). Make way for component 20:
        // the disconnect itself can't produce cancelled, so what's dropped here must be "the user
        // pressed stop during the disconnect" ——
        // what to say is for the pause row to say.
        return null;
      case 'completed':
        return null;
      case 'failed':
        // In the optimistic window `exhausted` is false, and `failed` is exactly the word the
        // transport layer writes during a disconnect ——
        // taking the path below equals "one press makes the whole row disappear", back to that dead
        // end. The window's ending is only the expiry gate.
        if (prev.manualRetry) return prev;
        // After exhaustion the transport layer sends failed first, then exhausted, and the error path
        // fires another failed.
        // A row already handed back to the human has to hold; one not handed back settles along with
        // the turn.
        return prev.exhausted ? prev : null;
    }
  }

  if (signal.phase === 'cleared') {
    if (prev && prev.runId !== signal.runId) return prev;
    return null;
  }

  return {
    reason: 'transport',
    runId: signal.runId,
    conversationId: signal.conversationId,
    attempt: signal.attempt,
    max: signal.max,
    exhausted: signal.phase === 'exhausted',
    // The transport layer's own words are never an optimistic reading —— as soon as it takes over,
    // that expiry gate is void.
    manualRetry: false,
    // Nor is it the browser tier: after the transport layer takes over, `online` shouldn't withdraw
    // this row anymore (see `network`).
    offline: false,
  };
}

/**
 * Fill in a "this turn has actually settled" signal from the message table; return `null` if there's
 * nothing to fill in.
 *
 * Why it's needed: today `settled` is only sent **on the stream** —— reading a terminal status in
 * the stream, or in the reattachment.
 * But this row appears exactly when the stream is broken, so that turn's outcome often comes in
 * through another door
 * (session refresh, re-pulling messages when switching back to this session). On a real device
 * (2026-08-27) this is what was seen:
 * the user pressed [Reconnect], the content came back via a session refresh and the message said
 * "completed",
 * while the row was still hanging below saying "connection failed" —— exactly what the spec's "don't leave
 * afterimages" is meant to block.
 *
 * The criterion is handed back to `nextChatReconnectView`; this doesn't decide on its own whether to
 * withdraw:
 * `failed` is **a no-op** for a row already handed back to the human (the 22-3 button has to hold),
 * and only `succeeded` / `canceled` are a real ending.
 */
export function settledSignalFromMessages(
  view: ChatReconnectView | null,
  messages: ReadonlyArray<{ runId?: string | null; runStatus?: ChatRunStatus | null }> | undefined,
): ChatReconnectSignal | null {
  if (!view || !messages) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.runId !== view.runId) continue;
    const status = message.runStatus;
    if (status === 'completed' || status === 'cancelled') {
      return { kind: 'settled', runId: view.runId, status };
    }
    return null;
  }
  return null;
}

/**
 * The last gate before rendering: is this row about the current session. If not, pretend there's
 * none.
 */
export function reconnectViewForConversation(
  view: ChatReconnectView | null,
  conversationId: string | null | undefined,
): ChatReconnectView | null {
  if (!view) return null;
  if (!conversationId) return null;
  return view.conversationId === conversationId ? view : null;
}
