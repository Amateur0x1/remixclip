/**
 * "Am I still following the latest output" —— **an intent, not a value inferred from position**.
 *
 * The old approach inferred it: `pinnedToBottom = distance < 80`, recomputed on every scroll
 * event.
 * That locks up under streaming, and it's a **structural** lockup that no threshold adjustment can
 * fix:
 *
 *   following writes `scrollTop` back to the bottom → `distance` goes to zero → inferred as "still
 *   following" → keep following
 *
 * The user scrolls up one notch (one trackpad notch ~40px), and it's written back to the bottom
 * before the next block arrives, so he can **never accumulate 80px**. What that looks like is "the
 * whole chat can't even scroll up" (user, 2026-08-27).
 *
 * The replacement: the intent **changes only through user actions**. Content growing or shrinking,
 * our own writes to `scrollTop`, panel resizes —— none of them may touch it. The user's words on
 * 2026-08-27:
 * "once the user manually scrolls somewhere else, that position should stay fixed".
 *
 * ── This state machine ports the core of `use-stick-to-bottom` (MIT, stackblitz-labs, 3.5M weekly
 *    downloads, what Vercel AI SDK's `<Conversation>` uses), plus a better criterion from
 *    assistant-ui's `useThreadViewportAutoScroll`. Why port instead of just adding the dependency,
 *    see the end of this file.
 *
 * ## Three booleans, not one
 *
 * This is the easiest place to get it wrong while porting:
 *
 *   · `following` —— the intent lock: whether right now we should hug the latest output.
 *   · `escaped`   —— the user deliberately broke away. It is not the same as `following`:
 *                    without it, "scroll back a little" is immediately judged back into following,
 *                    and the deadlock revives as-is.
 *   · "how far from the bottom" —— pure geometry, computed fresh each time, **not stored**.
 *
 * Leaving and returning use two different conditions:
 *   leaving only requires actually leaving the bottom; returning requires **actively scrolling
 *   down and actually reaching the bottom**.
 * "a few dozen pixels from the bottom" is still the reading position the user chose, not
 * authorization to auto-pin to the bottom.
 *
 * ## How to tell "the user scrolled" from "content / ourselves caused it"
 *
 * Not by a timer, but by one structural criterion (taken from assistant-ui):
 *
 *   scrolling up := position decreased **and `scrollHeight` unchanged**
 *
 * Position changes caused by content growing or shrinking (browser clamping, native scroll
 * anchoring's correction of `scrollTop` after content above reflows) are necessarily accompanied by
 * a `scrollHeight` change, so they're naturally excluded —— far more reliable than "record a time
 * window and guess".
 *
 * Also, after **we** write `scrollTop` every time, the new position must be recorded into the
 * baseline (`sampleGeometry`), otherwise the next user scroll's delta is computed against the old
 * baseline and the direction comes out reversed.
 *
 * ## Why not set `overflow-anchor: none`
 *
 * Intuitively, "I compute scroll positions myself, so I should turn off the browser's scroll
 * anchoring" —— **that's backwards**.
 * Keeping the reading position from jumping when content above reflows (late images/iframes,
 * earlier content re-laying out) is exactly what the browser's native scroll anchoring does; neither
 * `use-stick-to-bottom` nor assistant-ui has ever set `overflow-anchor: none`, and the former's
 * README line "Correctly handles Scroll
 * Anchoring" means "won't misread anchoring's corrections as user scrolling", not "implemented
 * anchoring ourselves". Our mechanism for not misreading it is the `scrollHeight` criterion above.
 * (Cost: Safari still has no scroll anchoring, so reflows above still jump there —— that's the
 * browser's bill, not something this state machine can make up for.)
 */

export interface ScrollSample {
  scrollTop: number;
  /** Total content height. The caller is responsible for **subtracting** the whitespace reserved
   * for anchor-to-top before passing it in. */
  scrollHeight: number;
  clientHeight: number;
}

export interface FollowIntent {
  /** Whether right now we should hug the latest output. */
  following: boolean;
  /** The user deliberately scrolled away —— only an active scroll down can clear it. */
  escaped: boolean;
}

/**
 * Small enough to still count as "hugging the bottom".
 *
 * It can't be 1px: on `devicePixelRatio: 2` screens the browser truncates `scrollTop` to one pixel
 * short of the real bottom, so a strict criterion **never holds** (assistant-ui PR #4141 fixes
 * exactly this); it's worse under fractional scaling (use-stick-to-bottom issue #32). We use 8px.
 */
export const AT_BOTTOM_TOLERANCE_PX = 8;

/** The band for "scrolled back near the bottom", computed as a viewport fraction —— "close enough
 * to the bottom" is not the same pixel count in a narrow panel and a wide one. */
const RESUME_BAND_RATIO = 0.12;
const RESUME_BAND_MIN_PX = 40;
const RESUME_BAND_MAX_PX = 120;

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

export function resolveResumeBand(clientHeight: number): number {
  const height = Number.isFinite(clientHeight) && clientHeight > 0 ? clientHeight : 0;
  return clamp(height * RESUME_BAND_RATIO, RESUME_BAND_MIN_PX, RESUME_BAND_MAX_PX);
}

/** How far from the bottom of the content. Counts as 0 when the content is shorter than the
 * viewport. */
export function distanceFromBottom({ scrollTop, scrollHeight, clientHeight }: ScrollSample): number {
  return Math.max(0, scrollHeight - scrollTop - clientHeight);
}

/** The content doesn't fill a screen at all, or it's pinned to the bottom. */
export function isAtBottom(sample: ScrollSample): boolean {
  if (sample.scrollHeight <= sample.clientHeight) return true;
  return distanceFromBottom(sample) <= AT_BOTTOM_TOLERANCE_PX;
}

/** Close enough to resume following. */
export function isNearBottom(sample: ScrollSample): boolean {
  if (sample.scrollHeight <= sample.clientHeight) return true;
  return distanceFromBottom(sample) <= resolveResumeBand(sample.clientHeight);
}

/** The furthest position it can scroll to. The denominator of "how far the bottom is from the
 * user". */
function maxScrollTopOf(sample: ScrollSample): number {
  return Math.max(0, sample.scrollHeight - sample.clientHeight);
}

/**
 * Whether a "look back" gesture (wheel up, finger drag down) **could possibly** actually carry the
 * user away from the bottom in this geometry.
 *
 * ## Why the gesture side needs its own criterion
 *
 * Normally only `nextFollowIntent` changes the intent, and it works **after the fact**: there's a
 * displacement first, then the direction is judged.
 * But under fast streaming that path breaks —— if we wrote `scrollTop` in the same frame, the
 * browser cancels that whole wheel scroll outright and doesn't even fire a scroll event. So callers
 * also attach wheel / touch listeners and let go **before** the displacement happens (this is also
 * why `use-stick-to-bottom` attaches a separate wheel listener).
 *
 * The cost is that this side gets no displacement, only the gesture. So it must answer a question
 * itself: **could this notch of gesture produce an "leaving the bottom"?** Failing to answer means
 * "a gesture happened but not a single pixel moved" gets misjudged as "the user swiped away".
 *
 * ## The criterion
 *
 * An upward gesture can only decrease `scrollTop`, so the **maximum** distance from the bottom it
 * can produce is `maxScrollTop` (scrolling all the way to the top). And `nextFollowIntent`'s
 * threshold for breaking away is `!isAtBottom(next)`, i.e. distance from bottom >
 * `AT_BOTTOM_TOLERANCE_PX`. Together:
 *
 *   · `maxScrollTop <= AT_BOTTOM_TOLERANCE_PX` —— there is **not a single position** in this
 *     geometry that counts as "not at the bottom". The user is at the bottom now, and is still at
 *     the bottom after scrolling to the top. Breaking away is physically impossible.
 *   · `scrollTop <= 0` —— already at the top, an upward gesture's displacement is always 0.
 *
 * Both are **necessary** conditions, not sufficient: passing only means "possible", and the actual
 * decision is still handed to `nextFollowIntent` by the following scroll event. This only keeps
 * the impossible cases out.
 *
 * ## Why not `scrollHeight > clientHeight`
 *
 * That's "slack strictly greater than 0", which **doesn't line up** with the 8px tolerance the rest
 * of this state machine uses.
 *
 * "A conversation that fits in one screen has zero slack" is **wrong**, and wrong by more than a
 * pixel or two.
 * Packaged build `0.21.2-beta.1` real-device sampling (every 800ms, read-only): the "just entered
 * the session, very little content" state appeared 108 times, with **constant** geometry:
 *
 *   scrollHeight = 589   clientHeight = 583   slack = 6px
 *
 * (Another 37 times were 583 / 583, slack 0 —— that tier the old criterion already blocked.)
 * Note 6px is **not** explainable by subpixel rounding: rounding error is a fraction of a pixel to
 * one or two pixels, and it jitters; 6px across 108 motionless samples is **real content overflow**
 * (the padding / margin layer), just so small the user can't see it on screen at all. So what needs
 * blocking here is not "rounding noise", but that whole range of "so small that scrolling equals
 * not scrolling".
 *
 * A strict criterion therefore misses an entire class of gestures where "the user feels they
 * haven't scrolled a single notch": the screen doesn't budge, yet following has already been
 * released, and all subsequent streaming output runs off screen
 * (user, 2026-09-07: "right after entering a session I scrolled up a few times, but it wouldn't
 * move because there was barely any content, and then later streaming output stopped sticking to
 * the bottom" —— confirmed on a real device to go through the wheel/trackpad path).
 *
 * ⚠️ Reusing `AT_BOTTOM_TOLERANCE_PX` as the threshold is **derived**, not tuned:
 * breaking away is by definition `!isAtBottom`, so the gesture side and the decision side must use
 * the same ruler, otherwise they diverge again. The real-device 6px landing inside 8px is
 * **verification**, not the source of this number —— in other words, if one day we measure a 12px
 * slack, what should change is something outside this invariant, not bumping 8 up.
 */
export function upwardGestureCanEscapeBottom(sample: ScrollSample): boolean {
  if (sample.scrollTop <= 0) return false;
  return maxScrollTopOf(sample) > AT_BOTTOM_TOLERANCE_PX;
}

/**
 * Which direction the **wheel** is asking for when this displacement happened.
 *
 * Count instead of storing the last notch's direction: a single trackpad swipe can emit a dozen
 * notches between two scroll events, and may even reverse midway. Storing only the last notch would
 * read "the last notch in a net-upward burst happening to point down" as downward.
 *
 * ## One slip explains exactly one displacement
 *
 * The witness is **testimony**, not state: it says "at exactly this position, the user's wheel was
 * asking down".
 * A slip that can explain any subsequent displacement would weld following shut, which is worse
 * than the bug it fixes.
 * So it carries `atScrollTop` —— the displacement's starting point must be exactly the position at
 * which it was recorded.
 *
 * This is **structural**, not a time window: switching sessions, our own writes to `scrollTop`, and
 * log nodes being swapped all move the baseline away, so the old slip no longer matches and is
 * voided automatically. Callers also manage two time-related things separately (clear on use,
 * expire after one frame), see `ChatPane`'s `resetWheelWitness`.
 */
export interface WheelWitness {
  /** Notches toward the bottom (`deltaY > 0`). */
  downwardEvents: number;
  /** Notches toward the top (`deltaY < 0`). */
  upwardEvents: number;
  /**
   * Where the scrollbar was when this slip was recorded.
   *
   * The displacement's start (`previous.scrollTop`) must be **exactly** this. Anything off voids
   * it —— a mismatch means something else moved this scrollbar in between, and the slip no longer
   * explains the displacement in front of us.
   */
  atScrollTop: number;
}

/**
 * Whether this "position decreased" is **the compositor clamping an out-of-bounds position back to
 * its own stale limit**, not the user swiping up.
 *
 * ## Why `nextFollowIntent`'s original criterion couldn't tell
 *
 * The original comment said "displacements caused by content changes are necessarily accompanied by
 * a `scrollHeight` change". That holds for **content-driven** displacements (scroll anchoring,
 * reflow), but not for this one:
 * to let the wheel not wait on the main thread, Chromium keeps its own copy of "how far this box
 * can scroll", and that copy gets stuck at the old value and stops following layout. Real-device
 * (Electron 41 / Chromium 146) diagnostic bundle:
 *
 *   scrollTop 245.5   layoutMax 718   scrollHeight 1307   unreachablePx 472.5
 *
 * Click [scroll to latest] → `scrollTo({top:1307})` → the position lands at 718.5 (layout's real
 * bottom); the user touches the wheel once, and the compositor throws it back to its own stale
 * limit of 245.5. Throughout this `scrollHeight` didn't change by a single pixel (the content is
 * static) —— so "position decreased + `scrollHeight` unchanged" both hold, every clamp is read as
 * a user swipe up, and following is silently turned off.
 *
 * The same phenomenon was independently measured in `observability/chat-scroll-freeze-detector.ts`,
 * which recorded: `scrollTop = 800`, **one notch downward** on the wheel, and the position gets
 * thrown to 91.
 *
 * ## The criterion: a downward wheel + the position running upward anyway
 *
 * A user swipe up either comes with an **upward** wheel, or with no wheel at all (dragging the
 * scrollbar / keyboard / touch).
 * So "the wheel in this window is **only** downward" is never true of a user swipe up —— it's
 * saying "what the user wants right now is to go toward the bottom". Yet the position moves the
 * other way, so it's not his hand.
 *
 * The other three candidates aren't enough:
 *
 *  · **The landing point equals a known stale limit** —— that limit can only be derived from the
 *    freeze detector's stall / snap-back state machine, and
 *    `runtime/chat-scroll-takeover.ts` states that detector's false-positive rate is **still
 *    unknown** (`client_chat_scroll_frozen` has zero events in production, and that zero later
 *    turned out to be a reporting defect). Besides, the user could perfectly well stop at exactly
 *    that number.
 *  · **The gap from `layoutMax`** —— a user swipe up can stop anywhere in `[0, layoutMax]`, so this
 *    carries no discriminating information.
 *  · **Immediately after a JS write** —— disproved by the diagnostic bundle itself: the clamp
 *    happened **3.8 seconds** after the write, with zero JS writes recorded in between. A time
 *    window wide enough to cover 3.8 seconds would swallow normal swipes too.
 *
 * ## The witness must **sit right on** the displacement it explains
 *
 * A downward notch that lands on a log **already at the bottom** moves the position not a single
 * pixel, so no scroll event is even fired —— nobody consumes that slip. If it sticks around, any
 * subsequent **non-wheel** position change (in-page find, focus-driven scrolling, re-positioning
 * after switching sessions) would hit it, be judged a clamp, and following wouldn't be released.
 * That is precisely "welding following shut", the opposite direction of this bug but worse
 * (what nettee called out on #7898).
 *
 * `atScrollTop` blocks the **structural** half of that: if the baseline moved for another reason,
 * the slip doesn't match. The remaining "the baseline didn't move, but that notch was long ago" is
 * the caller's expiry's job.
 *
 * ⚠️ This only answers "it is **not** a user swipe up", not "the compositor is definitely broken".
 * The criterion would rather miss (a clamp without a wheel witness is still treated as a swipe up)
 * than overjudge: an extra false judgment welds following shut, which is worse than the current
 * bug.
 *
 * The displacement threshold reuses `AT_BOTTOM_TOLERANCE_PX` (8px) —— under high DPI / fractional
 * scaling the pinned position jitters subpixel anyway, and this is the same ruler the rest of this
 * state machine uses. The freeze detector's `SNAP_BACK_MIN_PX` independently arrived at 8 from the
 * same batch of measurements.
 */
export function isCompositorSnapBack(
  previous: ScrollSample,
  next: ScrollSample,
  wheel: WheelWitness | null | undefined,
): boolean {
  if (wheel == null) return false;
  // A single upward notch voids it: that notch itself is the user asking to swipe up.
  if (wheel.upwardEvents > 0) return false;
  if (wheel.downwardEvents <= 0) return false;
  // This slip doesn't record the start of the displacement in front of us —— something else moved
  // the scrollbar in between, void.
  if (wheel.atScrollTop !== previous.scrollTop) return false;
  // If content moved it's not this phenomenon —— that kind of displacement is `layoutStable`'s job.
  if (next.scrollHeight !== previous.scrollHeight) return false;
  if (next.clientHeight !== previous.clientHeight) return false;
  return previous.scrollTop - next.scrollTop > AT_BOTTOM_TOLERANCE_PX;
}

/**
 * What the follow intent should become after a scroll.
 *
 * **Only here (and a few explicit actions: clicking "back to latest", sending a message, switching
 * sessions) may the intent change.**
 * Content growing or shrinking must never change it —— that's exactly the root disease of the old
 * approach.
 *
 * ## 【Caller invariant】when writing the position yourself, baseline and landing must agree in the
 * same beat
 *
 * This can't tell "who initiated the scroll", and the platform isn't going to let it:
 * `scrollend` explicitly carries no source (WICG/overscroll-scrollend-events#4), and
 * programmatically triggered scroll events also have `isTrusted === true`. So the criterion can only
 * rely on "direction + geometry", and it holds **only if callers follow the rules**:
 *
 * > Scrolls you initiate yourself are always **instant** (`behavior:'auto'`); to animate, call
 * > `release()` first.
 *
 * `behavior:'smooth'` breaks exactly this —— the caller records the baseline based on a prediction,
 * the browser only starts moving afterwards, and the string of intermediate positions it then emits
 * are all on the other side of the baseline, which here is a user scroll.
 * Trickier still with streaming: the browser freezes the landing point at the moment of the call,
 * content is still growing, so the animation lands somewhere that stopped being the bottom long
 * ago, and not even "the last frame is at the bottom, rescue it on the way" happens.
 * (`ChatPane`'s question-form positioning once fell into this, and of the two copies only one was
 * fixed.)
 *
 * ## `wheel`: which way the wheel was asking when this displacement happened
 *
 * Optional. Given, it adds one veto: a downward wheel paired with an upward displacement isn't a
 * user swipe up, it's a compositor clamp (see `isCompositorSnapBack`). Not given means no witness,
 * and the criterion falls back to "direction + geometry" —— i.e. exactly the behavior before this
 * parameter existed, not one notch different.
 */
export function nextFollowIntent(
  current: FollowIntent,
  previous: ScrollSample,
  next: ScrollSample,
  wheel?: WheelWitness | null,
): FollowIntent {
  // Position decreased **and total content height unchanged** = the user's hand. Displacements
  // caused by content changes (browser clamping, scroll anchoring corrections) are necessarily
  // accompanied by a `scrollHeight` change, and get excluded right here.
  const layoutStable =
    next.scrollHeight === previous.scrollHeight && next.clientHeight === previous.clientHeight;
  const scrolledUp = next.scrollTop < previous.scrollTop && layoutStable;
  /*
   * Scrolling down **doesn't require layout to be static**, only that "the bottom hasn't moved
   * toward the user".
   *
   * Strict `layoutStable` is wrong on the resume side: during streaming the content grows every
   * frame, and virtualization re-measurement also changes `scrollHeight`, so whenever the user's
   * scroll back to the bottom lands on a frame where "the content also grew", the whole event is
   * dropped and he scrolled for nothing —— while the escape side has wheel / touch as a fallback
   * and the resume side has none at all. That asymmetry is where "can never get back to following"
   * comes from.
   *
   * Relaxing to "`maxScrollTop` didn't decrease" is **provable**, not a tuned empirical value:
   *   · Content grew / viewport shrank ⇒ the bottom moves **away** from the user. If the position
   *     stays put the distance only grows, so "position increased and landed at the bottom"
   *     necessarily means the user really scrolled down at least that much.
   *   · Content shrank ⇒ the bottom moves **toward** the user, and the distance shrinks into the
   *     tolerance by itself —— this is exactly the "Plan / queue / composer height changes eating
   *     dozens of pixels" the original comment wanted to block, still blocked.
   *   · Scroll anchoring inserting content above raises both `scrollTop` and `scrollHeight`, the
   *     distance from the bottom stays the same, and it can't produce the "at the bottom" outcome.
   * So this needs no time window, and hence no "how wide the window" parameter that can't be
   * verified offline.
   */
  const bottomDidNotApproach = maxScrollTopOf(next) >= maxScrollTopOf(previous);
  const scrolledDown = next.scrollTop > previous.scrollTop && bottomDidNotApproach;

  let { following, escaped } = current;
  // A pixel or two of jitter while still pinned to the bottom doesn't count as breaking away ——
  // such jitter is normal on high DPI screens.
  // The compositor clamping an out-of-bounds position back to the stale limit looks the same
  // (position decreased + `scrollHeight` unchanged), but at that moment the user's wheel wants
  // **to go down** —— that's not breaking away, see `isCompositorSnapBack`.
  if (scrolledUp && !isAtBottom(next) && !isCompositorSnapBack(previous, next, wheel)) {
    escaped = true;
    following = false;
  }
  // Clearing escaped and restarting following must be **the same user scroll down to the bottom**.
  // Don't clear the latch early at "dozens of pixels from the bottom": a subsequent Plan / queue /
  // composer height change could make those dozens of pixels disappear naturally, and it would be
  // hooked back into following even though the user didn't move again.
  if (scrolledDown && isAtBottom(next)) {
    escaped = false;
    following = true;
  }
  return { following, escaped };
}

/*
 * ## Why port it instead of `pnpm add use-stick-to-bottom`
 *
 * `CONTRIBUTING.md`: "**No new top-level dependencies** without a paragraph in the PR
 * description on what we get vs. what bytes we ship." —— it asks for a reason, not a ban. So we
 * really did evaluate it:
 *
 *  · What's worth it about installing it: 2.7KB min+gzip, zero runtime deps, MIT.
 *  · What isn't: it requires binding a ref to the scroll container and another to the content, and
 *    **another div wrapper** around the content.
 *    `.chat-log` is a flex column container today, and `> .msg:first-of-type { margin-top: auto }`'s
 *    balancing, the per-child ResizeObserver, and the anchor-to-top tail spacer are all built on
 *    "messages are direct children of chat-log". Inserting a wrapper means redoing all of that.
 *  · It ships its own spring animation (integrating rAF itself). Under fast streaming it
 *    **deliberately lags behind the real bottom**
 *    (measured at 1200px/s the steady-state lag is ~196px). The existing implementation here pins
 *    to the bottom instantly, and comments spell out that smooth scrolling emits intermediate
 *    scroll events and breaks following —— adding a spring is re-digging that hole.
 *  · Three known defects all land squarely on this page, and all their PRs are hanging unmerged
 *    (the repo's last release was 2026-06-04): it doesn't observe the scroll container itself
 *    (composer growing / soft keyboard appearing silently misaligns it, issue #40), every scroll
 *    event calls setState and re-renders the whole subtree (issue #14), and there's no touch escape
 *    path on iOS (issue #9). Even installed, it'd need vendored patches.
 *  · It's pure ESM without `"use client"`.
 *
 * Conclusion: **take this state machine (~60 lines), not that animation and DOM contract.**
 * Every non-obvious criterion above cites its source.
 */
