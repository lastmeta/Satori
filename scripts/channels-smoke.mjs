#!/usr/bin/env node
// The channel client (src/chain/channels.js) against the real PaymentChannels and D6 SATORI on a local anvil fork of
// Base Sepolia (docs/design/market.md#the-smoke-on-the-fork). Never a public chain. Fresh throwaway keys each run.
//
//   node scripts/fork.mjs start [--port 8547]        a fork (8545 is the dev server's; this moves its clock 8 days)
//   node scripts/channels-smoke.mjs [--port 8547]
//
// The buyer's vault opens a channel with a permit and tops it up; its identity signs 24 vouchers; the seller's identity
// settles them with settleMany into the seller's vault, staked so each payment runs the token's hook; the buyer's vault
// then stakes, so it can't fund a channel any more (the lock, said plainly), while the channel keeps paying; close asked,
// cancelled, asked again; withdraw refused, then 8 days on, the rest refunded into the staked vault. Prints each step's gas.
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
const buyer = { identity: signer(), vault: signer() };
const seller = { identity: signer(), vault: signer() };

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
const inSync = async (who) => { // the identity's booked power = the vault's SATORI: every hook ran
  const st = await chain.status({ identity: who.identity.evmAddress, vault: who.vault.evmAddress });
  return st.identity.power === st.vault.satori;
};
const refused = async (fn, words, who) => {
  const before = await chain.nonce(who, 'pending');
  const err = await fn().then(() => null, (e) => e);
  check(err?.message === words && (await chain.nonce(who, 'pending')) === before, `refused, nothing sent: "${err?.message}"`);
};

if ((await chain.chainId()) !== 84532) throw new Error(`${RPC} is not a fork of Base Sepolia`);
console.log(`fork ${RPC}, PaymentChannels ${DEFAULTS.channels}, SATORI ${DEFAULTS.token}`);
console.log(`buyer: vault ${buyer.vault.evmAddress}, identity ${buyer.identity.evmAddress}`);
console.log(`seller: vault ${seller.vault.evmAddress}, identity ${seller.identity.evmAddress}`);

console.log('\n1. funds (fork.mjs fund), and the seller\'s vault staked with its identity');
await fund(RPC, [buyer.vault.evmAddress], { eth: '0.1', satori: '5' });
await fund(RPC, [buyer.identity.evmAddress, seller.identity.evmAddress], { eth: '0.1' });
await fund(RPC, [seller.vault.evmAddress], { eth: '0.1', satori: '1' });
await chain.delegate({ identity: seller.identity, vault: seller.vault });
check(await inSync(seller), 'the seller\'s vault is staked with its identity (1 SATORI of power)');

console.log('\n2. the buyer\'s vault opens a 2 SATORI channel to the seller\'s vault, then tops it up by 1');
const opened = await channels.openChannel({ vault: buyer.vault, identity: buyer.identity, payee: seller.vault.evmAddress, deposit: 2n * E18 });
step('openWithPermit', 'buyer vault', opened.receipt);
check(opened.permit, 'one transaction, with SATORI\'s permit (domain "Satori", "1")');
const { id } = opened;
const up = await channels.topUp(buyer.vault, id, E18);
step('approve (for topUp)', 'buyer vault', await chain.client.getTransactionReceipt({ hash: up.approve }));
step('topUp', 'buyer vault', up.receipt);
let c = await channels.readChannel(id);
check(c.payer === buyer.vault.evmAddress && c.signer === buyer.identity.evmAddress && c.payee === seller.vault.evmAddress
  && c.deposit === 3n * E18, `channel ${id.slice(0, 10)}…: payer = buyer vault, signer = buyer identity, deposit 3 SATORI`);

console.log('\n3. the buyer\'s identity signs 24 vouchers (0.001 SATORI each), the seller checks each against the channel\'s signer');
const v = (cumulative) => ({ chainId: DEFAULTS.chainId, channelId: id, cumulative });
let last;
for (let n = 1n; n <= 24n; n++) {
  last = await signVoucher(buyer.identity, v(n * E15));
  if (!(await verifyVoucher({ ...v(n * E15), signature: last, signer: c.signer }))) throw new Error(`voucher ${n} did not verify`);
}
check(true, '24 vouchers signed and verified, none on chain');

console.log('\n4. the seller\'s identity settles with settleMany into its staked vault');
const many = await channels.settleMany(seller.identity, [{ id, cumulative: 24n * E15, signature: last }]);
step('settleMany (1 channel, first settle)', 'seller identity', many.receipt);
check(many.settled[0]?.paid === 24n * E15 && many.skipped.length === 0, `Settled: paid ${fmt(many.settled[0]?.paid ?? 0n)} SATORI`);
check(await inSync(seller), 'the seller\'s stake is still in sync: the hook ran in full');

console.log('\n5. the buyer\'s vault stakes with its identity: it can\'t fund a channel now, the channel keeps paying');
await chain.delegate({ identity: buyer.identity, vault: buyer.vault });
const staked = "Your vault is staked with this neuron, so it can't send SATORI: a channel needs SATORI the vault can send.";
await refused(() => channels.openChannel({ vault: buyer.vault, identity: buyer.identity, payee: seller.vault.evmAddress, deposit: E18 }),
  staked, buyer.vault.evmAddress);
await refused(() => channels.topUp(buyer.vault, id, E18), staked, buyer.vault.evmAddress);
for (let n = 25n; n <= 36n; n++) last = await signVoucher(buyer.identity, v(n * E15));
const one = await channels.settle(seller.identity, id, 36n * E15, last);
step('settle (a later one)', 'seller identity', one.receipt);
check(one.settled[0]?.paid === 12n * E15, `a channel funded before staking keeps paying: ${fmt(one.settled[0]?.paid ?? 0n)} SATORI more`);

console.log('\n6. close: asked by the buyer\'s identity, cancelled by its (staked) vault, asked again');
step('requestClose', 'buyer identity', (await channels.requestClose(buyer.identity, id)).receipt);
step('cancelClose', 'buyer vault', (await channels.cancelClose(buyer.vault, id)).receipt);
step('requestClose (again)', 'buyer identity', (await channels.requestClose(buyer.identity, id)).receipt);
c = await channels.readChannel(id);
await refused(() => channels.withdraw(buyer.identity, id), "The 7-day grace period after the close request hasn't ended yet.",
  buyer.identity.evmAddress);

console.log('\n7. fork.mjs advance 8, then withdraw: the rest back to the buyer\'s vault');
await advance(RPC, 8);
const before = (await chain.status({ identity: buyer.identity.evmAddress, vault: buyer.vault.evmAddress })).vault.satori;
step('withdraw', 'buyer identity', (await channels.withdraw(buyer.identity, id)).receipt);
const after = (await chain.status({ identity: buyer.identity.evmAddress, vault: buyer.vault.evmAddress })).vault.satori;
check(after - before === 3n * E18 - 36n * E15, `refunded ${fmt(after - before)} SATORI (3 deposited − 0.036 settled) into the staked vault`);
check(await inSync(buyer), 'the buyer\'s stake is in sync after the refund: the hook ran in full');
check((await channels.readChannel(id)).closed, 'the channel is closed');
check(after === 5n * E18 - 36n * E15, `the buyer's vault: ${fmt(after)} SATORI (5 − 0.036)`);

console.log('\ngas used (receipts):');
console.log(JSON.stringify(gas));
