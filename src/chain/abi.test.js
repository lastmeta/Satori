import { describe, expect, test } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { encodeFunctionData, toFunctionSelector } from 'viem';
import * as abi from './abi.js';

const OUT = '/code/Satori/contract/satori/out';
const built = {
  engineAbi: 'SatoriEngine', gamesAbi: 'SatoriGames', registryAbi: 'SatoriRegistry', hubAbi: 'SatoriHub',
  rewardsAbi: 'SatoriRewards', lensAbi: 'SatoriRewardsLens', tokenAbi: 'SatoriToken', merkleAbi: 'SatoriMerkle',
  airdropAbi: 'SatoriAirdrop',
};
// "function name(inputs) -> (outputs) mutability", types only
const t = (p) => (p.components ? `(${p.components.map(t).join(',')})${p.type.slice(5)}` : p.type);
const sig = (i) => `${i.type} ${i.name}(${(i.inputs ?? []).map(t)}) -> (${(i.outputs ?? []).map(t)})`
  + (i.type === 'function' ? ` ${i.stateMutability}` : '');

describe.skipIf(!existsSync(OUT))('abi.js matches the D6 contracts (contract/satori/out)', () => {
  const read = (c) => JSON.parse(readFileSync(`${OUT}/${c}.sol/${c}.json`, 'utf8')).abi;
  const allErrors = new Set(Object.values(built).flatMap((c) => read(c).filter((i) => i.type === 'error').map(sig)));
  for (const [name, c] of Object.entries(built)) {
    test(`${name}: every function as ${c} has it`, () => {
      const real = read(c).filter((i) => i.type === 'function').map(sig);
      for (const item of abi[name].filter((i) => i.type === 'function')) expect(real).toContain(sig(item));
    });
  }
  test('every error the ABIs decode is one the contracts raise', () => {
    for (const item of abi.engineAbi.filter((i) => i.type === 'error')) expect(allErrors).toContain(sig(item));
  });
});

describe('selectors and calldata (Lite\'s and the brief\'s)', () => {
  test('DuplicatePrediction is 0xe372c20e (base_predict.py:132)', () => {
    expect(toFunctionSelector('DuplicatePrediction()')).toBe('0xe372c20e');
  });
  test('predictMultipleWithPayloads([(1, 0x01), (7, 0x02)]): the tuple[] Lite sends', () => {
    const data = encodeFunctionData({ abi: abi.engineAbi, functionName: 'predictMultipleWithPayloads',
      args: [[{ gameId: 1, payload: '0x01' }, { gameId: 7, payload: '0x02' }]] });
    expect(data.slice(0, 10)).toBe(toFunctionSelector('predictMultipleWithPayloads((uint32,bytes)[])'));
    expect(data).toContain('0100000000000000000000000000000000000000000000000000000000000000'); // 0x01, left-aligned
  });
});
