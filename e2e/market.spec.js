// Paid streams in Chrome (docs/design/market.md#selling-and-buying-over-the-relays): two neurons, a seller and a buyer,
// each in its own browser context, on the test relay 7781 (scripts/test-relay.mjs) and the local fork of Base Sepolia on
// :8545 (node scripts/fork.mjs start) with the real PaymentChannels and SATORI, fresh throwaway keys funded there. A
// provider publishes a stream every 6 s; the seller predicts it and sells its `_pred` (Market › Selling); the buyer finds it
// on the Market tab (Buying › Find streams for sale) and Buys (Unlock in place): the wallet opens a channel, each observation comes encrypted to it
// alone (in public a heartbeat), lands in its track record, and is paid with a voucher; Stop asks the contract to close, the
// seller stops delivering and settles in its next pass (at most once a day; here a reload runs it), into its wallet. SHOTS=1 writes docs/screenshots/market-sell-* and market-buy-*.
import { expect, test } from '@playwright/test';
import WebSocket from 'ws';
import { createPublicClient, http, parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { connectProvider } from '../scripts/provider.mjs';
import { advance, fund } from '../scripts/fork.mjs';
import { createRelay } from '../src/nostr/relay.js';
import { DEFAULTS } from '../src/chain/config.js';
import { channelsAbi, tokenAbi } from '../src/chain/abi.js';
import { openApp, LOAD_TIMEOUT } from './load.js';
import { stubCentral } from './stub.js';

const RELAY = 'ws://localhost:7781';
const FORK = 'http://127.0.0.1:8545';
const PASS = 'correct horse battery';
const CADENCE = 6;
const chain = createPublicClient({ transport: http(FORK) });
/** /rpc to the fork (the stub aborts it otherwise). */
const forkRpc = { http: async (body) => (await fetch(FORK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json() };

async function reader(url) {
  const r = createRelay(url, { WebSocket });
  r.connect();
  await expect.poll(() => r.state).toBe('open');
  return r;
}
async function neuron(browser) {
  const context = await browser.newContext();
  await stubCentral(context, { rpc: forkRpc });
  const page = await context.newPage();
  await openApp(page);
  const s = await page.evaluate((p) => window.satori.setup({ passphrase: p }), PASS);
  await expect(page.locator('[data-test=alias]')).toHaveText(/^0x[0-9a-fA-F]{40}$/, { timeout: LOAD_TIMEOUT });
  await page.evaluate((u) => window.satori.setRelays({ relays: [u] }), RELAY);
  return { context, page, nostr: s.nostr.pubkey, alias: s.alias, wallet: s.wallet };
}
/** Market › Buying › Find streams for sale, opened unless it is. */
const openForSale = async (page) => {
  const find = page.locator('[data-test=market-find]');
  if ((await find.getAttribute('aria-expanded')) !== 'true') await find.click();
};
const market = (page) => page.evaluate(async () => (await window.satori.nostr()).market);
const tagOf = (e, n) => e.tags.find((t) => t[0] === n)?.[1];
const shot = async (locator, name) => locator.screenshot({ path: process.env.SHOTS ? `docs/screenshots/${name}.png` : test.info().outputPath(`${name}.png`) });

test('sell and buy a prediction stream: a channel on the Satori contract, encrypted deliveries, vouchers, Stop and the settle', async ({ browser }) => {
  test.setTimeout(600_000); // two neurons, a fork and a relay: minutes on the busy shared box
  const provider = await connectProvider({ url: RELAY });
  const stream = `walk-${Date.now().toString(36)}`;
  const pred = `${stream}_pred`;
  await provider.announce({ stream, name: 'Test walk', cadence: CADENCE });
  let seq = 0;
  let value = 100;
  const tick = setInterval(() => {
    value = Number((value + (seq % 3 ? 1.5 : -1)).toFixed(2));
    provider.observe({ stream, value: String(value), seq: ++seq }).catch(() => {});
  }, CADENCE * 1000);

  try {
    // the seller predicts the stream and sells its `_pred` (Streams › Sell)
    const seller = await neuron(browser);
    const buyer = await neuron(browser);
    await fund(FORK, [seller.alias, buyer.alias, seller.wallet]); // gas: the seller's settle and payout address, the buyer's close
    await fund(FORK, [buyer.wallet], { satori: '1' }); // gas and SATORI for the channel
    await seller.page.evaluate(([p, s]) => window.satori.subscribe(p, s, { predict: true }), [provider.pubkey, stream]);
    const s = seller.page;
    await s.setViewportSize({ width: 390, height: 844 });
    await s.evaluate(() => window.satori.go('market'));
    const row = s.locator(`[data-test=market-sales] [data-test=sell-row][data-stream="${pred}"]`);
    await expect(row.locator('[data-test=sell-state]')).toHaveText('Free');
    await row.locator('[data-test=sell-price]').fill('0.001');
    await row.locator('[data-test=sell]').click();
    await expect(row.locator('[data-test=sell-state]')).toHaveText('0.001 SATORI each');
    await expect(row.locator('[data-test=unsell]')).toHaveText('Make free');

    // the buyer finds it on the Market tab: its price, a deposit of 100 observations, Buy; Unlock in place
    const b = buyer.page;
    await b.setViewportSize({ width: 390, height: 844 });
    await b.evaluate(() => window.satori.go('market'));
    await openForSale(b);
    const item = b.locator('[data-test=market-item]', { hasText: pred });
    await expect(item.locator('[data-test=market-price]')).toHaveText('0.001 SATORI each', { timeout: 30_000 });
    await expect(item.locator('[data-test=buy-deposit]')).toHaveValue('0.1');
    await item.locator('[data-test=buy-deposit]').fill('0.01');
    await item.locator('[data-test=buy]').click();
    await b.getByLabel('Wallet passphrase to buy').fill(PASS);
    await b.locator('[data-unlock-for=buy]').getByRole('button', { name: 'Unlock' }).click();
    await expect(item.locator('[data-test=catalog-bought]')).toHaveText('Bought · 0.01 SATORI left', { timeout: 60_000 });
    const [bought] = (await market(b)).bought;
    expect(bought).toMatchObject({ pubkey: seller.nostr, stream: pred, price: '0.001', deposit: '0.01', status: 'open' });
    const channel = await chain.readContract({ address: DEFAULTS.channels, abi: channelsAbi, functionName: 'getChannel', args: [bought.channel] });
    expect(channel).toMatchObject({ payer: expect.stringMatching(new RegExp(buyer.wallet, 'i')), payee: expect.stringMatching(new RegExp(seller.wallet, 'i')),
      signer: expect.stringMatching(new RegExp(buyer.alias, 'i')), deposit: parseEther('0.01') });

    // the seller accepts it from the chain; each observation then goes to the buyer alone, and is paid
    await expect.poll(async () => (await market(s)).selling[0]?.buyers[0]?.channel, { timeout: 30_000 }).toBe(bought.channel);
    await expect.poll(async () => (await market(b)).bought[0].received != null ? Number((await market(b)).bought[0].paid) : 0,
      { timeout: 180_000 }).toBeGreaterThanOrEqual(0.003);
    await expect.poll(async () => Number((await market(s)).selling[0].buyers[0].paid), { timeout: 30_000 }).toBeGreaterThanOrEqual(0.003);
    // on the relay: the value encrypted to the buyer (its own d); in public a heartbeat, no value
    const r = await reader(RELAY);
    const [mine] = await r.fetch([{ kinds: [34601], authors: [seller.nostr], '#d': [`${pred}:${buyer.nostr}`] }]);
    expect(tagOf(mine, 'p')).toBe(buyer.nostr);
    expect(mine.content).toMatch(/^[A-Za-z0-9+/=]+\?iv=[A-Za-z0-9+/=]+$/);
    const [pub] = await r.fetch([{ kinds: [34601], authors: [seller.nostr], '#d': [pred] }]);
    expect([pub.content, tagOf(pub, 'satori')]).toEqual(['', 'heartbeat']);
    const [ann] = await r.fetch([{ kinds: [34600], authors: [seller.nostr], '#d': [pred] }]);
    expect(JSON.parse(ann.content)).toMatchObject({ encrypted: true, price_per_obs: 100000, metadata: { market: { chain: 84532, contract: DEFAULTS.channels,
      token: DEFAULTS.token, payee: seller.wallet } } }); // one price: Lite's price_per_obs, 0.001 SATORI in satoshis
    r.close();
    // what was bought lands in the buyer's track record (the watched stream's table)
    await expect.poll(async () => (await b.evaluate(([p, st]) => window.satori.record(p, st), [seller.nostr, pred]))?.received ?? 0)
      .toBeGreaterThanOrEqual(2);

    // the screens: the seller's sales with its buyer; the buyer's Bought, on the Market tab
    await expect(row.locator('[data-test=sell-state]')).toHaveText('0.001 SATORI each · 1 buying');
    await s.setViewportSize({ width: 390, height: 2400 }); // tall, so the phone's tab bar is not over the card
    await shot(s.locator('[data-test=market-tab]'), 'market-sell-phone-light');
    const left = b.locator(`[data-test=bought-row][data-key="${seller.nostr}:${pred}"] [data-test=bought-left]`);
    await expect(left).toHaveText(/^0\.00\d+ of 0\.01 SATORI left$/);
    await b.setViewportSize({ width: 390, height: 2400 });
    await shot(b.locator('[data-test=market-tab]'), 'market-buy-phone-light');

    // Stop: the alias asks to close (no Unlock); the seller stops delivering, and settles into its wallet in its next pass
    await b.locator(`[data-test=bought-row][data-key="${seller.nostr}:${pred}"] [data-test=stop]`).click();
    await expect(left).toHaveText(/^Stopping: [\d.]+ SATORI can be taken back after .+$/, { timeout: 60_000 });
    const paid = parseEther((await market(b)).bought[0].paid);
    const read = () => chain.readContract({ address: DEFAULTS.channels, abi: channelsAbi, functionName: 'getChannel', args: [bought.channel] });
    expect((await read()).closeRequestedAt).toBeGreaterThan(0n);
    await expect.poll(async () => (await market(s)).selling[0].buyers[0]?.closing, { timeout: 30_000 }).toBe(true);
    expect((await read()).settled).toBe(0n); // no settle of its own: the pass collects, at most once a day
    await s.reload(); // a start runs the pass; the seller has never settled, so it is due
    await expect(s.locator('body')).toHaveAttribute('data-screen', 'home', { timeout: LOAD_TIMEOUT });
    await expect.poll(async () => (await read()).settled, { timeout: 60_000 }).toBe(paid);
    expect(await chain.readContract({ address: DEFAULTS.token, abi: tokenAbi, functionName: 'balanceOf', args: [seller.wallet] })).toBe(paid);
    // the sale goes once all it delivered is paid; one delivered as Stop came, never paid, keeps it (closing) until the
    // channel closes (src/neuron/market.js collect)
    await expect.poll(async () => (await market(s)).selling[0].buyers.filter((x) => !(x.closing && x.delivered * 0.001 > Number(x.settled) + 1e-9)),
      { timeout: 30_000 }).toEqual([]);

    // after the grace period: stopped, the rest in the channel; Take back part of it to another address (Unlock in place)
    await advance(FORK, 8);
    await b.reload(); // a start runs the pass
    await expect(b.locator('body')).toHaveAttribute('data-screen', 'home', { timeout: LOAD_TIMEOUT });
    await b.evaluate(() => window.satori.go('market'));
    await expect(left).toHaveText(/^Stopped: [\d.]+ SATORI left in the channel\. Buy it again to use it, or take it back\.$/, { timeout: 60_000 });
    const brow = b.locator(`[data-test=bought-row][data-key="${seller.nostr}:${pred}"]`);
    const elsewhere = privateKeyToAccount(generatePrivateKey()).address; // fresh: the fork keeps earlier runs' balances
    const before = Number((await market(b)).bought[0].refundable);
    await brow.locator('[data-test=takeback-amount]').fill('0.001');
    await brow.locator('[data-test=takeback-to]').fill(elsewhere);
    await brow.locator('[data-test=takeback]').click();
    await b.getByLabel('Wallet passphrase to change the channel').fill(PASS);
    await b.locator('[data-unlock-for=market]').getByRole('button', { name: 'Unlock' }).click();
    await expect.poll(() => chain.readContract({ address: DEFAULTS.token, abi: tokenAbi, functionName: 'balanceOf', args: [elsewhere] }),
      { timeout: 60_000 }).toBe(parseEther('0.001'));
    expect((await read()).settled).toBe(paid + parseEther('0.001')); // taken back counts as settled
    await expect.poll(async () => Number((await market(b)).bought[0].refundable), { timeout: 30_000 }).toBeCloseTo(before - 0.001, 8);
    // the agent call: the rest, to the wallet; the channel stays
    const unlock = (page) => page.evaluate((p) => window.satori.unlock(p), PASS); // the wallet locks again after each use
    await unlock(b);
    const rest = await b.evaluate((c) => window.satori.takeBack(c), bought.channel);
    expect(rest.refundable).toBe('0');
    expect((await read()).closed).toBe(false);

    // Buy again: the same channel, its close taken back and topped up; the seller serves it again
    await openForSale(b);
    await expect(item.locator('[data-test=buy]')).toHaveText('Buy again');
    await item.locator('[data-test=buy-deposit]').fill('0.005');
    await unlock(b);
    await item.locator('[data-test=buy]').click();
    await expect(item.locator('[data-test=catalog-bought]')).toHaveText(/^Bought · 0\.005 SATORI left$/, { timeout: 60_000 });
    expect((await market(b)).bought.map((x) => x.channel)).toEqual([bought.channel]);
    expect((await read()).closeRequestedAt).toBe(0n);
    await expect.poll(async () => (await market(s)).selling[0].buyers[0]?.channel, { timeout: 60_000 }).toBe(bought.channel);

    // a grace period (the buyer lengthens it at once) and a payout address (the seller's wallet), by agent calls
    const terms = () => chain.readContract({ address: DEFAULTS.channels, abi: channelsAbi, functionName: 'getTerms', args: [bought.channel] });
    await unlock(b);
    expect(await b.evaluate((c) => window.satori.setGrace(c, 10), bought.channel)).toEqual({ applied: true, grace: 864_000 });
    expect((await terms())[0]).toBe(864_000n);
    await unlock(b);
    expect(await b.evaluate((c) => window.satori.setGrace(c, 2), bought.channel)).toEqual({ applied: false, grace: 864_000 }); // asked of the seller
    await unlock(s);
    const payout = '0x' + '8'.repeat(40);
    expect(await s.evaluate(([c, a]) => window.satori.setPayout(c, a), [bought.channel, payout])).toMatchObject({ payout: expect.stringMatching(/^0x8{40}$/i), toWallet: false });
    expect((await terms())[1].toLowerCase()).toBe(payout);
    await s.evaluate(() => window.satori.go('market'));
    await expect(row.locator('[data-test=buyer-text]')).toHaveText(/into 0x8888…8888$/);
    await seller.context.close();
    await buyer.context.close();
  } finally {
    clearInterval(tick);
    provider.close();
  }
});
