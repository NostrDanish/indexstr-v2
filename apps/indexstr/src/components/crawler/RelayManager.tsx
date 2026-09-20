/**
 * Relay manager — the Indexstr publish/read pool, user-extensible.
 *
 * Same proven design as Crawlstr's RelayManager: built-ins listed flat with
 * a per-relay NIP-11 probe (latency + SIP-01/NIP-50 badges), custom relays
 * removable, inline add with validation errors, and NIP-66 auto-discovery
 * with probe verification. Built-ins can't be removed — they keep every
 * node functional; customs persist in localStorage on this device.
 */

import { useState } from 'react';
import {
  Globe,
  Plus,
  Trash2,
  RefreshCw,
  Radar,
  CheckCircle2,
  XCircle,
  Loader2,
  Search,
} from 'lucide-react';
import type { RelayCapabilities } from '@sip01/crawler-core';
import { refreshDiscoveredRelays } from '@sip01/protocol';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  getBuiltinRelays,
  getCustomRelays,
  addCustomRelay,
  removeCustomRelay,
  normalizeRelayUrl,
} from '@/lib/indexRelays';
import { cn } from '@/lib/utils';

function CapabilityBadges({ caps }: { caps: RelayCapabilities | undefined }) {
  if (!caps) return null;
  if (!caps.online) {
    return <Badge variant="outline" className="text-xs text-muted-foreground">offline</Badge>;
  }
  return (
    <>
      {caps.sip01 && (
        <Badge className="text-xs bg-primary/15 text-primary border-primary/30">SIP-01</Badge>
      )}
      {caps.nip50 && (
        <Badge variant="outline" className="text-xs">NIP-50</Badge>
      )}
      {caps.latencyMs > 0 && (
        <span className="text-xs text-muted-foreground">{caps.latencyMs}ms</span>
      )}
    </>
  );
}

interface RelayManagerProps {
  /**
   * NIP-11 probe through the crawler node's guarded choke point (injected
   * by the dashboard — the core owns the probe so a "relay" URL pointing
   * at a private host causes zero requests).
   */
  probeRelay: (url: string) => Promise<RelayCapabilities>;
}

export function RelayManager({ probeRelay }: RelayManagerProps) {
  const [customRelays, setCustomRelays] = useState<string[]>(() => getCustomRelays());
  const [addInput, setAddInput] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [probing, setProbing] = useState<Record<string, boolean>>({});
  const [capabilities, setCapabilities] = useState<Record<string, RelayCapabilities>>({});
  const [discovering, setDiscovering] = useState(false);
  const [discovered, setDiscovered] = useState<RelayCapabilities[]>([]);
  const [discoverNote, setDiscoverNote] = useState<string | null>(null);

  const builtin = getBuiltinRelays();

  const handleAdd = () => {
    const normalized = normalizeRelayUrl(addInput);
    if (!normalized) {
      setAddError('Enter a valid relay URL (wss://…)');
      return;
    }
    const added = addCustomRelay(normalized);
    if (!added) {
      setAddError('Already in the list');
      return;
    }
    setCustomRelays(getCustomRelays());
    setAddInput('');
    setAddError(null);
  };

  const handleRemove = (url: string) => {
    removeCustomRelay(url);
    setCustomRelays(getCustomRelays());
  };

  const handleProbe = async (url: string) => {
    setProbing((p) => ({ ...p, [url]: true }));
    const caps = await probeRelay(url);
    setCapabilities((c) => ({ ...c, [url]: caps }));
    setProbing((p) => ({ ...p, [url]: false }));
  };

  const handleDiscover = async () => {
    setDiscovering(true);
    setDiscoverNote(null);
    try {
      // NIP-66 discovery + NIP-11 verification, via the shared protocol
      // package (self-contained transport: dedicated monitor connections +
      // CORS-proxy failover; results cached 24h — `force` bypasses).
      const verified = await refreshDiscoveredRelays(true);

      const existing = new Set([...builtin, ...customRelays]);
      const fresh: RelayCapabilities[] = verified
        .filter((r) => !existing.has(r.url) && r.nip50)
        .map((r) => ({ url: r.url, online: true, nip50: r.nip50, sip01: r.sip01, latencyMs: r.latencyMs }));
      setDiscovered(fresh);

      if (fresh.length === 0) {
        setDiscoverNote(
          verified.length === 0
            ? 'No relay announcements found right now — the built-in set covers you.'
            : 'No new verified NIP-50 relays beyond what you already have.',
        );
      }
    } catch {
      setDiscoverNote('Discovery failed — your built-in relays are unaffected.');
    } finally {
      setDiscovering(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium">Relay pool</h3>
        <p className="text-xs text-muted-foreground">
          Observations and heartbeats are pushed to every relay in this set. Built-ins can't be
          removed; your additions persist on this device and apply on the next publish cycle.
        </p>
      </div>

      {/* Built-in relays */}
      <div className="space-y-1.5">
        {builtin.map((url) => {
          const caps = capabilities[url];
          const isProbing = probing[url];
          return (
            <div key={url} className="flex items-center gap-2 text-sm py-1">
              <Globe className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="font-mono text-xs truncate flex-1">{url}</span>
              <CapabilityBadges caps={caps} />
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0"
                onClick={() => handleProbe(url)}
                disabled={isProbing}
                aria-label={`Test ${url}`}
              >
                {isProbing ? (
                  <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" />
                ) : caps ? (
                  caps.online ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
                  ) : (
                    <XCircle className="h-3.5 w-3.5 text-destructive" />
                  )
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
              </Button>
            </div>
          );
        })}
      </div>

      {/* Custom relays */}
      {customRelays.length > 0 && (
        <>
          <Separator />
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Your relays</p>
            {customRelays.map((url) => {
              const caps = capabilities[url];
              const isProbing = probing[url];
              return (
                <div key={url} className="flex items-center gap-2 text-sm py-1">
                  <Globe className="h-3.5 w-3.5 text-primary shrink-0" />
                  <span className="font-mono text-xs truncate flex-1">{url}</span>
                  <CapabilityBadges caps={caps} />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    onClick={() => handleProbe(url)}
                    disabled={isProbing}
                    aria-label={`Test ${url}`}
                  >
                    {isProbing ? (
                      <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" />
                    ) : (
                      <RefreshCw className="h-3.5 w-3.5" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0 text-destructive"
                    onClick={() => handleRemove(url)}
                    aria-label={`Remove ${url}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              );
            })}
          </div>
        </>
      )}

      <Separator />

      {/* Add custom relay */}
      <div className="space-y-2">
        <div className="flex gap-2">
          <Input
            placeholder="wss://relay.example.com"
            value={addInput}
            onChange={(e) => { setAddInput(e.target.value); setAddError(null); }}
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            className="flex-1 font-mono text-xs"
          />
          <Button onClick={handleAdd} size="sm" className="gap-1">
            <Plus className="h-4 w-4" />
            Add
          </Button>
        </div>
        {addError && <p className="text-xs text-destructive">{addError}</p>}
      </div>

      <Separator />

      {/* Auto-discovery */}
      <div className="space-y-2">
        <Button
          variant="outline"
          size="sm"
          onClick={handleDiscover}
          disabled={discovering}
          className="gap-2"
        >
          {discovering ? (
            <Loader2 className="h-4 w-4 motion-safe:animate-spin" />
          ) : (
            <Radar className="h-4 w-4" />
          )}
          Discover NIP-50 / SIP-01 relays
        </Button>
        <p className="text-xs text-muted-foreground">
          Queries relay-monitor announcements (NIP-66), then verifies each candidate with a live
          capability probe (NIP-11). Nothing is added without you clicking it.
        </p>

        {discoverNote && (
          <p className="text-xs text-muted-foreground">{discoverNote}</p>
        )}

        {discovered.length > 0 && (
          <div className="space-y-1.5 pt-1">
            <p className="text-xs font-medium">
              {discovered.length} verified relay{discovered.length !== 1 ? 's' : ''} found
            </p>
            {discovered.map((caps) => (
              <div
                key={caps.url}
                className={cn(
                  'flex items-center gap-2 text-sm py-1 px-2 rounded-md',
                  caps.sip01 && 'bg-primary/5 border border-primary/20',
                )}
              >
                <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="font-mono text-xs truncate flex-1">{caps.url}</span>
                <CapabilityBadges caps={caps} />
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs shrink-0"
                  onClick={() => {
                    const added = addCustomRelay(caps.url);
                    if (added) {
                      setCustomRelays(getCustomRelays());
                      setDiscovered((d) => d.filter((r) => r.url !== caps.url));
                    }
                  }}
                >
                  <Plus className="h-3 w-3 mr-1" />
                  Add
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
