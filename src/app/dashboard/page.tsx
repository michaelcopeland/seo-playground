export const dynamic = 'force-dynamic';

import { getCredentials } from '@/lib/db';
import { saveCredentialsAction } from './actions';
import Link from 'next/link';
import {
  Activity, TrendingUp, BarChart2, Users, GitMerge, Clock, Lightbulb, Flame,
  Cpu, ShieldCheck, Link2, FolderKanban, Anchor, Globe, MapPin, BrainCircuit,
  Star, Search, Gauge, FileSearch2, Grid3X3,
  Sparkles, Target, Layers, Network, LineChart, Tag,
  History, Copy, BarChart3, BookOpen, Server,
} from 'lucide-react';

const sections = [
  {
    label: 'Analytics',
    color: 'blue',
    items: [
      { name: 'Rank Tracker', href: '/dashboard/rank-tracker', icon: Activity, desc: 'Track keyword positions over time' },
      { name: 'Ranked Keywords', href: '/dashboard/ranked-keywords', icon: TrendingUp, desc: 'Keywords your domain ranks for' },
      { name: 'Keyword Overview', href: '/dashboard/keyword-overview', icon: BarChart2, desc: 'Volume and metrics per keyword' },
      { name: 'Competitors', href: '/dashboard/competitors', icon: Users, desc: 'Competing domain analysis' },
      { name: 'Domain Intersection', href: '/dashboard/domain-intersection', icon: GitMerge, desc: 'Keywords shared between domains' },
      { name: 'Historical Rank', href: '/dashboard/historical-rank', icon: Clock, desc: 'Ranking history over time' },
      { name: 'Related Keywords', href: '/dashboard/related-keywords', icon: Lightbulb, desc: 'Related keyword suggestions' },
      { name: 'Top Searches', href: '/dashboard/top-searches', icon: Flame, desc: 'Local search trends' },
    ],
  },
  {
    label: 'Domain Analytics',
    color: 'violet',
    items: [
      { name: 'Technologies', href: '/dashboard/domain-analytics/technologies', icon: Cpu, desc: 'Tech stack used by domains' },
      { name: 'Whois', href: '/dashboard/domain-analytics/whois', icon: ShieldCheck, desc: 'Domain registration info' },
      { name: 'Categories', href: '/dashboard/domain-analytics/categories', icon: Tag, desc: 'Thematic categories for a domain' },
    ],
  },
  {
    label: 'Labs',
    color: 'indigo',
    items: [
      { name: 'Keyword Ideas', href: '/dashboard/keyword-ideas', icon: Sparkles, desc: 'Keyword ideas from a seed with intent' },
      { name: 'Search Intent', href: '/dashboard/search-intent', icon: Target, desc: 'Classify keywords by search intent' },
      { name: 'Page Intersection', href: '/dashboard/page-intersection', icon: Layers, desc: 'Keywords shared between multiple pages' },
      { name: 'Subdomains', href: '/dashboard/subdomains', icon: Network, desc: 'Subdomains ranked by organic traffic' },
      { name: 'Traffic Estimation', href: '/dashboard/traffic-estimation', icon: LineChart, desc: 'Bulk organic traffic for a domain list' },
    ],
  },
  {
    label: 'Backlinks',
    color: 'emerald',
    items: [
      { name: 'Backlinks', href: '/dashboard/backlinks', icon: Link2, desc: 'Incoming links list' },
      { name: 'Referring Domains', href: '/dashboard/backlinks/referring-domains', icon: FolderKanban, desc: 'Domains linking to you' },
      { name: 'Anchors', href: '/dashboard/backlinks/anchors', icon: Anchor, desc: 'Anchor texts in use' },
      { name: 'Referring Networks', href: '/dashboard/backlinks/referring-networks', icon: Server, desc: 'IP subnets sending backlinks' },
      { name: 'Page Intersection', href: '/dashboard/backlinks/page-intersection', icon: Copy, desc: 'Pages linking to multiple targets' },
      { name: 'Domain Intersection', href: '/dashboard/backlinks/domain-intersection', icon: BookOpen, desc: 'Domains linking to you and a competitor' },
      { name: 'History', href: '/dashboard/backlinks/history', icon: History, desc: 'Backlink evolution over time' },
      { name: 'Bulk Backlinks', href: '/dashboard/backlinks/bulk-backlinks', icon: BarChart3, desc: 'Backlink summary for a domain list' },
      { name: 'Bulk Ref. Domains', href: '/dashboard/backlinks/bulk-referring-domains', icon: Layers, desc: 'Referring domains for a domain list' },
    ],
  },
  {
    label: 'SERP',
    color: 'orange',
    items: [
      { name: 'SERP Checker', href: '/dashboard/serp', icon: Globe, desc: 'Live search results' },
      { name: 'Local Finder', href: '/dashboard/local-finder', icon: MapPin, desc: 'Local pack results for any location' },
      { name: 'Geo-Grid Ranking', href: '/dashboard/geo-grid', icon: Grid3X3, desc: 'Ranking heatmap across a grid of points' },
    ],
  },
  {
    label: 'AI',
    color: 'pink',
    items: [
      { name: 'AI Optimization', href: '/dashboard/ai-optimization', icon: BrainCircuit, desc: 'Visibility in AI-generated answers' },
    ],
  },
  {
    label: 'Business',
    color: 'yellow',
    items: [
      { name: 'Google Reviews', href: '/dashboard/google-reviews', icon: Star, desc: 'Google reviews and rating goals' },
    ],
  },
  {
    label: 'Tools',
    color: 'slate',
    items: [
      { name: 'Keyword Data', href: '/dashboard/keyword-data', icon: Search, desc: 'Raw keyword data lookup' },
      { name: 'Keyword Difficulty', href: '/dashboard/keyword-difficulty', icon: Gauge, desc: 'SEO difficulty score' },
      { name: 'On Page', href: '/dashboard/on-page', icon: FileSearch2, desc: 'Instant page audit' },
    ],
  },
];

const colorMap: Record<string, { badge: string; icon: string; hover: string }> = {
  blue:    { badge: 'bg-blue-50 text-blue-600 dark:bg-blue-950 dark:text-blue-400',    icon: 'text-blue-400',    hover: 'hover:border-blue-200 dark:hover:border-blue-800' },
  violet:  { badge: 'bg-violet-50 text-violet-600 dark:bg-violet-950 dark:text-violet-400', icon: 'text-violet-400', hover: 'hover:border-violet-200 dark:hover:border-violet-800' },
  emerald: { badge: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400', icon: 'text-emerald-400', hover: 'hover:border-emerald-200 dark:hover:border-emerald-800' },
  orange:  { badge: 'bg-orange-50 text-orange-600 dark:bg-orange-950 dark:text-orange-400', icon: 'text-orange-400',  hover: 'hover:border-orange-200 dark:hover:border-orange-800' },
  pink:    { badge: 'bg-pink-50 text-pink-600 dark:bg-pink-950 dark:text-pink-400',    icon: 'text-pink-400',    hover: 'hover:border-pink-200 dark:hover:border-pink-800' },
  yellow:  { badge: 'bg-yellow-50 text-yellow-600 dark:bg-yellow-950 dark:text-yellow-400', icon: 'text-yellow-500',  hover: 'hover:border-yellow-200 dark:hover:border-yellow-800' },
  red:     { badge: 'bg-red-50 text-red-600 dark:bg-red-950 dark:text-red-400',        icon: 'text-red-400',     hover: 'hover:border-red-200 dark:hover:border-red-800' },
  slate:   { badge: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400', icon: 'text-slate-400',   hover: 'hover:border-slate-300 dark:hover:border-slate-600' },
  indigo:  { badge: 'bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-400', icon: 'text-indigo-400', hover: 'hover:border-indigo-200 dark:hover:border-indigo-800' },
};

export default async function DashboardPage() {
  const creds = getCredentials();

  if (!creds) {
    return (
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-800 p-10 max-w-lg mx-auto mt-10">
        <h2 className="text-2xl font-black text-slate-900 dark:text-white mb-2 tracking-tight">DataForSEO Login</h2>
        <p className="text-slate-500 text-sm mb-8">Enter your DataForSEO API credentials to get started. Stored locally only.</p>
        <form action={saveCredentialsAction} className="space-y-4">
          <div>
            <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5">API Login</label>
            <input type="text" name="login" required className="w-full px-4 py-3 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all" />
          </div>
          <div>
            <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5">API Password</label>
            <input type="password" name="password" required className="w-full px-4 py-3 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all" />
          </div>
          <button type="submit" className="w-full bg-blue-600 text-white font-black uppercase text-xs tracking-widest py-3.5 rounded-xl hover:bg-blue-700 transition-colors">
            Save
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white tracking-tight">Dashboard</h1>
        <p className="text-sm text-slate-400 mt-1">Pick a tool to get started.</p>
      </div>

      {sections.map((section) => {
        const c = colorMap[section.color];
        return (
          <div key={section.label}>
            <div className="flex items-center gap-3 mb-4">
              <span className={`text-[9px] font-black uppercase tracking-[0.2em] px-2.5 py-1 rounded-full ${c.badge}`}>
                {section.label}
              </span>
              <div className="h-px flex-1 bg-slate-100 dark:bg-slate-800" />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {section.items.map((item) => {
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`group flex items-start gap-4 p-4 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 transition-all duration-150 ${c.hover} hover:shadow-md`}
                  >
                    <div className={`mt-0.5 shrink-0 ${c.icon}`}>
                      <Icon className="h-5 w-5" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-[11px] font-black uppercase tracking-widest text-slate-900 dark:text-white leading-tight group-hover:text-inherit truncate">
                        {item.name}
                      </p>
                      <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1 leading-snug">
                        {item.desc}
                      </p>
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
