import { useSeoMeta } from '@unhead/react';
import { Radar, Globe, Shield, Users, LibraryBig } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { CrawlerDashboard } from '@/components/crawler/CrawlerDashboard';
import { IndexstrLogo } from '@/components/crawler/IndexstrLogo';
import { ThemeToggle } from '@/components/ThemeToggle';
import { LoginArea } from '@/components/auth/LoginArea';

const Index = () => {
  useSeoMeta({
    title: 'Indexstr — The Web, Pre-Indexed on Nostr',
    description: 'A decentralized browser crawler that ships with curated URL collections. Turn your browser into a voluntary crawl node feeding the shared SIP-01 search index on Nostr.',
  });

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b sticky top-0 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 z-50">
        <div className="container max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <IndexstrLogo className="h-8 w-8 shrink-0 rounded-md" />
            <span className="font-bold text-lg tracking-tight">Indexstr</span>
            <span className="text-xs text-muted-foreground hidden sm:inline">
              Curated Web Indexer
            </span>
          </div>
          <div className="flex items-center gap-1">
            <ThemeToggle />
            <LoginArea className="max-w-60" />
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative isolate container max-w-6xl mx-auto px-4 pt-12 pb-8">
        {/* Soft brand glow behind the hero */}
        <div
          aria-hidden
          className="absolute inset-x-0 top-0 -z-10 h-64 bg-[radial-gradient(ellipse_at_top,var(--color-primary)/0.18,transparent_70%)]"
        />

        <div className="text-center space-y-4 max-w-2xl mx-auto">
          <IndexstrLogo className="h-24 w-24 mx-auto rounded-2xl shadow-lg motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95 motion-safe:duration-500" />

          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 text-primary text-sm font-medium">
            <Globe className="h-3.5 w-3.5" />
            Powered by Nostr · SIP-01
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight">
            The web, pre-indexed by everyone.
          </h1>
          <p className="text-lg text-muted-foreground max-w-xl mx-auto">
            Indexstr ships with curated URL collections — top sites, awesome
            lists, feeds, music, books, movies, memes and games. Load a pack,
            press start, and your browser indexes every page into the shared
            SIP-01 index on Nostr.
          </p>
        </div>
      </section>

      {/* Features */}
      <section className="container max-w-6xl mx-auto px-4 pb-8">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-3xl mx-auto">
          <div className="flex items-center gap-3 p-4 rounded-lg border bg-card">
            <LibraryBig className="h-8 w-8 text-primary shrink-0" />
            <div>
              <h3 className="font-semibold text-sm">8 Curated Collections</h3>
              <p className="text-xs text-muted-foreground">
                Thousands of URLs bundled, ready to index
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 p-4 rounded-lg border bg-card">
            <Shield className="h-8 w-8 text-primary shrink-0" />
            <div>
              <h3 className="font-semibold text-sm">Opt-in Only</h3>
              <p className="text-xs text-muted-foreground">
                Nothing runs without your explicit consent
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 p-4 rounded-lg border bg-card">
            <Users className="h-8 w-8 text-primary shrink-0" />
            <div>
              <h3 className="font-semibold text-sm">SIP-01 Compatible</h3>
              <p className="text-xs text-muted-foreground">
                Same protocol as 0xSearchstr, Presearchstr, UNCAGED
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Crawler Dashboard */}
      <section className="container max-w-6xl mx-auto px-4 pb-16">
        <CrawlerDashboard />
      </section>

      {/* How it works */}
      <section className="border-t bg-muted/30">
        <div className="container max-w-6xl mx-auto px-4 py-16">
          <div className="text-center space-y-4 mb-12">
            <h2 className="text-3xl font-bold">How It Works</h2>
            <p className="text-muted-foreground max-w-lg mx-auto">
              Every browser that opts in becomes a node in the decentralized crawl network.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-6 max-w-4xl mx-auto">
            {[
              {
                step: '1',
                icon: LibraryBig,
                title: 'Load a Collection',
                desc: 'Pick a curated URL pack — or seed your own URLs manually',
              },
              {
                step: '2',
                icon: Radar,
                title: 'Crawl',
                desc: 'Your browser fetches pages, extracts content, respects robots.txt',
              },
              {
                step: '3',
                icon: Shield,
                title: 'Hash & Dedupe',
                desc: 'Content is hashed with SHA-256 to detect duplicates across the network',
              },
              {
                step: '4',
                icon: Globe,
                title: 'Publish',
                desc: 'Kind 39697 SIP-01 observations signed by your device indexer key',
              },
            ].map(({ step, icon: Icon, title, desc }) => (
              <div key={step} className="text-center space-y-3">
                <div className="mx-auto w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
                  <Icon className="h-5 w-5 text-primary" />
                </div>
                <div className="text-xs font-bold text-primary">STEP {step}</div>
                <h3 className="font-semibold">{title}</h3>
                <p className="text-sm text-muted-foreground">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Architecture */}
      <section className="border-t">
        <div className="container max-w-6xl mx-auto px-4 py-16">
          <div className="max-w-3xl mx-auto">
            <h2 className="text-3xl font-bold text-center mb-8">Architecture</h2>
            <Card>
              <CardContent className="pt-6">
                <pre className="text-xs sm:text-sm font-mono text-muted-foreground overflow-x-auto whitespace-pre">
{`┌──────────────────────────┐
 │       INDEXSTR PWA       │
 │  (this app — you are     │
 │   the indexer)           │
 └───────────┬──────────────┘
             │
   ┌─────────▼─────────┐
   │  URL COLLECTIONS  │
   │  top · awesome ·  │
   │  feeds · music ·  │
   │  books · movies · │
   │  memes · games    │
   └─────────┬─────────┘
             │
   ┌─────────▼─────────┐
   │  CRAWLER ENGINE   │
   │  Queue → Fetch    │
   │   → Parse → Hash  │
   │   → SIP-01 Sign   │
   │   → Publish       │
   └─────────┬─────────┘
             │
       ┌─────▼─────┐
       │   NOSTR   │
       │  RELAYS   │
       │           │
       │ kind 39697│
       │ (SIP-01)  │
       └─────┬─────┘
             │
    ┌────────┼────────┐
    ▼        ▼        ▼
 0xSearchstr 0xPre-  UNCAGED
             searchstr
    │        │        │
    └────────┼────────┘
             │
      ┌──────▼──────┐
      │  Any SIP-01  │
      │  compatible  │
      │  search node │
      └──────┬──────┘
             │
       SEARCH RESULTS`}
                </pre>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t">
        <div className="container max-w-6xl mx-auto px-4 py-8">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <IndexstrLogo className="h-5 w-5 shrink-0 rounded" />
              <span>Indexstr — the web, pre-indexed on Nostr. A Crawlstr fork.</span>
            </div>
            <div className="flex items-center gap-4 text-sm text-muted-foreground">
              <span>No tracking</span>
              <span>·</span>
              <span>No analytics</span>
              <span>·</span>
              <span>Open source</span>
            </div>
          </div>
          <div className="mt-4 text-center">
            <a
              href="https://shakespeare.diy"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-muted-foreground hover:text-primary transition-colors"
            >
              Vibed with Shakespeare
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default Index;
