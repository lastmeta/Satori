#!/usr/bin/env node
// A throwaway Satori stream provider for development: announces a stream
// (34600) and publishes a random walk on it (34601), as a Lite provider does.
// With --pred, a second throwaway key also predicts it, as a Lite neuron does:
// it announces `<stream>_pred` naming the stream as its source and publishes a
// forecast of the next value right after each one (the walk is drawn a step
// ahead, so this predictor beats no change: a track record to look at,
// docs/design/track-record.md).
// Usage: node scripts/provider.mjs [relay] [stream] [seconds] [--pred]
//        (defaults: ws://localhost:7778 demo-walk 60). The e2e uses connectProvider.
// It refuses the production relay: test streams belong on a test relay.
import WebSocket from 'ws';
import { createRelay } from '../src/nostr/relay.js';
import { signEvent, generateNostrSecret, nostrPubkey } from '../src/nostr/event.js';
import { announceEvent, observationEvent } from '../src/nostr/satori.js';

const PRODUCTION = /satorian\.satorinet\.io/;

/** Connect a provider with a key (random by default). → { pubkey, announce, observe, close } */
export async function connectProvider({ url, secret = generateNostrSecret() }) {
  if (PRODUCTION.test(url)) throw new Error('Not on the production relay: use a test relay (scripts/test-relay.mjs).');
  const pubkey = nostrPubkey(secret);
  const relay = createRelay(url, { WebSocket });
  relay.connect();
  for (let i = 0; relay.state !== 'open'; i++) {
    if (i > 100) throw new Error(`${url}: no connection`);
    await new Promise((r) => setTimeout(r, 50));
  }
  const send = async (template) => {
    const e = signEvent(template, secret);
    const r = await relay.publish(e);
    if (!r.ok) throw new Error(`${url} refused ${e.kind}: ${r.message}`);
    return e;
  };
  const now = () => Math.floor(Date.now() / 1000);
  return {
    pubkey,
    /** 34600 for a free stream. */
    announce: ({ stream, name = stream, description = '', cadence = 60, tags = [] }) => send(announceEvent({
      stream_name: stream, nostr_pubkey: pubkey, name, description, encrypted: false, price_per_obs: 0,
      created_at: now(), cadence_seconds: cadence, tags, metadata: null }, now())),
    /** 34600 for `<source>_pred`, a prediction stream of `source` ({ pubkey, stream }), named as Lite names it (its tags and metadata). */
    announcePred: ({ source, name = `Predictions for ${source.stream}`, cadence = 60 }) => send(announceEvent({
      stream_name: `${source.stream}_pred`, nostr_pubkey: pubkey, name, description: '', encrypted: false, price_per_obs: 0,
      created_at: now(), cadence_seconds: cadence, tags: [],
      metadata: { source_stream_name: source.stream, source_provider_pubkey: source.pubkey, wallet_pubkey: null } }, now())),
    /** 34601 with `value` (a string, as Lite providers send numbers). */
    observe: ({ stream, value, seq, timestamp = now() }) =>
      send(observationEvent({ stream, value, seq, timestamp, now: now() })),
    close: () => relay.close(),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const pred = args.includes('--pred');
  const [url = 'ws://localhost:7778', stream = 'demo-walk', seconds = '60'] = args.filter((a) => a !== '--pred');
  const cadence = Number(seconds);
  const p = await connectProvider({ url });
  await p.announce({ stream, name: `Demo random walk (${stream})`, description: 'A test stream from scripts/provider.mjs.',
    cadence, tags: ['demo'] });
  console.log(`provider ${p.pubkey} announced ${stream} on ${url}; a value every ${cadence} s`);
  const predictor = pred ? await connectProvider({ url }) : null;
  if (predictor) {
    await predictor.announcePred({ source: { pubkey: p.pubkey, stream }, name: `Predictions for Demo random walk (${stream})`, cadence });
    console.log(`predictor ${predictor.pubkey} announced ${stream}_pred`);
  }
  const step = (v) => Math.max(1, v * (1 + (Math.random() - 0.5) * 0.02));
  let value = 100;
  let next = step(value);
  let seq = 0;
  const tick = async () => {
    [value, next] = [next, step(next)];
    const e = await p.observe({ stream, value: value.toFixed(4), seq: ++seq });
    console.log(`seq ${seq} value ${value.toFixed(4)} ${e.id.slice(0, 12)}`);
    if (!predictor) return;
    await new Promise((r) => setTimeout(r, 1000)); // a moment after it, as a Lite neuron's forecast follows the observation
    const guess = value + 0.6 * (next - value); // most of the way to what comes next
    await predictor.observe({ stream: `${stream}_pred`, value: guess.toFixed(4), seq });
  };
  await tick();
  setInterval(() => void tick().catch((err) => console.error(err.message)), cadence * 1000);
}
