// What a backup file carries besides the keys (docs/design/wallets.md#a-whole-backup), and the models on their own: so an
// agent whose browser is wiped between visits comes back as it left. Not carried: what the app reads again (the
// streams' history, the track records), and the activity log, which belongs to this browser.
export const MODELS_FILE = 'satori-models';

/** The settings and state in meta that nothing else can give back. market: the payment channels' vouchers. */
const KEPT = ['base_play', 'central_paused', 'central_url', 'base_rpc_url', 'base_max_fee_gwei', 'nostr_relays', 'nostr_central_write',
  'nostr_own', 'market', 'referrer', 'base_last_batch', 'game_last_play'];

const asNumber = (v) => (v == null ? null : Number(v)); // the database's BIGINT, which JSON can't carry

/** The evolved models, one row per stream, not secret: they hold no key. `service`: the Satori Service whose uuids they name. */
export async function modelsFile(db, service, at = new Date().toISOString()) {
  const models = [...(await db.specs())].map(([uuid, r]) => ({ uuid, spec: r.spec, score: asNumber(r.score), persist: asNumber(r.persist), influence: r.influence,
    generation: asNumber(r.generation), accepted: asNumber(r.accepted), fit_key: r.fit_key }));
  return { kind: MODELS_FILE, v: 1, at, service, models };
}

/** modelsFile()'s file into this database: each stream's model replaced. Another Service's uuids are refused. → how many */
export async function putModels(db, file, service, at = Math.floor(Date.now() / 1000)) {
  const f = typeof file === 'string' ? JSON.parse(file) : file;
  if (f?.kind !== MODELS_FILE || f.v !== 1 || !Array.isArray(f.models)) throw new Error('Not a Satori models file.');
  if (f.service !== service) throw new Error(`These models are for another Satori Service: ${f.service}.`);
  const bad = f.models.find((m) => typeof m?.uuid !== 'string' || !m.uuid || typeof m.spec !== 'object' || m.spec === null || !Number.isInteger(m.generation) || !Number.isInteger(m.accepted));
  if (bad) throw new Error(`A model in this file is not one: ${bad?.uuid ?? bad}.`);
  await db.saveSpecs(new Map(f.models.map(({ uuid, ...m }) => [uuid, m])), at);
  return f.models.length;
}

/** Everything but the keys, for the sealed file. `chain`: a build's chain id; `favorites`: the Game tab's stars. */
export async function dataOf(db, { chain, service, favorites = [] }) {
  const settings = {};
  for (const key of KEPT) {
    const v = await db.get(key);
    if (v != null) settings[key] = v;
  }
  const subscriptions = (await db.relayStreams({ active: true })).map((s) => ({ uuid: s.uuid, stream_name: s.stream_name, provider_pubkey: s.provider_pubkey,
    name: s.name, cadence_seconds: asNumber(s.cadence_seconds), predict: !!s.predict, now: asNumber(s.subscribed_at), pred_created_at: asNumber(s.pred_created_at), pred_seq: asNumber(s.pred_seq) }));
  return { chain, settings, subscriptions, favorites, models: await modelsFile(db, service) };
}

/**
 * dataOf()'s object into a new database, before the neuron starts. A file from another chain's build brings none of it:
 * its streams, Service and addresses aren't this one's. → true when it was put in.
 */
export async function putData(db, data, { chain, defaultService }) {
  if (data?.chain !== chain) return false;
  for (const key of KEPT) if (data.settings?.[key] != null) await db.set(key, data.settings[key]);
  for (const s of data.subscriptions ?? []) await db.subscribeRelay(s);
  const service = (await db.get('central_url')) || defaultService;
  if (data.models?.service === service) await putModels(db, data.models, service);
  return true;
}
