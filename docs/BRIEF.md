# Brief for Claude (handoff, 2026-10-19)

Read this first after a context reset. It says where everything is, how the
owner wants work done, what's live, and what's next. The detail lives in the
docs it links to.

## What this is
`/code/Satori/satori` is the Satori neuron as a client-side browser app.
- It's a static site built with Vite, plain JavaScript, ArrowJS, and DuckDB-WASM on OPFS. It's an installable PWA, MIT licensed.
- Repo: `git@github.com:lastmeta/Satori.git`, branch `main`.
- It's live at **https://neuron.satorinet.io**. `satori.satorinet.io` redirects there with a 301.
- The live build talks to the **dev** central (central2), Base Sepolia, and the relay `wss://app.satorinet.io/relay`.
- Agents drive it through `window.satori`. `/llms.txt` is the reference for that, and `/llms-changelog.txt` holds its history.

Read next, in this order:
1. `docs/intent/*.md`: the owner's intent. It's short, so follow it exactly.
2. `docs/design/OVERVIEW.md`: the tree of design docs.
3. `docs/inbox/QUESTIONS.md`: open owner questions.
4. `docs/plans/README.md`: the roadmap.

## How the owner wants work done
The full set is in Claude memory; this is the short version.
- **Essentialism.** Keep it small and correct. Follow Satori Lite's *network behaviour* (central, the contracts, the relays), but not its local formats.
- **Migrate in, never back.** Import and translate what users bring. Don't keep old formats or limits for compatibility's sake.
- **Two keys.** The identity is plaintext and signs on its own. The vault is encrypted with PBKDF2-SHA256 at 600k rounds plus AES-GCM, and holds the funds. The Nostr key is random and plaintext.
- **Base only, no Evrmore.** Central's login is EIP-191. A tiny Evrmore helper remains only if central lacks `vault_base_address`; it has it now.
- **Words people see:**
  - central is the **Satori Network** (free);
  - Nostr is the **Satori relays**;
  - the Base contracts are the **Satori contract** (costs gas);
  - delegating is "**stake with** this neuron" / "Unstake";
  - Lock and Unlock refer only to the vault passphrase;
  - never say "central" or "server" to users.
- **UI rules:**
  - phone first, with a dashboard on desktop;
  - set and forget, answered at a glance;
  - never a silent wait: one moving indicator plus readable steps (0.25 s minimum hold);
  - healthy is green, never gray (sky green at rest, green working, vivid green for "keep it open");
  - an icon only if it's instantly understood or paired with its word.
- **Intent files stay tiny,** in two sections: "In a nutshell" and "Direction now". New owner intent goes into `docs/intent/` first.
- **Scope.** For the MVP the neuron predicts everything it sees. Record long-term ideas, but don't turn them into next steps. Propose whole-setup reviews instead of new features.
- **Recommend on the merits,** and restate the owner's goal before judging it. Never raise legal concerns. Ask one topic at a time, not barrages.
- **Local chains are disposable.** Don't report their resets.
- **Older repos** (central, neuron (Satori Lite), satorilib): work only on the existing `base-upgrade` branch, which the owner calls "base migration". Never create new branches. Never touch `main`.

## Working method that worked
- **Build with background agents.** Use `general-purpose` agents, one task area at a time, so two agents never edit the same files at once.
- **Every build prompt includes the rules below.** The session's `RULES.md` scratch file is gone after a reset.
- **Review before deploying.** Use an independent read-only reviewer that tries to break the work, then send its fixes back to the builder.
- **Deploy and smoke-test live myself,** then report plainly.

**Rules to paste into agent prompts:**
- Read `docs/intent`, `docs/design/OVERVIEW.md` and `llms.txt`. Do the docs first, then TDD with vitest.
- Plain JS. Pin dependencies exactly; add new ones only if essential and at least two weeks old.
- Shared 8-core box, so one heavy suite at a time:
  - `npm test` (vitest `--maxWorkers=2`);
  - `npm run e2e` (Playwright, `--workers=1`, system Chrome, about 20 min);
  - `npm run e2e:pwa`;
  - `npm run e2e:deploy`.
- **Live services:**
  - Prod central (`network.satorinet.io`, box 157.180.104.175) is READ-ONLY.
  - Writes go to central2 or a stub.
  - Nostr writes go only to the test relay on :7778. Satorian is production.
  - No transactions on public chains; use the local fork on :8545.
  - Throwaway keys only.
- **Commits.** Small commits ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, pushed after each one.
- Keep the dev server on :5180 serving HEAD: `nohup npm run dev > .dev.log 2>&1 &`; to restart, `fuser -k 5180/tcp`. Never `pkill -f` with a pattern that matches your own shell.
- Keep `docs/design` and `llms.txt` matching the code.
- Screenshots go to `docs/screenshots/`. Look at them yourself.

## Running things locally
- Dev app: http://localhost:5180. It uses central2, the `/rpc` proxy to the fork on :8545, and the test relay `ws://localhost:7778`.
- Fork: `node scripts/fork.mjs --help` (start, fund, stake helpers, advance, grief, stream).
- Test relay: `node scripts/test-relay.mjs 7778`. Demo provider: `scripts/provider.mjs`.
- Note: the docker daemon is remote (`tcp://docker-daemon:2376`), and `ss`/`dig` aren't installed.

## Deploying neuron.satorinet.io
Full detail is in `docs/design/deploy.md`. The image is built **on central's box**. That build only copies files: no npm runs there.
```sh
cd /code/Satori/satori && ./scripts/deploy-image.sh   # builds dist/ with deploy/build.env (exit 2 without local docker is fine)
SHA=$(git rev-parse --short HEAD); K="-i $HOME/.ssh/id_ed25519 -o BatchMode=yes -o StrictHostKeyChecking=accept-new"
S="ssh $K -p 2222 root@157.180.104.175"
tar -czf /tmp/ctx.tgz dist deploy/Dockerfile deploy/nginx.conf
CSP=$(node --input-type=module -e "import { CSP } from './csp.js'; process.stdout.write(CSP)")
$S 'mkdir -p /root/satori-neuron/ctx && rm -rf /root/satori-neuron/ctx/*'
scp $K -P 2222 /tmp/ctx.tgz root@157.180.104.175:/root/satori-neuron/
$S "cd /root/satori-neuron/ctx && tar -xzf ../ctx.tgz && docker build -q -f deploy/Dockerfile --build-arg CSP=\"$CSP\" -t satori-neuron:$SHA -t satori-neuron:latest . && docker rm -f satori-neuron && docker run -d --name satori-neuron --network central-lite_default --restart unless-stopped satori-neuron:$SHA"
curl -sI https://neuron.satorinet.io/ ; curl -s -o /dev/null -w "%{http_code}\n" https://network.satorinet.io/   # app up, prod untouched
```
- Then run a smoke test with a fresh Playwright profile: setup → Predicting, and central2 accepts N of N.
- nginx: `/root/nginx/nginx.conf` on central. It's a single-file bind mount, so back it up first and run `docker exec nginx-proxy nginx -t` before any reload.
- TLS: one certificate for both names, renewed by certbot's timer.
- DNS is in Cloudflare. The token is in `/code/Satori/contract/.env` (`CLOUDFLARE_*`).

## Other machines and repos
- **Dev central (central2):**
  - ssh: `ssh -i ~/.ssh/id_ed25519 -p 1983 root@88.99.70.153` (hostname `central-dev`).
  - Code is in `~/central-lite` on `base-upgrade`.
  - Deploy: `cd ~/central-lite && ./devbox/deploy-devbox.sh` (it refuses if prod secrets are present).
  - DB: `docker exec -i satori-db psql -U satori -d satori`.
  - The owner allows deploying here.
- **Central `base-upgrade`, done this session and live on dev:**
  - `bc043d2`: observations history endpoint;
  - `d5984b2` / `f4d72f5`: EIP-191 login, with Evrmore as a marked transitional branch; `docs/issues/remove-evrmore-login.md` says when to remove it;
  - `d8a2085`: register and login return `vault_base_address`.
- **Satori Lite / satorilib `base-upgrade`:** `bb945df` / `5028913` sign login with EIP-191 only (v3.2.14). The `:base-test` image still predates this and needs a rebuild.
- **Contracts:** `/code/Satori/contract` (branch `humble`) is owned by another Claude session, **code-37**. Don't edit that tree; coordinate with SendMessage.
  - The token-hook out-of-gas root fix is B1 `86e2bdb3` on humble, and goes live with D7.
  - The gas-starvation audit is in `e7fb3d94`.

## State at handoff (deployed `b004d5a`)
- **Built and live:**
  - keys and import/backup;
  - the Satori Network flow: register, poll, submit, history backfill;
  - the engine: `bvar` multivariate with evolving specs, training pass, Retrain with a held-out check;
  - Nostr: subscribe, intake, `_pred`, announce, NIP-65;
  - Base: stake/unstake, daily batch with the tie rule "follow the last move", claims (the Network drop is now counted in claimable), sends with a review step;
  - the Home health dashboard, the Models tab, PWA, themes, auto-lock;
  - all 10 fixes from the 2026-10-19 four-part review.
- **Tests:** 910 unit, 54 e2e, 4 PWA, 2 deploy, all passing.
- The review page is https://claude.ai/artifact/9QJGWpDaVxSsaF4F6GuGgW (private).

## What's next
**1. The launch path (owner and team; decisions already made: D7 first; stagger measured before acting; pools re-keyed on Base in central):**
1. D7 full redeploy from humble (includes B1); load the airdrop; set the off-chain budget; repoint the indexer and relayer.
2. Prod central:
   - move the box's shared `/root/satorilib` to `base-upgrade` (deploys don't update it);
   - **revert test commit `a1f0784`** (stake requirement 0, approval bypassed);
   - merge `base-upgrade` → `main` (fast-forward), then run the 4 migrations and rebuild;
   - set the publisher key, `PUBLISH=1` and `INDEXER_URL`;
   - stop central2 publishing roots;
   - list the wss relay.
3. Release Satori Lite after prod central. Operators restart; there's no auto-update.
4. Browser:
   - set `VITE_CENTRAL_URL` to prod in `deploy/build.env`;
   - carry data from central2 to prod without wiping `model_specs`, by remembering which central the data came from;
   - D7 addresses and the ABI snapshot (`ABI_SNAPSHOT=write`);
   - read `voting` and `lens` without bundling them.

**2. Small open items:**
- Satori Lite still answers DOWN on a tie (a one-line change in its `base_predict.py` if the owner wants it to match; not answered yet).
- Central's stake gate only counts peers with a `reward_address`. It's latent while the requirement is 0, but fix it in central before raising it.

**3. Later, recorded and not scheduled:**
- deeper engine work: deep Retrain search, direction modelling, more data and algorithms;
- central's real-world score shown next to the backtest;
- paid streams and bounties;
- stream roles and pins.

**4. Open questions:** see `docs/inbox/QUESTIONS.md` (D6 interim rewards upgrade, prod routes, wss relay, key derivation for new neurons).
