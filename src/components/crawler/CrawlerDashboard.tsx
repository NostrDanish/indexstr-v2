import { useState } from 'react';
import {
  Play,
  Square,
  Plus,
  Trash2,
  Globe,
  Clock,
  Database,
  Zap,
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Settings2,
  Wifi,
  BatteryCharging,
  Shield,
  Key,
  Copy,
  Check,
  Users,
  Send,
  Rss,
  Map,
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { IndexstrLogo } from '@/components/crawler/IndexstrLogo';
import { CollectionsPanel } from '@/components/crawler/CollectionsPanel';
import { RelayManager } from '@/components/crawler/RelayManager';
import { useCrawler } from '@/hooks/useCrawler';
import { useNetworkNodes } from '@/hooks/useNetworkNodes';
import { exportIndexerNsec } from '@sip01/protocol';
import { cn } from '@/lib/utils';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

/**
 * Seeds that are actually crawlable from a browser: open content, permissive
 * robots.txt, server-rendered HTML. Big platforms disallow crawling, so seeding
 * them produces an empty index and looks like a broken app.
 */
const SUGGESTED_SEEDS = [
  'https://en.wikipedia.org/wiki/Nostr',
  'https://bitcoin.org',
  'https://nostr.com',
  'https://news.ycombinator.com',
  'https://dev.to',
];

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${seconds % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function CrawlerDashboard() {
  const {
    isRunning,
    initialized,
    stats,
    recentCrawls,
    indexerInfo,
    homeShardLabel,
    capabilities,
    settings,
    start,
    stop,
    seedUrl,
    seedCollection,
    clearAll,
    updateSettings,
    probeRelay,
  } = useCrawler();

  const network = useNetworkNodes(initialized);

  const [seedInput, setSeedInput] = useState('');
  const [copied, setCopied] = useState(false);

  const changeSettings = (patch: Parameters<typeof updateSettings>[0]) => {
    updateSettings(patch);
  };

  const handleSeed = () => {
    if (!seedInput.trim()) return;
    let url = seedInput.trim();
    if (!url.startsWith('http')) {
      url = `https://${url}`;
    }
    seedUrl(url);
    setSeedInput('');
  };

  const copyNpub = () => {
    if (!indexerInfo) return;
    navigator.clipboard.writeText(indexerInfo.npub);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="w-full max-w-4xl mx-auto space-y-6">
      {/* Main Toggle Card */}
      <Card className={cn(
        'border-2 transition-colors duration-300',
        isRunning ? 'border-primary/50 bg-primary/5' : 'border-border'
      )}>
        <CardHeader className="pb-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={cn(
                'p-2.5 rounded-xl transition-colors',
                isRunning ? 'bg-primary/15' : 'bg-muted'
              )}>
                <IndexstrLogo
                  animated={isRunning}
                  className={cn(
                    'h-7 w-7 rounded-md',
                    !isRunning && 'opacity-60 grayscale',
                  )}
                />
              </div>
              <div>
                <CardTitle className="text-xl">
                  {isRunning ? 'Crawler Active' : 'Crawler Offline'}
                </CardTitle>
                <CardDescription>
                  {isRunning
                    ? 'Your browser is contributing to the shared SIP-01 index'
                    : 'Enable to start crawling and indexing the web'}
                </CardDescription>
              </div>
            </div>
            <Button
              size="lg"
              variant={isRunning ? 'destructive' : 'default'}
              onClick={isRunning ? stop : start}
              disabled={!initialized}
              className="gap-2 px-6"
            >
              {isRunning ? (
                <>
                  <Square className="h-4 w-4" />
                  Stop
                </>
              ) : (
                <>
                  <Play className="h-4 w-4" />
                  Start Crawling
                </>
              )}
            </Button>
          </div>
        </CardHeader>

        {/* Live status indicator */}
        {isRunning && (
          <CardContent className="pt-0">
            <div className="flex items-center gap-2 text-sm text-primary">
              <span className="relative flex h-2.5 w-2.5">
                <span className="motion-safe:animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-primary" />
              </span>
              Crawling... Uptime: {formatUptime(stats.uptime)}
            </div>
          </CardContent>
        )}
      </Card>

      {/* Why pages were skipped — otherwise "0 indexed" looks like a broken app */}
      {(stats.skipped > 0 || stats.fetchFailed > 0 || stats.intakeRejected > 0) && (
        <Card className="border-chart-4/40 bg-chart-4/5">
          <CardContent className="pt-6 space-y-3">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-chart-4 shrink-0" />
              <p className="text-sm font-medium">
                Why pages weren't indexed
              </p>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
              <div>
                <div className="font-bold">{stats.robotsBlocked.toLocaleString()}</div>
                <div className="text-xs text-muted-foreground">robots.txt disallowed</div>
              </div>
              <div>
                <div className="font-bold">{stats.fetchFailed.toLocaleString()}</div>
                <div className="text-xs text-muted-foreground">unreachable</div>
              </div>
              <div>
                <div className="font-bold">{stats.thinContent.toLocaleString()}</div>
                <div className="text-xs text-muted-foreground">too little text</div>
              </div>
              <div>
                <div className="font-bold">{stats.duplicates.toLocaleString()}</div>
                <div className="text-xs text-muted-foreground">duplicate content</div>
              </div>
            </div>

            {/* Abuse-guard telemetry (only shown once the guards have fired) */}
            {(stats.trapsBlocked > 0 || stats.ssrfBlocked > 0 || stats.intakeRejected > 0) && (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm border-t border-chart-4/20 pt-3">
                <div>
                  <div className="font-bold">{stats.trapsBlocked.toLocaleString()}</div>
                  <div className="text-xs text-muted-foreground">crawl traps rejected</div>
                </div>
                <div>
                  <div className="font-bold">{stats.ssrfBlocked.toLocaleString()}</div>
                  <div className="text-xs text-muted-foreground">private hosts refused</div>
                </div>
                <div>
                  <div className="font-bold">{stats.intakeRejected.toLocaleString()}</div>
                  <div className="text-xs text-muted-foreground">intake rejected (spam guards)</div>
                </div>
              </div>
            )}

            {stats.robotsBlocked > 0 && stats.pagesIndexed === 0 && (
              <p className="text-xs text-muted-foreground">
                Most large platforms (Google, YouTube, Facebook, X) disallow
                crawling in their robots.txt, so they're skipped by design. Try a
                crawler-friendly seed from the Seed URLs tab.
              </p>
            )}

            {stats.thinContent > 0 && (
              <p className="text-xs text-muted-foreground">
                Pages with little text are usually JavaScript-rendered apps —
                Indexstr parses static HTML only.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Indexstr Node Card — identity, shard, capabilities, network view */}
      {indexerInfo && (
        <Card>
          <CardContent className="pt-6 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3 min-w-0">
                <div className="p-2 rounded-lg bg-primary/10 text-primary shrink-0">
                  <Key className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium">Indexstr Node</p>
                  <p className="text-xs text-muted-foreground font-mono truncate">
                    {indexerInfo.npub}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {homeShardLabel && (
                  <Badge variant="outline" className="font-mono text-primary border-primary/40">
                    Shard {homeShardLabel}
                  </Badge>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={copyNpub}
                >
                  {copied ? <Check className="h-4 w-4 text-primary" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </div>

            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {capabilities && (
                <span>
                  {capabilities.platform}
                  {' · '}
                  {capabilities.network}
                  {capabilities.charging ? ' · charging' : ''}
                </span>
              )}
              <span>
                home queue: {stats.homeShardJobs.toLocaleString()} URL
                {stats.homeShardJobs !== 1 ? 's' : ''}
              </span>
              {stats.networkIntake > 0 && (
                <span>
                  network discoveries: {stats.networkIntake.toLocaleString()}
                </span>
              )}
              {(stats.feedsFound > 0 || stats.sitemapsFound > 0) && (
                <span>
                  feeds: {stats.feedsFound.toLocaleString()} · sitemaps:{' '}
                  {stats.sitemapsFound.toLocaleString()}
                </span>
              )}
              {stats.outboxPending > 0 && (
                <span className="text-chart-4">
                  {stats.outboxPending.toLocaleString()} observation
                  {stats.outboxPending !== 1 ? 's' : ''} held for relay reconnect
                </span>
              )}
            </div>

            <p className="text-xs text-muted-foreground">
              Per-device pseudonymous keypair signs kind 39697 observations — separate from your
              personal Nostr identity. Your home shard is derived from it, so the network splits
              crawl work deterministically with no coordinator.
            </p>

            {network.data && network.data.activeIndexers > 0 && (
              <div className="flex items-center gap-2 rounded-lg bg-primary/5 border border-primary/20 px-3 py-2">
                <Users className="h-3.5 w-3.5 text-primary shrink-0" />
                <p className="text-xs">
                  <span className="font-medium text-primary">
                    {network.data.activeIndexers} active indexer
                    {network.data.activeIndexers !== 1 ? 's' : ''}
                  </span>{' '}
                  <span className="text-muted-foreground">
                    across {network.data.activeShards}/256 shards — local estimate from your relays
                    (1h window)
                  </span>
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Stats Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Database className="h-4 w-4" />
              <span className="text-xs font-medium">Indexed</span>
            </div>
            <div className="text-2xl font-bold">{stats.pagesIndexed.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground">pages</p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Clock className="h-4 w-4" />
              <span className="text-xs font-medium">Queue</span>
            </div>
            <div className="text-2xl font-bold">{stats.queueSize.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground">pending</p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Send className="h-4 w-4" />
              <span className="text-xs font-medium">Published</span>
            </div>
            <div className="text-2xl font-bold">{stats.published.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground">
              observations{stats.outboxPending > 0 ? ` · ${stats.outboxPending} held` : ''}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Zap className="h-4 w-4" />
              <span className="text-xs font-medium">Bandwidth</span>
            </div>
            <div className="text-2xl font-bold">{formatBytes(stats.bandwidthUsed)}</div>
            <p className="text-xs text-muted-foreground">used</p>
          </CardContent>
        </Card>
      </div>

      {/* Tabs for Collections / Seed / History / Settings */}
      <Tabs defaultValue="collections" className="w-full">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="collections">
            <Database className="h-4 w-4 mr-1 hidden sm:inline" />
            Collections
          </TabsTrigger>
          <TabsTrigger value="seed">Seed URLs</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
          <TabsTrigger value="settings">
            <Settings2 className="h-4 w-4 mr-1 hidden sm:inline" />
            Settings
          </TabsTrigger>
        </TabsList>

        {/* Collections Tab — bundled curated URL packs */}
        <TabsContent value="collections">
          <CollectionsPanel
            onSeed={seedCollection}
            ready={initialized}
            isRunning={isRunning}
            onStart={start}
          />
        </TabsContent>

        {/* Seed URL Tab */}
        <TabsContent value="seed">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Add URLs to Crawl</CardTitle>
              <CardDescription>
                Enter a URL to start crawling. Pages are published as SIP-01 observations
                (kind 39697) readable by 0xSearchstr, 0xPresearchstr, UNCAGED, and any compatible client.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Input
                  placeholder="https://example.com"
                  value={seedInput}
                  onChange={(e) => setSeedInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSeed()}
                  className="flex-1"
                />
                <Button onClick={handleSeed} disabled={!seedInput.trim()}>
                  <Plus className="h-4 w-4 mr-1" />
                  Add
                </Button>
              </div>

              {/* Crawler-friendly starting points */}
              <div className="rounded-lg border border-dashed p-3 space-y-2">
                <p className="text-xs font-medium text-muted-foreground">
                  Crawler-friendly seeds (open content, permissive robots.txt)
                </p>
                <div className="flex flex-wrap gap-2">
                  {SUGGESTED_SEEDS.map((url) => (
                    <Button
                      key={url}
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs font-mono"
                      onClick={() => seedUrl(url)}
                    >
                      <Plus className="h-3 w-3 mr-1" />
                      {url.replace('https://', '')}
                    </Button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  Large platforms (Google, YouTube, Facebook, X) disallow crawling
                  in robots.txt and are skipped by design.
                </p>
              </div>

              <Separator />

              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                  {stats.queueSize} URL{stats.queueSize !== 1 ? 's' : ''} in queue
                </p>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="outline" size="sm" className="text-destructive">
                      <Trash2 className="h-4 w-4 mr-1" />
                      Clear Queue
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Clear crawl queue?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This will remove all {stats.queueSize} pending URLs from the queue.
                        Already crawled pages will remain in the index.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={clearAll}>Clear Queue</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* History Tab */}
        <TabsContent value="history">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Recently Crawled</CardTitle>
              <CardDescription>
                Pages indexed by this browser, published as SIP-01 observations
              </CardDescription>
            </CardHeader>
            <CardContent>
              {recentCrawls.length === 0 ? (
                <div className="py-12 text-center text-muted-foreground">
                  <Globe className="h-12 w-12 mx-auto mb-4 opacity-20" />
                  <p>No pages crawled yet.</p>
                  <p className="text-sm mt-1">Add a seed URL and start the crawler.</p>
                </div>
              ) : (
                <ScrollArea className="h-[400px]">
                  <div className="space-y-3">
                    {recentCrawls.map((page) => (
                      <div
                        key={page.url}
                        className="flex items-start gap-3 p-3 rounded-lg border bg-card hover:bg-accent/50 transition-colors"
                      >
                        <CheckCircle2 className="h-4 w-4 text-primary mt-1 shrink-0" />
                        <div className="min-w-0 flex-1">
                          <p className="font-medium text-sm truncate">
                            {page.title || 'Untitled'}
                          </p>
                          <a
                            href={page.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1 mt-0.5"
                          >
                            <span className="truncate">{page.url}</span>
                            <ExternalLink className="h-3 w-3 shrink-0" />
                          </a>
                          <div className="flex flex-wrap items-center gap-1.5 mt-1">
                            <p className="text-xs text-muted-foreground">
                              {new Date(page.crawledAt).toLocaleString()}
                            </p>
                            <Badge variant="outline" className="text-xs">
                              kind 39697
                            </Badge>
                            {page.topics?.slice(0, 3).map((topic) => (
                              <Badge key={topic} variant="secondary" className="text-xs">
                                {topic}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Settings Tab */}
        <TabsContent value="settings">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Crawler Settings</CardTitle>
              <CardDescription>
                Control how the crawler behaves. Nothing runs unless you explicitly enable it.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Wifi className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <Label htmlFor="wifi-only">WiFi Only</Label>
                      <p className="text-xs text-muted-foreground">Only crawl on WiFi networks</p>
                    </div>
                  </div>
                  <Switch
                    id="wifi-only"
                    checked={settings.wifiOnly}
                    onCheckedChange={(v) => changeSettings({ wifiOnly: v })}
                  />
                </div>

                <Separator />

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <BatteryCharging className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <Label htmlFor="charging-only">Charging Only</Label>
                      <p className="text-xs text-muted-foreground">Only crawl while device is charging</p>
                    </div>
                  </div>
                  <Switch
                    id="charging-only"
                    checked={settings.chargingOnly}
                    onCheckedChange={(v) => changeSettings({ chargingOnly: v })}
                  />
                </div>

                <Separator />

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Shield className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <Label htmlFor="respect-robots">Respect robots.txt</Label>
                      <p className="text-xs text-muted-foreground">Follow website crawling policies</p>
                    </div>
                  </div>
                  <Switch
                    id="respect-robots"
                    checked={settings.respectRobots}
                    onCheckedChange={(v) => changeSettings({ respectRobots: v })}
                  />
                </div>

                <Separator />

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Zap className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <Label htmlFor="eco-mode">Eco Mode</Label>
                      <p className="text-xs text-muted-foreground">Slower crawling, less resource usage</p>
                    </div>
                  </div>
                  <Switch
                    id="eco-mode"
                    checked={settings.ecoMode}
                    onCheckedChange={(v) => changeSettings({ ecoMode: v })}
                  />
                </div>

                <Separator />

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Rss className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <Label htmlFor="follow-feeds">Follow RSS/Atom feeds</Label>
                      <p className="text-xs text-muted-foreground">Index feed entries — cheap, high-quality discovery</p>
                    </div>
                  </div>
                  <Switch
                    id="follow-feeds"
                    checked={settings.followFeeds}
                    onCheckedChange={(v) => changeSettings({ followFeeds: v })}
                  />
                </div>

                <Separator />

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Map className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <Label htmlFor="follow-sitemaps">Read sitemaps</Label>
                      <p className="text-xs text-muted-foreground">Use sitemap.xml for discovery (sampled, bounded)</p>
                    </div>
                  </div>
                  <Switch
                    id="follow-sitemaps"
                    checked={settings.followSitemaps}
                    onCheckedChange={(v) => changeSettings({ followSitemaps: v })}
                  />
                </div>

                <Separator />

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Database className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <Label htmlFor="bandwidth-cap">Session Bandwidth Cap</Label>
                      <p className="text-xs text-muted-foreground">
                        Crawling pauses after this much data — or pick Unlimited and it just runs
                      </p>
                    </div>
                  </div>
                  <Select
                    value={String(settings.maxBandwidthMB)}
                    onValueChange={(v) => changeSettings({ maxBandwidthMB: Number(v) })}
                  >
                    <SelectTrigger id="bandwidth-cap" className="w-28">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="25">25 MB</SelectItem>
                      <SelectItem value="100">100 MB</SelectItem>
                      <SelectItem value="250">250 MB</SelectItem>
                      <SelectItem value="1000">1 GB</SelectItem>
                      <SelectItem value="0">Unlimited</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <Separator />

                {/* Relay pool: built-ins + user customs, NIP-11 probing,
                    NIP-66 discovery. Pool changes apply on the next crawler
                    node creation (settings change / reload). */}
                <RelayManager probeRelay={probeRelay} />
              </div>

              <Separator />

              {/* Indexer identity export — deliberately frictionful: this
                  nsec controls the node. Anyone holding it can publish as
                  this node. */}
              <IndexerIdentityExport />

              <Separator />

              <div className="rounded-lg bg-muted/50 p-4 space-y-2">
                <h4 className="font-medium text-sm flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-chart-4" />
                  Privacy & Trust
                </h4>
                <ul className="text-sm text-muted-foreground space-y-1">
                  <li className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="text-xs">No tracking</Badge>
                    <Badge variant="outline" className="text-xs">No analytics</Badge>
                    <Badge variant="outline" className="text-xs">SIP-01</Badge>
                    <Badge variant="outline" className="text-xs">kind 39697</Badge>
                  </li>
                  <li>The crawler only runs when you explicitly enable it.</li>
                  <li>
                    Observations are signed by a per-device indexer key
                    ({indexerInfo ? indexerInfo.npub.slice(0, 16) + '...' : 'generating...'}),
                    never your personal Nostr identity.
                  </li>
                  <li>Events contain page metadata only — never search queries.</li>
                  <li>Your crawl history stays in your browser (IndexedDB).</li>
                  <li>
                    <span className="text-chart-4 font-medium">
                      Most sites block direct browser access (CORS).
                    </span>{' '}
                    Those requests are routed through a CORS proxy, so the proxy
                    operator can see which URLs are fetched. Pages fetched this
                    session: {stats.viaDirect} direct, {stats.viaProxy} via proxy.
                  </li>
                  <li>
                    Compatible with{' '}
                    <a href="https://github.com/NostrDanish/0xSearchstr" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">0xSearchstr</a>,{' '}
                    <a href="https://github.com/NostrDanish/0xPresearchstr" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">0xPresearchstr</a>, and{' '}
                    <a href="https://github.com/NostrDanish/UNCAGED-ENGINE" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">UNCAGED</a>.
                  </li>
                </ul>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * Indexer identity export — the nsec that signs this node's observations.
 * Deliberately frictionful (confirm dialog, reveal-once) per audit guidance:
 * the secret lives in localStorage, so it should only surface on purpose.
 */
function IndexerIdentityExport() {
  const [open, setOpen] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [copiedNsec, setCopiedNsec] = useState(false);

  const handleConfirm = () => {
    setRevealed(exportIndexerNsec());
  };

  const handleClose = () => {
    setOpen(false);
    setRevealed(null); // never linger in UI state
    setCopiedNsec(false);
  };

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2 min-w-0">
        <Key className="h-4 w-4 text-muted-foreground shrink-0" />
        <div>
          <p className="text-sm font-medium leading-none">Node identity</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Per-device anonymous keypair. Export to migrate this node to another browser.
          </p>
        </div>
      </div>

      <AlertDialog open={open} onOpenChange={(v) => (v ? setOpen(true) : handleClose())}>
        <AlertDialogTrigger asChild>
          <Button variant="outline" size="sm" className="shrink-0">Export</Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Export node identity?</AlertDialogTitle>
            <AlertDialogDescription>
              This nsec controls your Indexstr node identity. Anyone holding it can publish
              observations as your node. Never paste it into websites, chats, or screenshots.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {revealed && (
            <div className="space-y-2">
              <div className="rounded-md bg-muted p-3 font-mono text-xs break-all select-all">
                {revealed}
              </div>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => {
                  navigator.clipboard.writeText(revealed);
                  setCopiedNsec(true);
                  setTimeout(() => setCopiedNsec(false), 2000);
                }}
              >
                {copiedNsec ? <Check className="h-3.5 w-3.5 text-primary" /> : <Copy className="h-3.5 w-3.5" />}
                {copiedNsec ? 'Copied' : 'Copy nsec'}
              </Button>
            </div>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleClose}>Close</AlertDialogCancel>
            {!revealed && (
              <AlertDialogAction onClick={handleConfirm}>
                Reveal my node key
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
