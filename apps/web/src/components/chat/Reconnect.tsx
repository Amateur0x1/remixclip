/**
 * [INPUT]: Transport/proxy self-heal state, optional reconnect and detail callbacks, and shadcn Button.
 * [OUTPUT]: A card-less status row while reconnecting, on the last try, or on failure; renders nothing once recovered.
 * [POS]: Reconnect hint at the tail of the chat stream, using a neutral gray status and shadcn action buttons.
 *
 * Copy is inline; Orb is temporarily replaced by a same-size ball. The sweep reuses the theme's shimmer-text.
 *
 * Three states:
 *   82 · Reconnecting  ball + 'Reconnecting 2/5' with a sweep + ⌄
 *   83 · Last try      Same as above, only the count reaches 5/5 — **not a separate form**, no style changes
 *   84 · Failed        Dark gray wifi-off + 'Network connection could not be restored' + 'Reconnect' button
 *
 * After recovery **the whole row disappears, no 'Recovered' left behind** (cmp-ops, verbatim). So `attempt <= 0` returns null.
 */
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';
import type { ChatSelfHealReason } from '../../runtime/chat/reconnect-state';

export interface ReconnectProps {
  /**
   * Which attempt. Clamped into `[1, max]` when displayed — when the reconnect budget is topped up
   * by keepalive idling, the count can exceed the budget, but the screen shouldn't show '7/5'.
   *
   * `<= 0` = not dropping out right now, render nothing for the row.
   */
  attempt: number;
  /** How many in total. One row says one thing, so the two budgets never mix — see `reason`. */
  max: number;
  /** Which 'system self-heal' this row is about. Defaults to transport reconnect (the original meaning in 22). */
  reason?: ChatSelfHealReason;
  /** Attempts exhausted: stop auto-reconnecting and hand back to the user (22-3). */
  exhausted?: boolean;
  /** What pressing 'Reconnect' does. Omit it and the button doesn't appear. */
  onReconnect?: () => void;
  /** Click ⌄ to see where it broke. **Omit it and there's no chevron, that's the default**: a chevron that opens nothing is worse than none. */
  onShowDetail?: () => void;
}

/*
 * De-bordered row shell. Design spec, verbatim: 'Reconnecting is a state, not a card… wrap it in a border
 * and a fill and it becomes a second block next to the input, turning 'ignore it' into 'look here'."
 * All three states share one shape — the failure state also uses neutral colors, told apart by the icon and copy.
 * The border stays but is transparent: the spec keeps that 1px **position**; dropping it makes the row 2px shorter than the adjacent tool row.
 */
const ROW =
  'flex items-center gap-2 rounded-md border border-transparent px-0.5 py-[5px] text-[13px] leading-[18px] text-gray-900';

export function Reconnect({
  attempt,
  max,
  exhausted = false,
  reason = 'transport',
  onReconnect,
  onShowDetail,
}: ReconnectProps): ReactElement | null {
  const { t } = useI18n();
  if (exhausted) {
    return (
      <div className={ROW} data-testid="chat-reconnect">
        <WifiOffIcon />
        <span className="min-w-0 flex-1 truncate">{t('reconnect.failed')}</span>
        {onReconnect ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="h-6 flex-none border-border bg-background px-2.5 text-xs text-foreground shadow-none"
            onClick={onReconnect}
          >
            {t('reconnect.action')}
          </Button>
        ) : null}
      </div>
    );
  }

  if (attempt <= 0) return null;

  const shown = Math.min(Math.max(attempt, 1), max);
  /*
   * When the budget is just one, don't show a fraction. '1/1' reads like a countdown and conveys nothing:
   * there's only one, and it's being used right now. Make it a condition, not a hardcode — once the budget
   * really widens, the same code starts showing '1/2' on its own, no one has to remember to change it again.
   */
  const showCount = max > 1;

  return (
    <div className={ROW} data-testid="chat-reconnect">
      <Ball />
      {/* The sweep must hang off an inline box **shrunk to the text width**: the gradient is sized by the
          element's box width, so on a flex:1 full-width box the highlight mostly sweeps the blank right of the text.
          Hence the extra shrink box on the inside. */}
      <span className="min-w-0 flex-1 truncate [&>*]:inline-block [&>*]:max-w-full">
        <span className="shimmer-text">
          {reason === 'agent-retry' ? t('reconnect.retrying') : t('reconnect.reconnecting')}
          {showCount ? (
            <span className="ms-1.5 [color:inherit] [font-variant-numeric:tabular-nums] [font-weight:inherit]">
              {shown}/{max}
            </span>
          ) : null}
        </span>
      </span>
      {onShowDetail ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="-me-1 size-[22px] flex-none text-muted-foreground hover:text-foreground"
          aria-label={t('reconnect.detail')}
          title={t('reconnect.detail')}
          onClick={onShowDetail}
        >
          <ChevronIcon />
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The ball shown while reconnecting. OD's `Orb state="searching" box={24}` is an eight-layer conical gradient engine;
 * remixclip starts with a same-footprint Tailwind ball; swapping back to the Orb atom layer only touches this one function.
 * The 24px canvas is a notch bigger than sibling glyphs; `-mx-[3px]` pulls in the canvas padding, putting it back on the icon tier.
 */
function Ball(): ReactElement {
  return (
    <span className="inline-flex flex-none items-center -mx-[3px]" aria-hidden>
      <span className="mx-px h-2.5 w-2.5 animate-reconnect rounded-full bg-foreground opacity-[0.85]" />
    </span>
  );
}

/** ⌄: click to see the break reason. There's no break-reason taxonomy yet, so it's off by default (see `onShowDetail`). */
function ChevronIcon(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

/**
 * The disconnected glyph is a **solid** icon, not a three-arc line drawing — the path is taken verbatim from
 * slot 84 of the design spec (`svg.wifi.mod-off`), not redrawn. The slash nearly fills `0 0 24 24`, so it gets
 * its own tier: a 14px square.
 */
function WifiOffIcon(): ReactElement {
  return (
    <svg className="h-3.5 w-3.5 flex-none text-foreground" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12.0001 18C12.7144 18 13.3704 18.2497 13.8856 18.6665L12.0001 21L10.1145 18.6665C10.6297 18.2497 11.2857 18 12.0001 18ZM2.80766 1.39343L20.4853 19.0711L19.0711 20.4853L13.8913 15.3042C13.2967 15.1069 12.6609 15 12.0001 15C10.5719 15 9.26024 15.499 8.22998 16.3322L6.97363 14.7759C8.24961 13.7442 9.84925 13.0969 11.5964 13.01L9.00025 10.414C7.55273 10.8234 6.22651 11.5217 5.0878 12.4426L3.83099 10.8868C4.89946 10.0226 6.10763 9.32438 7.41633 8.83118L5.13168 6.5451C3.98878 7.08913 2.92058 7.76472 1.94666 8.55228L0.689453 6.99674C1.60358 6.25747 2.59156 5.60589 3.64058 5.05479L1.39345 2.80765L2.80766 1.39343ZM14.5004 10.2854L12.2165 8.00243L12 8C15.0947 8 17.9369 9.08141 20.1693 10.8869L18.9123 12.4426C17.6438 11.4167 16.1427 10.6672 14.5004 10.2854ZM12.0001 3.00003C16.2849 3.00003 20.22 4.49719 23.3109 6.99691L22.0534 8.55228C19.3061 6.33062 15.8085 5.00003 12.0001 5.00003C11.122 5.00003 10.2604 5.07077 9.42075 5.20685L7.72455 3.51088C9.09498 3.17702 10.5268 3.00003 12.0001 3.00003Z" />
    </svg>
  );
}
