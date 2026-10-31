// Base mainnet's addresses (contract/satori/deployments/base.json; scripts/repoint-apps.js --network base writes them).
// A build with VITE_CHAIN_ID=8453 uses these (config.js).
export const MAINNET = {
  chainId: 8453,
  chainName: 'Base',
  rpcUrl: 'https://mainnet.base.org',
  explorerUrl: 'https://basescan.org',
  fallbackRpc: 'https://base-rpc.publicnode.com',
  dailyUrl: 'https://games.satorinet.io',
  safeService: 'https://api.safe.global/tx-service/base',
  token: '0xd0a5bFF2789230b0fb1Bd989fc7CE7084c947E17',
  merkle: '0x8d2EcABbDd72C427A62ECe45E30a75B41Eb71E9B',
  airdrop: '0x4Ec6F7a801A3A39Ca5E77C6c0A397C93067Bafa1',
  rewards: '0x965bcCAF7ac896ba5a8FD57d5E9Dc1F044792Be4',
  engine: '0x433aBc7877F37560c50238a09F8F3CA207664e12',
  games: '0xda8f3D153bb620EF676a10EF331B9B3Db4348f81',
  registry: '0x0917659Fb65192B342A0Baf95b25E61Fc71a76F7',
  hub: '0x195083eE270ad89459e8dbF2d40fDFc85fb21327',
  lens: '0x5a81cd45D6832CD6f2b4Ef53694ea07431c96DD5',
  voting: '0xFB38672549c2a7734B562FD83C90B4Ce86Bcd992',
};
