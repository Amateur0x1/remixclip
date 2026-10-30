'use client';

/**
 * [INPUT]: Chat scroll container ref, message stream and LiveTurn change signal.
 * [OUTPUT]: open-design stick-to-bottom follow state-machine hook (scrollRef, jumpShown, resetFollow, handleScroll, handleWheel).
 * [POS]: Control layer for auto-sticking the chat scroll area to the bottom and showing the 'back to bottom' button.
 */
import { useCallback, useEffect, useRef, useState, type WheelEvent } from 'react';
import {
  distanceFromBottom,
  nextFollowIntent,
  upwardGestureCanEscapeBottom,
  type FollowIntent,
  type ScrollSample,
  type WheelWitness,
} from '@/runtime/chat/stick-to-bottom';
import { shouldShowJumpToLatest } from '@/runtime/chat/jump-to-latest';
import type { LiveTurn, UiMessage } from '@/components/chat/chat-types';

export function useStickToBottom(messages: UiMessage[], turn: LiveTurn) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef<FollowIntent>({ following: true, escaped: false });
  const prevSampleRef = useRef<ScrollSample | null>(null);
  const wheelRef = useRef<WheelWitness | null>(null);
  const [jumpShown, setJumpShown] = useState(false);
  const jumpShownRef = useRef(false);

  const sampleScroll = useCallback((): ScrollSample | null => {
    const el = scrollRef.current;
    if (!el) return null;
    return {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    };
  }, []);

  /** Everything other than user actions (own scrollTop writes, switching sessions, clicking 'back to latest') must resync baseline and intent */
  const resetFollow = useCallback(() => {
    followRef.current = { following: true, escaped: false };
    wheelRef.current = null;
    prevSampleRef.current = sampleScroll();
    jumpShownRef.current = false;
    setJumpShown(false);
  }, [sampleScroll]);

  const handleScroll = useCallback(() => {
    const next = sampleScroll();
    if (!next) return;
    const prev = prevSampleRef.current ?? next;
    prevSampleRef.current = next;
    const witness = wheelRef.current;
    wheelRef.current = null;
    followRef.current = nextFollowIntent(followRef.current, prev, next, witness);
    // The jump button mirrors the follow intent (shouldShowJumpToLatest: `following` has veto power)
    const shown = shouldShowJumpToLatest({
      distance: distanceFromBottom(next),
      clientHeight: next.clientHeight,
      scrollHeight: next.scrollHeight,
      shown: jumpShownRef.current,
      following: followRef.current.following,
    });
    jumpShownRef.current = shown;
    setJumpShown(shown);
  }, [sampleScroll]);

  const handleWheel = useCallback(
    (e: WheelEvent<HTMLDivElement>) => {
      const sample = prevSampleRef.current ?? sampleScroll();
      if (!sample) return;
      // Wheel witness (direction counts at the same position): the next scroll event uses it to veto the compositor clamp
      const w =
        wheelRef.current && wheelRef.current.atScrollTop === sample.scrollTop
          ? wheelRef.current
          : { downwardEvents: 0, upwardEvents: 0, atScrollTop: sample.scrollTop };
      wheelRef.current =
        e.deltaY > 0
          ? { ...w, downwardEvents: w.downwardEvents + 1 }
          : e.deltaY < 0
            ? { ...w, upwardEvents: w.upwardEvents + 1 }
            : w;
      // An upward gesture releases follow before the movement happens: under fast streaming, content arriving
      // in the same frame writes the position back to the bottom, the scroll event can be swallowed entirely,
      // and the user never accrues escape distance (structurally locked).
      if (e.deltaY < 0 && followRef.current.following && upwardGestureCanEscapeBottom(sample)) {
        followRef.current = { following: false, escaped: true };
      }
    },
    [sampleScroll],
  );

  // Follow: stick to bottom on content updates. After writing, the baseline must move to the landing point, otherwise the next user scroll measures displacement against the old baseline.
  useEffect(() => {
    if (!followRef.current.following) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    prevSampleRef.current = {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    };
  }, [messages, turn]);

  return {
    scrollRef,
    jumpShown,
    resetFollow,
    handleScroll,
    handleWheel,
  };
}
