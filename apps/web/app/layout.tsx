import type { Metadata } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { AppProviders } from '@/components/AppProviders';
import { zhCN } from '@/i18n/locales/zh-CN';
// The --chat-* theme seam for the chat atom layer (the remixclip version of OD's
// ChatRoot.module.css); it must take effect before the component CSS outside globals, so it goes
// first.
import '../src/components/chat/primitives/chat-tokens.css';
import './globals.css';

/*
 * metadata is decided by a server component and, with static export, can only take one fixed
 * value: here it uses the dictionary's canonical locale (zh-CN). The runtime document.title is
 * rewritten by I18nProvider in the current locale —— we won't turn layout into dynamic rendering
 * just for one title line.
 */
export const metadata: Metadata = {
  title: zhCN['app.metadata.title'],
  description: zhCN['app.metadata.description'],
  icons: { icon: '/remixclip-logo.svg' },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // lang keeps its static default value: the language preference is client state
    // (localStorage / system locale), and I18nProvider syncs it once mounted.
    <html lang="zh-CN">
      {/* The Electron shell injects remixclip-electron-macos into body after page load (to hide
          the native title bar styling); this is an intentional client-side difference that React
          does not need to correct during hydration. */}
      <body className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
