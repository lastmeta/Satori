import { describe, expect, test } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { encodeFunctionData } from 'viem';
import * as abi from './abi.js';
import vectors from '../../test/fixtures/chain-web3-calldata.json' with { type: 'json' };

const ART = '/code/Satori/contract/satori/artifacts/contracts';
const artifacts = {
  registryAbi: 'SatoriRegistry.sol/SatoriRegistry.json',
  gamesAbi: 'SatoriGames.sol/SatoriGames.json',
  engineAbi: 'next/SatoriEngine.sol/SatoriEngine.json',
  hubAbi: 'next/SatoriHub.sol/SatoriHub.json',
  tokenAbi: 'next/SatoriToken.sol/SatoriToken.json',
  rewardsAbi: 'SatoriRewards.sol/SatoriRewards.json',
  merkleAbi: 'SatoriMerkle.sol/SatoriMerkle.json',
  airdropAbi: 'SatoriAirdrop.sol/SatoriAirdrop.json',
};
// "kind name(inputs) -> (outputs)" with types only
const t = (p) => (p.components ? `(${p.components.map(t).join(',')})${p.type.slice(5)}` : p.type);
const sig = (i) => `${i.type} ${i.name}(${(i.inputs ?? []).map(t)}) -> (${(i.outputs ?? []).map(t)})`;

describe.skipIf(!existsSync(ART))('abi.js matches the contract artifacts', () => {
  for (const [name, file] of Object.entries(artifacts)) {
    test(name, () => {
      const real = JSON.parse(readFileSync(`${ART}/${file}`, 'utf8')).abi.filter((i) => i.name).map(sig);
      for (const item of abi[name]) expect(real).toContain(sig(item));
    });
  }
});

describe('calldata matches web3 (Docker neuron ABIs)', () => {
  const A = vectors.address;
  const c = vectors.calldata;
  const enc = (a, functionName, args) => encodeFunctionData({ abi: a, functionName, args });
  test.each([
    ['predictMultipleWithPayloads([(1,0x01),(7,0x02)])', abi.engineAbi, 'predictMultipleWithPayloads',
      [[{ gameId: 1, payload: '0x01' }, { gameId: 7, payload: '0x02' }]]],
    ['predictedStreamsCount(A,20741)', abi.engineAbi, 'predictedStreamsCount', [A, 20741n]],
    ['binaryGameByStream(1)', abi.gamesAbi, 'binaryGameByStream', [1]],
    ['delegatePredictionPower(A)', abi.hubAbi, 'delegatePredictionPower', [A]],
    ['delegatePredictionPower(0x0)', abi.hubAbi, 'delegatePredictionPower', ['0x0000000000000000000000000000000000000000']],
    ['setPredictorFee(0)', abi.rewardsAbi, 'setPredictorFee', [0]],
    ['claimMerkle(10,[0x22..])', abi.merkleAbi, 'claimMerkle', [10n, ['0x' + '22'.repeat(32)]]],
    ['claimAirdrop()', abi.airdropAbi, 'claimAirdrop', []],
  ])('%s', (key, a, fn, args) => {
    expect(enc(a, fn, args)).toBe(c[key].toLowerCase());
  });
});
