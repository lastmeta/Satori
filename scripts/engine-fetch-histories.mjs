// Read-only: pull Base Sepolia registry histories of streams that have a binary game
// into test/fixtures/engine-base-histories.json for scripts/engine-backtest.mjs.
// Usage: node scripts/engine-fetch-histories.mjs [registry games [rpcUrl]]
// Defaults: the current deployment (contract/satori/deployments/baseSepolia.json).
import { writeFileSync } from 'node:fs';
import { createPublicClient, http, parseAbi } from 'viem';
import { baseSepolia } from 'viem/chains';

const [REGISTRY = '0x1ED75AB0a66Ba7d23C3E5c84798e90205E76743a', GAMES = '0xB06e419D24cCbA967c6193e9e374117171B400C3', RPC = 'https://sepolia.base.org'] = process.argv.slice(2);
const abi = parseAbi([
  'function getAllDataStreams() view returns (uint32[])',
  'function getDataStreamInfo(uint32) view returns (string name, address provider, uint8 streamType, int256 value, uint256 valueHour, bool exists)',
  'function getHistoryPage(uint32, uint256, uint256) view returns (int232[] values, uint24[] entryHours, uint16 total)',
  'function binaryGameByStream(uint32) view returns (uint256)',
]);
const client = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
const read = (address, functionName, args = []) => client.readContract({ address, abi, functionName, args });

const ids = await read(REGISTRY, 'getAllDataStreams');
const streams = [];
for (const id of ids) {
  const game = await read(GAMES, 'binaryGameByStream', [id]);
  if (!game) continue;
  const [name] = await read(REGISTRY, 'getDataStreamInfo', [id]);
  const [values, hours] = await read(REGISTRY, 'getHistoryPage', [id, 0n, 768n]);
  streams.push({ id: Number(id), game: Number(game), name, hours: hours.map(Number), values: values.map(String) });
  console.log(id, name, values.length);
}
const out = new URL('../test/fixtures/engine-base-histories.json', import.meta.url);
writeFileSync(out, JSON.stringify({ source: `Base Sepolia registry ${REGISTRY} getHistoryPage`, fetchedAt: new Date().toISOString(), streams }, null, 1) + '\n');
console.log(`wrote ${streams.length} streams to ${out.pathname}`);
