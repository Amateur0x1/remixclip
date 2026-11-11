/**
 * When the "back to latest" float should be there.
 *
 * Why pull it out: the same criterion used to be **hard-coded four times in `ChatPane`**
 * (`distance > 120`),
 * written once each for scrolling, switching back to a session, restoring scroll position, and
 * navigating to a turn —— changing one threshold meant changing all four, and missing one made them
 * contradict each other. Here there's one copy, and all four call it.
 *
 * The threshold is computed from **viewport height**, not pinned to pixels: the user said on
 * 2026-08-27 "it keeps popping up for no reason; can it only appear when I'm way up top". And "way up top" isn't the same
 * pixel count in a 400px narrow panel and a 1200px wide one —— pinning it to 120px meant that after
 * a casual half-screen scroll it pops up and covers the turn status row.
 *
 * Show and hide use two thresholds (hysteresis): with only one threshold, slight scrolling near the
 * critical point makes it flicker repeatedly.
 */

/** Has to scroll past this fraction of the viewport to count as "way up top". */
const SHOW_RATIO = 0.75;
/** Relaxed to this ratio when hiding —— the gap between them is the hysteresis. */
const HIDE_RATIO = 0.5;
/** However short the panel, this much must be scrolled before offering the entry, so it doesn't
 * become over-sensitive again in small windows. */
const MIN_SHOW_PX = 320;
/** However tall the panel, it shouldn't require scrolling several screens —— anything beyond this
 * counts as "way up top". */
const MAX_SHOW_PX = 1200;

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

export interface JumpToLatestInput {
  /** How far from the bottom (`scrollHeight - scrollTop - clientHeight`). */
  distance: number;
  /** The scroll container's visible height. */
  clientHeight: number;
  /**
   * Total content height. If given it's used to decide "whether it can actually scroll"; if not,
   * only the thresholds apply (compatible with old call sites).
   */
  scrollHeight?: number;
  /** Whether it's already showing right now —— hysteresis needs it. */
  shown: boolean;
  /**
   * Whether it's currently following the latest output (see `stick-to-bottom.ts`).
   * If you're following, there is no "back to latest" —— you're already on the latest.
   */
  following?: boolean;
}

export function shouldShowJumpToLatest({
  distance,
  clientHeight,
  scrollHeight,
  shown,
  following,
}: JumpToLatestInput): boolean {
  /*
   * **No entry while following.** This one comes first, and it ignores `shown`.
   *
   * It replaces the pile of scattered "light the float up here / put the float out there"
   * assignments in the old approach:
   * unconditionally light it up on send, unconditionally light it up on expanding a foldable block
   * —— neither ever asked "is there actually anything down there".
   * Now the float is just a shadow of the follow intent, and all the scattered assignments are
   * gone.
   */
  if (following) return false;
  const height = Number.isFinite(clientHeight) && clientHeight > 0 ? clientHeight : 0;
  /*
   * **Can't scroll, no "latest" to go back to** (user, 2026-08-27: "don't show this when I can't scroll, okay??").
   *
   * This sits before the thresholds, and it ignores `shown` —— it's not a stricter threshold, it's
   * an invariant.
   * It's needed because `distance` is only recomputed on scroll events: scroll up in a long session
   * to reveal the float, then switch to a **short session**, nobody resets the state, and the short
   * session can't emit scroll events either,
   * so it hangs over a conversation that has no scrollbar in a single screen at all.
   *
   * The 1px allowance is for subpixels: when content is the same height as the container,
   * `scrollHeight` is often a fraction larger than `clientHeight`, and a strict `>` would judge
   * "actually can't scroll" as "can scroll".
   */
  if (scrollHeight != null && Number.isFinite(scrollHeight) && scrollHeight <= height + 1) {
    return false;
  }
  const showAt = clamp(height * SHOW_RATIO, MIN_SHOW_PX, MAX_SHOW_PX);
  if (!shown) return distance > showAt;
  // Already showing: lower the threshold so scrolling down a bit doesn't make it vanish instantly.
  const hideAt = clamp(height * HIDE_RATIO, MIN_SHOW_PX / 2, MAX_SHOW_PX);
  return distance > hideAt;
}
