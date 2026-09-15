import { cookies } from 'next/headers';
import Sidebar from '@/components/Sidebar';
import { SIDEBAR_COLLAPSED_COOKIE, parseCollapsedSections } from '@/lib/sidebar';
import BalanceBadge from '@/components/BalanceBadge';
import ThemeToggle from '@/components/ThemeToggle';
import UpdateBanner from '@/components/UpdateBanner';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const collapsed = parseCollapsedSections((await cookies()).get(SIDEBAR_COLLAPSED_COOKIE)?.value);

  return (
    <div className="flex h-dvh bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 font-sans">
      <Sidebar initialCollapsed={collapsed} />
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <UpdateBanner />
        <header className="h-14 border-b border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-900 flex items-center justify-end px-6 shrink-0 gap-3">
          <ThemeToggle />
          <BalanceBadge />
        </header>

        <div className="flex-1 overflow-hidden">
          <main className="h-full overflow-y-auto p-8">
            <div className="max-w-6xl mx-auto">
              {children}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
