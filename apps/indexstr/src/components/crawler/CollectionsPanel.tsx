/**
 * Collections panel — the heart of Indexstr.
 *
 * Eight curated URL collections ship inside the app as SQLite databases.
 * Loading one parses the database in-browser (no server round-trips beyond
 * the static file), normalizes every URL per SIP-01 §7, dedupes against
 * pages already crawled, and enqueues the result with `followLinks: false`.
 */

import { useEffect, useRef, useState } from 'react';
import {
  Trophy,
  ListChecks,
  Rss,
  Music,
  BookOpen,
  Clapperboard,
  Laugh,
  Gamepad2,
  Download,
  Loader2,
  CheckCircle2,
  Database,
  RefreshCw,
  Play,
  type LucideIcon,
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { useToast } from '@/hooks/useToast';
import {
  COLLECTIONS,
  getCachedCollection,
  getCollectionStates,
  loadCollectionEntries,
  markCollectionLoaded,
  type CollectionState,
  type LoadProgress,
  type UrlCollection,
} from '@/crawler/collections';
import { cn } from '@/lib/utils';

const ICONS: Record<string, LucideIcon> = {
  trophy: Trophy,
  'list-checks': ListChecks,
  rss: Rss,
  music: Music,
  'book-open': BookOpen,
  clapperboard: Clapperboard,
  laugh: Laugh,
  'gamepad-2': Gamepad2,
};

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

interface CardStatus {
  phase: 'idle' | 'loading' | 'done' | 'error';
  label?: string;
  percent?: number;
  urlCount?: number;
  samples?: { url: string; title?: string }[];
}

interface CollectionsPanelProps {
  /** Seed the crawl queue with extracted URLs. Returns jobs added. */
  onSeed: (urls: string[], onProgress?: (done: number, total: number) => void) => Promise<number>;
  /** Whether the crawler engine is ready. */
  ready: boolean;
  /** Whether the crawler is currently running (for the CTA hint). */
  isRunning: boolean;
  /** Start the crawler (used by the post-load CTA). */
  onStart: () => void;
}

export function CollectionsPanel({ onSeed, ready, isRunning, onStart }: CollectionsPanelProps) {
  const { toast } = useToast();
  const [statuses, setStatuses] = useState<Record<string, CardStatus>>({});
  const [states, setStates] = useState<Record<string, CollectionState>>({});
  const [knownCounts, setKnownCounts] = useState<Record<string, number>>({});
  const busyRef = useRef(false);

  // Hydrate persisted load state + cached counts (survives reloads).
  useEffect(() => {
    setStates(getCollectionStates());
    let cancelled = false;
    (async () => {
      const counts: Record<string, number> = {};
      await Promise.all(
        COLLECTIONS.map(async (c) => {
          const cached = await getCachedCollection(c.id);
          if (cached) counts[c.id] = cached.urls.length;
        }),
      );
      if (!cancelled) setKnownCounts(counts);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleLoad = async (collection: UrlCollection) => {
    if (busyRef.current || !ready) return;
    busyRef.current = true;

    const setStatus = (patch: Partial<CardStatus>) =>
      setStatuses((prev) => {
        const current: CardStatus = prev[collection.id] ?? { phase: 'idle' };
        return { ...prev, [collection.id]: { ...current, ...patch } };
      });

    setStatus({ phase: 'loading', label: 'Starting…', percent: 0 });

    try {
      const entries = await loadCollectionEntries(
        collection,
        (progress: LoadProgress) => {
          if (progress.stage === 'downloading') {
            const percent = progress.total > 0 ? Math.round((progress.loaded / progress.total) * 100) : undefined;
            setStatus({ label: `Downloading ${formatBytes(progress.loaded)}`, percent });
          } else if (progress.stage === 'parsing') {
            const percent = progress.totalPages > 0 ? Math.min(99, Math.round((progress.pages / progress.totalPages) * 100)) : undefined;
            setStatus({ label: `Extracting URLs (${progress.pages.toLocaleString()} pages)`, percent });
          } else {
            setStatus({ label: 'Loaded from local cache', percent: 100 });
          }
        },
      );

      if (entries.urls.length === 0) {
        setStatuses((prev) => ({
          ...prev,
          [collection.id]: { phase: 'error', label: 'No usable URLs found in this collection.' },
        }));
        return;
      }

      setStatus({ label: `Queueing ${entries.urls.length.toLocaleString()} URLs…` });
      const queued = await onSeed(entries.urls, (done, total) => {
        setStatus({
          label: `Queueing ${done.toLocaleString()} / ${total.toLocaleString()}`,
          percent: Math.round((done / Math.max(1, total)) * 100),
        });
      });

      setKnownCounts((prev) => ({ ...prev, [collection.id]: entries.urls.length }));
      setStates(markCollectionLoaded(collection.id, queued));
      setStatuses((prev) => ({
        ...prev,
        [collection.id]: { phase: 'done', urlCount: entries.urls.length, samples: entries.samples },
      }));

      toast({
        title: `${collection.name} loaded`,
        description: `${queued.toLocaleString()} new URLs queued (${(entries.urls.length - queued).toLocaleString()} already indexed).`,
      });
    } catch (error) {
      console.error('[Collections] Load failed:', error);
      setStatuses((prev) => ({
        ...prev,
        [collection.id]: {
          phase: 'error',
          label: error instanceof Error ? error.message : 'Failed to load collection.',
        },
      }));
      toast({
        title: `Couldn't load ${collection.name}`,
        description: 'The collection database failed to download or parse.',
        variant: 'destructive',
      });
    } finally {
      busyRef.current = false;
    }
  };

  const anyLoading = Object.values(statuses).some((s) => s.phase === 'loading');

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Bundled URL Collections</CardTitle>
        <CardDescription>
          Curated link packs built into Indexstr. Load one into your queue and every URL gets
          crawled, hashed, and published to the shared SIP-01 index — no hunting for seeds.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {COLLECTIONS.map((collection) => {
            const Icon = ICONS[collection.icon] ?? Database;
            const status = statuses[collection.id];
            const state = states[collection.id];
            const count = status?.urlCount ?? knownCounts[collection.id] ?? state?.queued;
            const loading = status?.phase === 'loading';
            const done = status?.phase === 'done' || (!loading && state);

            return (
              <div
                key={collection.id}
                className={cn(
                  'rounded-lg border p-4 space-y-3 transition-colors',
                  done ? 'border-primary/40 bg-primary/5' : 'bg-card',
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="p-2 rounded-lg bg-primary/10 text-primary shrink-0">
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="min-w-0">
                      <p className="font-semibold text-sm truncate">{collection.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {count !== undefined
                          ? `${count.toLocaleString()} URLs`
                          : formatBytes(collection.sizeBytes)}
                      </p>
                    </div>
                  </div>
                  {done && !loading && (
                    <Badge variant="outline" className="text-primary border-primary/40 shrink-0">
                      <CheckCircle2 className="h-3 w-3 mr-1" />
                      Queued
                    </Badge>
                  )}
                </div>

                <p className="text-xs text-muted-foreground leading-relaxed">
                  {collection.description}
                </p>

                {/* A taste of what's inside, once we know */}
                {status?.samples && status.samples.length > 0 && (
                  <div className="rounded-md bg-muted/60 px-2.5 py-2 space-y-0.5">
                    {status.samples.slice(0, 3).map((sample) => (
                      <p key={sample.url} className="text-[11px] text-muted-foreground font-mono truncate">
                        {sample.title ?? sample.url}
                      </p>
                    ))}
                  </div>
                )}

                {loading && (
                  <div className="space-y-1.5">
                    <Progress value={status.percent} className="h-1.5" />
                    <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                      <Loader2 className="h-3 w-3 motion-safe:animate-spin" />
                      {status.label}
                    </p>
                  </div>
                )}

                {status?.phase === 'error' && (
                  <p className="text-xs text-destructive">{status.label}</p>
                )}

                <Button
                  size="sm"
                  variant={done ? 'outline' : 'default'}
                  className="w-full gap-1.5"
                  disabled={!ready || loading || anyLoading}
                  onClick={() => handleLoad(collection)}
                >
                  {loading ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" />
                      Loading…
                    </>
                  ) : done ? (
                    <>
                      <RefreshCw className="h-3.5 w-3.5" />
                      Reload
                    </>
                  ) : (
                    <>
                      <Download className="h-3.5 w-3.5" />
                      Load into queue
                    </>
                  )}
                </Button>
              </div>
            );
          })}
        </div>

        {/* Post-load call to action */}
        {Object.keys(states).length > 0 && !isRunning && (
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 rounded-lg border border-primary/40 bg-primary/5 px-4 py-3">
            <p className="text-sm">
              <span className="font-medium">Collections queued.</span>{' '}
              <span className="text-muted-foreground">
                Start the crawler to begin publishing observations.
              </span>
            </p>
            <Button size="sm" className="gap-1.5 shrink-0" onClick={onStart} disabled={!ready}>
              <Play className="h-3.5 w-3.5" />
              Start Crawling
            </Button>
          </div>
        )}

        <p className="text-xs text-muted-foreground leading-relaxed">
          Collection URLs are indexed exactly as listed — the crawler does not follow links
          from them. Already-indexed URLs are skipped automatically, and the queue survives
          browser restarts. Large collections take days to work through at a respectful
          per-domain pace; that is the point: slow, opt-in, unstoppable.
        </p>
      </CardContent>
    </Card>
  );
}
