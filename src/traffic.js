// Real traffic per channel, for Home's glow (src/ui/glow.js) and health().channels[x].lastTraffic
// (docs/design/health.md#traffic): central's fetch (src/central), Base's RPC (src/neuron/base.js traces its viem
// transport) and the relays' messages (src/nostr/relay.js). Nothing polls: the UI subscribes.

export const CHANNELS = ['central', 'base', 'network'];

export function createTraffic() {
  const last = { central: null, base: null, network: null };
  const subs = new Set();
  return {
    /** A request or an answer on `channel` (at: ms). */
    emit(channel, at = Date.now()) {
      last[channel] = at;
      for (const fn of subs) fn(channel, at);
    },
    /** fn(channel, at) on each; → unsubscribe. */
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    /** { central, base, network }: each channel's last traffic (ms), or null. */
    last: () => ({ ...last }),
  };
}

export const { emit, subscribe, last: lastTraffic } = createTraffic();

/** A viem transport whose every request, and its answer or error, calls fire(). */
export function traced(transport, fire) {
  return (opts) => {
    const t = transport(opts);
    return {
      ...t,
      async request(...args) {
        fire();
        try {
          return await t.request(...args);
        } finally {
          fire();
        }
      },
    };
  };
}
