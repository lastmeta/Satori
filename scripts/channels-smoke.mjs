#!/usr/bin/env node
// The channel client (src/chain/channels.js) against the real PaymentChannels and D6 SATORI on a local anvil fork of
// Base Sepolia (docs/design/market.md#the-smoke-on-the-fork). Never a public chain. Fresh throwaway keys each run.
//
//   node scripts/fork.mjs start [--port 8547]        a fork (8545 is the dev server's; this moves its clock 8 days)
//   node scripts/channels-smoke.mjs [--port 8547]
//
// The buyer's wallet opens a channel with a permit and tops it up; its alias signs 24 vouchers; the seller's alias
// settles them with settleMany into the seller's wallet, staked so each payment runs the token's hook; the buyer's wallet
// then stakes, so it can't fund a channel any more (the lock, said plainly), while the channel keeps paying; close asked,
// cancelled, asked again; withdraw refused, then 8 days on, the rest refunded into the staked wallet. Prints each step's gas.
import { http } from 'viem';
import { generateSecret, publicKey, evmAddress, signDigest } from '../src/keys/keys.js';
import { DEFAULTS } from '../src/chain/config.js';
import { createChain } from '../src/chain/index.js';
import { createChannels, signVoucher, verifyVoucher } from '../src/chain/channels.js';
import { fund, advance } from './fork.mjs';

const argv = process.argv.slice(2);
const port = argv.includes('--port') ? argv[argv.indexOf('--port') + 1] : '8545';
const RPC = `http://127.0.0.1:${port}`;
const E15 = 10n ** 15n; // 0.001 SATORI: an observation's price here
const E18 = 10n ** 18n;
const fmt = (wei) => `${Number(wei) / 1e18}`;

const signer = () => { // our signer, as src/keys makes it: the key stays in the closure
  const secret = generateSecret();
  return { evmAddress: evmAddress(publicKey(secret)), signDigest: (h) => signDigest(secret, h) };
};
const buyer = { alias: signer(), wallet: signer() };
const seller = { alias: signer(), wallet: signer() };

const chain = createChain({ config: DEFAULTS, transport: http(RPC), pollingInterval: 250, settle: { tries: 5, ms: 500 } });
const channels = createChannels({ chain, config: DEFAULTS, settle: { tries: 5, ms: 500 } });
const gas = [];
const step = (what, by, receipt) => {
  gas.push({ what, by, gas: Number(receipt.gasUsed) });
  console.log(`  ${what.padEnd(40)} ${by.padEnd(16)} ${String(receipt.gasUsed).padStart(8)} gas`);
};
const check = (ok, what) => {
  if (!ok) throw new Error(`FAILED: ${what}`);
  console.log(`  ok: ${what}`);
};
const inSync = async (who) => { // the alias's booked power = the wallet's SATORI: every hook ran
  const st = await chain.status({ alias: who.alias.evmAddress, wallet: who.wallet.evmAddress });
  return st.alias.power === st.wallet.satori;
};
const refused = async (fn, words, who) => {
  const before = await chain.nonce(who, 'pending');
  const err = await fn().then(() => null, (e) => e);
  check(err?.message === words && (await chain.nonce(who, 'pending')) === before, `refused, nothing sent: "${err?.message}"`);
};

if ((await chain.chainId()) !== 84532) throw new Error(`${RPC} is not a fork of Base Sepolia`);
console.log(`fork ${RPC}, PaymentChannels ${DEFAULTS.channels}, SATORI ${DEFAULTS.token}`);
console.log(`buyer: wallet ${buyer.wallet.evmAddress}, alias ${buyer.alias.evmAddress}`);
console.log(`seller: wallet ${seller.wallet.evmAddress}, alias ${seller.alias.evmAddress}`);

console.log('\n1. funds (fork.mjs fund), and the seller\'s wallet staked with its alias');
await fund(RPC, [buyer.wallet.evmAddress], { eth: '0.1', satori: '5' });
await fund(RPC, [buyer.alias.evmAddress, seller.alias.evmAddress], { eth: '0.1' });
await fund(RPC, [seller.wallet.evmAddress], { eth: '0.1', satori: '1' });
await chain.delegate({ alias: seller.alias, wallet: seller.wallet });
check(await inSync(seller), 'the seller\'s wallet is staked with its alias (1 SATORI of power)');

console.log('\n2. the buyer\'s wallet opens a 2 SATORI channel to the seller\'s wallet, then tops it up by 1');
const opened = await channels.openChannel({ wallet: buyer.wallet, alias: buyer.alias, payee: seller.wallet.evmAddress, deposit: 2n * E18 });
step('openWithPermit', 'buyer wallet', opened.receipt);
check(opened.permit, 'one transaction, with SATORI\'s permit (domain "Satori", "1")');
const { id } = opened;
const up = await channels.topUp(buyer.wallet, id, E18);
step('approve (for topUp)', 'buyer wallet', await chain.client.getTransactionReceipt({ hash: up.approve }));
step('topUp', 'buyer wallet', up.receipt);
let c = await channels.readChannel(id);
check(c.payer === buyer.wallet.evmAddress && c.signer === buyer.alias.evmAddress && c.payee === seller.wallet.evmAddress
  && c.deposit === 3n * E18, `channel ${id.slice(0, 10)}…: payer = buyer wallet, signer = buyer alias, deposit 3 SATORI`);

console.log('\n3. the buyer\'s alias signs 24 vouchers (0.001 SATORI each), the seller checks each against the channel\'s signer');
const v = (cumulative) => ({ chainId: DEFAULTS.chainId, channelId: id, cumulative });
let last;
for (let n = 1n; n <= 24n; n++) {
  last = await signVoucher(buyer.alias, v(n * E15));
  if (!(await verifyVoucher({ ...v(n * E15), signature: last, signer: c.signer }))) throw new Error(`voucher ${n} did not verify`);
}
check(true, '24 vouchers signed and verified, none on chain');

console.log('\n4. the seller\'s alias settles with settleMany into its staked wallet');
const many = await channels.settleMany(seller.alias, [{ id, cumulative: 24n * E15, signature: last }]);
step('settleMany (1 channel, first settle)', 'seller alias', many.receipt);
check(many.settled[0]?.paid === 24n * E15 && many.skipped.length === 0, `Settled: paid ${fmt(many.settled[0]?.paid ?? 0n)} SATORI`);
check(await inSync(seller), 'the seller\'s stake is still in sync: the hook ran in full');

console.log('\n5. the buyer\'s wallet stakes with its alias: it can\'t fund a channel now, the channel keeps paying');
await chain.delegate({ alias: buyer.alias, wallet: buyer.wallet });
const staked = "Your wallet is staked with this app, so it can't send SATORI: a channel needs SATORI the wallet can send.";
await refused(() => channels.openChannel({ wallet: buyer.wallet, alias: buyer.alias, payee: seller.wallet.evmAddress, deposit: E18 }),
  staked, buyer.wallet.evmAddress);
await refused(() => channels.topUp(buyer.wallet, id, E18), staked, buyer.wallet.evmAddress);
for (let n = 25n; n <= 36n; n++) last = await signVoucher(buyer.alias, v(n * E15));
const one = await channels.settle(seller.alias, id, 36n * E15, last);
step('settle (a later one)', 'seller alias', one.receipt);
check(one.settled[0]?.paid === 12n * E15, `a channel funded before staking keeps paying: ${fmt(one.settled[0]?.paid ?? 0n)} SATORI more`);

console.log('\n6. close: asked by the buyer\'s alias, cancelled by its (staked) wallet, asked again');
step('requestClose', 'buyer alias', (await channels.requestClose(buyer.alias, id)).receipt);
step('cancelClose', 'buyer wallet', (await channels.cancelClose(buyer.wallet, id)).receipt);
step('requestClose (again)', 'buyer alias', (await channels.requestClose(buyer.alias, id)).receipt);
c = await channels.readChannel(id);
await refused(() => channels.withdraw(buyer.alias, id), "The waiting period after the close request hasn't ended yet.",
  buyer.alias.evmAddress);

console.log('\n7. fork.mjs advance 8, then withdraw: the rest back to the buyer\'s wallet');
await advance(RPC, 8);
const before = (await chain.status({ alias: buyer.alias.evmAddress, wallet: buyer.wallet.evmAddress })).wallet.satori;
step('withdraw', 'buyer alias', (await channels.withdraw(buyer.alias, id)).receipt);
const after = (await chain.status({ alias: buyer.alias.evmAddress, wallet: buyer.wallet.evmAddress })).wallet.satori;
check(after - before === 3n * E18 - 36n * E15, `refunded ${fmt(after - before)} SATORI (3 deposited − 0.036 settled) into the staked wallet`);
check(await inSync(buyer), 'the buyer\'s stake is in sync after the refund: the hook ran in full');
check((await channels.readChannel(id)).closed, 'the channel is closed');
check(after === 5n * E18 - 36n * E15, `the buyer's wallet: ${fmt(after)} SATORI (5 − 0.036)`);

console.log('\ngas used (receipts):');
console.log(JSON.stringify(gas));
