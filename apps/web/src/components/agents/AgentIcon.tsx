'use client';

/**
 * [INPUT]: agent id and size (optional className).
 * [OUTPUT]: Brand icon: svg/png assets, monochrome marks via CSS mask, initials as fallback when missing.
 * [POS]: Single source for Agent visual identity, reused by the detect dialog, sidebar and chat header.
 */
import type { CSSProperties } from 'react';
import { cn } from '@/lib/utils';

interface Props {
  id: string;
  size?: number;
  className?: string;
}

// Brand assets shipped with the bundle (source: apps/web/public/agent-icons).
const ICON_EXT: Record<string, 'svg' | 'png'> = {
  amr: 'svg',
  claude: 'svg',
  codex: 'svg',
  gemini: 'svg',
  opencode: 'svg',
  'cursor-agent': 'svg',
  copilot: 'svg',
  qwen: 'svg',
  qoder: 'svg',
  deepseek: 'svg',
  reasonix: 'svg',
  mimo: 'svg',
  hermes: 'svg',
  'grok-build': 'svg',
  kimi: 'svg',
  pi: 'svg',
  kiro: 'svg',
  kilo: 'svg',
  vibe: 'svg',
  antigravity: 'svg',
  aider: 'png',
  'trae-cli': 'png',
  devin: 'png',
};

// Runtime variants from the same vendor share one image.
const ICON_ASSET_ID: Record<string, string> = {
  'deepseek-harness': 'deepseek',
  'byok-opencode': 'opencode',
};

// Runtimes without their own brand image reuse the app's own mark (CatPaw and mc are the same CLI).
const ICON_SRC_OVERRIDE: Record<string, string> = {
  mc: '/remixclip-logo.svg',
};

// Monochrome silhouette: drawn with a mask, color follows surrounding text.
const MONO_ICONS = new Set([
  'cursor-agent',
  'opencode',
  'hermes',
  'mimo',
  'kilo',
  'grok-build',
]);

export function AgentIcon({ id, size = 32, className }: Props) {
  const assetId = ICON_ASSET_ID[id] ?? id;
  const overrideSrc = ICON_SRC_OVERRIDE[id];
  const ext = ICON_EXT[assetId];

  if (overrideSrc) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={overrideSrc}
        alt=""
        width={size}
        height={size}
        className={cn('shrink-0 select-none object-contain', className)}
        aria-hidden="true"
        draggable={false}
      />
    );
  }

  if (ext === 'svg' && MONO_ICONS.has(assetId)) {
    // The mask tiles at the source size (150px) by default; must explicitly use contain + center,
    // otherwise only a small transparent patch in the top-left remains.
    const style: CSSProperties = {
      width: size,
      height: size,
      WebkitMaskImage: `url("/agent-icons/${assetId}.svg")`,
      maskImage: `url("/agent-icons/${assetId}.svg")`,
      WebkitMaskSize: 'contain',
      maskSize: 'contain',
      WebkitMaskRepeat: 'no-repeat',
      maskRepeat: 'no-repeat',
      WebkitMaskPosition: 'center',
      maskPosition: 'center',
    };
    return (
      <span
        className={cn('inline-block shrink-0 bg-current', className)}
        style={style}
        aria-hidden="true"
      />
    );
  }

  if (ext) {
    return (
      // Local static asset; use a native img to avoid extra next/image configuration.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`/agent-icons/${assetId}.${ext}`}
        alt=""
        width={size}
        height={size}
        className={cn('shrink-0 select-none', className)}
        aria-hidden="true"
        draggable={false}
      />
    );
  }

  const initial = (id.match(/[a-z]/i)?.[0] ?? '?').toUpperCase();
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-md border border-border bg-foreground/[0.06] font-mono font-semibold text-foreground/70',
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42), lineHeight: 1 }}
      aria-hidden="true"
    >
      {initial}
    </span>
  );
}
