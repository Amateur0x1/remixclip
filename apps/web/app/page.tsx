'use client';

/**
 * [INPUT]: the RemixclipWorkspace workspace container.
 * [OUTPUT]: the Next.js App Router root page entry.
 * [POS]: the web app entry point (apps/web/app/page.tsx); state orchestration and UI components
 *        are delegated to src/components/workspace and src/components/chat.
 */
import { RemixclipWorkspace } from '@/components/workspace/RemixclipWorkspace';

export default function HomePage() {
  return <RemixclipWorkspace />;
}
