import { beforeEach, describe, expect, test, vi } from 'vitest';
import { memoryDb } from '../../test/memory-db.js';
import { dataOf, modelsFile, putData, putModels } from './transfer.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 }); // DuckDB's wasm starts in the first beforeEach

const SERVICE = 'https://service.example';
const spec = { companions: [{ uuid: 'u-b', name: 'b' }], lambda1: 0.2, lambda2: 0.5 };
let db;
beforeEach(async () => { db = await memoryDb(); });

const seed = async () => {
  await db.saveSpecs(new Map([['u-a', { spec, score: 0.9, persist: 0.1, influence: null, generation: 7, accepted: 3, fit_key: 'k' }]]), 1000);
  await db.set('base_play', 'manual');
  await db.set('central_paused', true);
  await db.subscribeRelay({ uuid: 'r1', stream_name: 's', provider_pubkey: 'p'.repeat(64), name: 'S', cadence_seconds: 600, now: 50, predict: true });
  await db.setRelayPredPlace('r1', 40, 12);
};

describe('the models on their own', () => {
  test('out and back in, into another database', async () => {
    await seed();
    const file = await modelsFile(db, SERVICE, 'then');
    expect(file).toMatchObject({ kind: 'satori-models', v: 1, at: 'then', service: SERVICE });
    const other = await memoryDb();
    expect(await putModels(other, JSON.stringify(file), SERVICE)).toBe(1); // its JSON text too
    expect((await other.specs()).get('u-a')).toMatchObject({ spec, score: 0.9, generation: 7, accepted: 3, fit_key: 'k' });
    expect((await modelsFile(other, SERVICE, 'then')).models).toEqual(file.models);
  });
  test("refuses what isn't a models file, a bad row, and another Satori Service's uuids", async () => {
    await expect(putModels(db, { kind: 'x' }, SERVICE)).rejects.toThrow('Not a Satori models file.');
    const file = { kind: 'satori-models', v: 1, service: SERVICE, models: [] };
    await expect(putModels(db, { ...file, service: 'https://other' }, SERVICE)).rejects.toThrow('another Satori Service');
    await expect(putModels(db, { ...file, models: [{ uuid: 'u', spec: null, generation: 0, accepted: 0 }] }, SERVICE)).rejects.toThrow('not one: u');
    expect((await db.specs()).size).toBe(0);
  });
});

describe('everything but the keys', () => {
  const to = { chain: 8453, service: SERVICE, favorites: [3, 1] };
  test('settings, subscriptions with their `_pred` place, and the models come back; JSON all the way', async () => {
    await seed();
    const data = JSON.parse(JSON.stringify(await dataOf(db, to)));
    expect(data.favorites).toEqual([3, 1]);
    const other = await memoryDb();
    expect(await putData(other, data, { chain: 8453, defaultService: SERVICE })).toBe(true);
    expect([await other.get('base_play'), await other.get('central_paused')]).toEqual(['manual', true]);
    expect((await other.specs()).size).toBe(1);
    expect(await other.relayStream('r1')).toMatchObject({ active: true, predict: true, name: 'S' });
    expect(Number((await other.relayStream('r1')).pred_seq)).toBe(12);
    expect(Number((await other.relayStream('r1')).pred_created_at)).toBe(40);
  });
  test('a file from another chain brings nothing', async () => {
    await seed();
    const data = await dataOf(db, to);
    const other = await memoryDb();
    expect(await putData(other, data, { chain: 84532, defaultService: SERVICE })).toBe(false);
    expect(await other.get('base_play')).toBeUndefined();
    expect((await other.specs()).size).toBe(0);
  });
  test('models for another Satori Service stay out; the rest comes in', async () => {
    await seed();
    const data = await dataOf(db, to);
    const other = await memoryDb(); // one database at a time
    expect(await putData(other, data, { chain: 8453, defaultService: 'https://other' })).toBe(true);
    expect((await other.specs()).size).toBe(0);
    expect(await other.get('base_play')).toBe('manual');
  });
});
