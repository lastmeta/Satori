// Minimal ABIs: only what the app calls (docs/design/base.md). Signatures as
// deployed (D6; abi.test.js checks each against a snapshot of that build,
// test/fixtures/abi-deployed.json, and online against the deployed code; the
// contracts' newer builds run ahead of the chain) and as Satori Lite declares them
// (base_predict.py:29-125, base_claim.py:19-76). Every ABI carries the
// errors a call can bubble up, so a simulate names the reason.
import { parseAbi } from 'viem';

const ERRORS = [
  'error EmptyBatch()', 'error Delegated()', 'error AlreadyPredicted()', 'error Locked()', 'error UnknownStream()',
  'error BadDirection()', 'error DuplicatePrediction()', 'error EmptyStream()', 'error StaleValue()',
  'error DelegateActive()', 'error DelegatorNotAllowed()', 'error CapabilityDisabled()', 'error AlreadySet()',
  'error NothingToClaim()', 'error InvalidProof()', 'error BudgetExceeded()', 'error Unauthorized()',
  'error InvalidPredictorFee()', 'error ClaimDelegatedAway()', 'error BadInput()', 'error Reentrancy()',
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error ERC20InvalidReceiver(address receiver)',
];
const abi = (...items) => parseAbi([...items, ...ERRORS]);

export const engineAbi = abi(
  'struct Request { uint32 gameId; bytes payload; }',
  'function predictMultipleWithPayloads(Request[] requests)',
  'function predictedStreamsCount(address, uint256) view returns (uint256)',
);

export const gamesAbi = abi('function binaryGameByStream(uint32) view returns (uint32)');

export const registryAbi = abi(
  'function getAllDataStreams() view returns (uint32[])',
  'function getLatestUpdateInfo(uint32 streamId) view returns (uint16 count, uint64 latestHour, uint64 lastUpdateTimestamp, uint24 minCadenceMinutes)',
  'function getHistoryPage(uint32 streamId, uint256 offset, uint256 limit) view returns (int232[] values, uint24[] entryHours, uint16 total)',
  'function isNamedStream(uint32) view returns (bool)',
);

export const hubAbi = abi(
  'function delegatePredictionPower(address delegate)',
  'function setAllowedDelegator(address allowed)',
  'function allowedDelegator(address) view returns (address)',
  'function claim() returns (uint256)',
);

export const rewardsAbi = abi(
  'function setPredictorFee(uint16 bps)',
  'function effectivePredictorFee(address predictor) view returns (uint16)',
  'function predictionDelegateInfo(address) view returns (address delegate, uint96 power)',
);

export const lensAbi = abi('function getTotalClaimableRewards(address user) view returns (uint256 total, bool complete)');

export const tokenAbi = abi(
  'function balanceOf(address account) view returns (uint256)',
  'function transfer(address to, uint256 value) returns (bool)',
  'function transferLockedUntil(address user) view returns (uint24)',
  'function getCurrentRound() view returns (uint256)',
);

export const merkleAbi = abi(
  'function claimMerkle(uint256 lifetimeEntitlement, bytes32[] proof)',
  'function alreadyMintedTo(address) view returns (uint256)',
);

/** The engine pays a game only while its voting weight is > 0 (SatoriEngine.sol:828). */
export const votingAbi = abi('function weightOf(uint32 gameId) view returns (uint256)');

export const airdropAbi = abi(
  'function claimAirdrop()',
  'function claimableAirdrop(address user) view returns (uint256)',
);

// Multicall3 (the same address on every chain): ETH balances and chain time join the status multicall.
export const multicall3Abi = parseAbi([
  'function getEthBalance(address addr) view returns (uint256 balance)',
  'function getCurrentBlockTimestamp() view returns (uint256 timestamp)',
]);
