# Words people see

One vocabulary for everything Satori shows people: the Satori app, Satori Lite and the website.
Code identifiers keep their names. The rules behind it: `/code/Satori/CLAUDE.md` "Names".

| Say | What it is | Never say |
|---|---|---|
| Satori Service ("Service") | central, Satori's server; free to submit to | central, server, Satori Network |
| Satori Network ("Network") | the Nostr relays; one of them is "a relay" | the relay network, Satori relays |
| Satori contract ("Contract") | the Base contracts; they cost gas. Base stays the chain's name | stake on Base, predict on Base |
| the Satori app | the browser app, app.satorinet.io | neuron, for the product |
| Satori Lite | the app people run in Docker (satorinet/satori-lite) | Satori Neuron, Neuron Dashboard |
| wallet | the person's key: holds the funds, sealed with the passphrase | vault, identity |
| alias | the app's automated signing key, unencrypted; replaced only if the device is compromised | identity, wallet pubkey |
| Nostr key | the key that signs on the Satori Network | Nostr identity |
| passphrase | what seals the wallet | password |
| Unlock, Lock | enter the passphrase; wipe the wallet from memory | log in, Logout, logged out |
| Backup, Restore | save the wallet; bring it back | Download Wallet, Import Wallet |
| stake with, unstake | give a wallet's prediction power to a pool or an app (`delegatePredictionPower`) | stake to, Pool Staking |
| held, free to move | SATORI in a stake, and not | locked, unlocked, for tokens |
| reward address | where the Service sends rewards instead of the wallet; nothing to do with staking | |
| rewards | what the Service and the contract pay | earned, earnings |

Lock and Unlock are only ever the wallet's passphrase.
