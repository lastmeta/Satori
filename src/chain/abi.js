// Minimal ABIs: only what the app calls (docs/design/base.md). Signatures as
// deployed (D7; abi.test.js checks each against a snapshot of that build,
// test/fixtures/abi-deployed.json, and online against the deployed code; the
// contracts' newer builds may run ahead of the chain) and as Satori Lite declares them
// (base_predict.py:29-125, base_claim.py:19-76). Every ABI carries the
// errors a call can bubble up, so a simulate names the reason.
import { parseAbi } from 'viem';

const ERRORS = [
  'error EmptyBatch()', 'error Delegated()', 'error AlreadyPredicted()', 'error Locked()', 'error UnknownStream()',
  'error BadDirection()', 'error DuplicatePrediction()', 'error EmptyStream()', 'error StaleValue()',
  'error DelegateActive()', 'error DelegatorNotAllowed()', 'error CapabilityDisabled()', 'error AlreadySet()',
  'error NothingToClaim()', 'error InvalidProof()', 'error BudgetExceeded()', 'error Unauthorized()',
  'error InvalidPredictorFee()', 'error InvalidReferral()', 'error ClaimDelegatedAway()', 'error BadInput()', 'error Reentrancy()',
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error ERC20InvalidReceiver(address receiver)',
  // a transfer whose hook ran out of gas reverts instead of skipping a staker's sync (contract humble 86e2bdb3, live
  // since D7; docs/issues/token-hook-gas-estimate.md)
  'error HookFailedWithoutReason()',
];
const abi = (...items) => parseAbi([...items, ...ERRORS]);

export const engineAbi = abi(
  'struct Request { uint32 gameId; bytes payload; }',
  'function predictMultipleWithPayloads(Request[] requests)',
  // the same, setting the sender's referral first when it has none (SatoriRewards.setReferralFor: never reverts)
  'function predictMultipleWithReferral(address referrer, Request[] requests)',
  'function predictedStreamsCount(address, uint256) view returns (uint256)',
  // the streak and its S-curve's turning point (SatoriEngine.sol:557, 469, 80): h = max(curveConfig's f, the game's threshold)
  'function streaks(address user, uint32 gameId) view returns (uint256)',
  'function curveConfig() view returns (uint256 f, uint256 g, uint256 r, uint256 b)',
  'function gameStreakState(uint32 gameId) view returns (uint16 threshold, uint40 round)',
);

export const gamesAbi = abi('function binaryGameByStream(uint32) view returns (uint32)');

export const registryAbi = abi(
  'function getAllDataStreams() view returns (uint32[])',
  'function getLatestUpdateInfo(uint32 streamId) view returns (uint16 count, uint64 latestHour, uint64 lastUpdateTimestamp, uint24 minCadenceMinutes, bool named, int232 latestValue)',
  'function getHistoryPage(uint32 streamId, uint256 offset, uint256 limit) view returns (int232[] values, uint24[] entryHours, uint16 total)',
  'function isNamedStream(uint32) view returns (bool)',
  'function getDataStreamInfo(uint32 streamId) view returns (string name, address provider, uint8 streamType, int256 value, uint256 valueHour, bool exists)',
  'function streams(uint256) view returns (address provider, uint8 streamType, uint24 minCadenceMinutes, uint32 adapterId, bool named, bytes config, string name)',
  'function adapter(uint32) view returns (address)',
);

/** A stream adapter's UI descriptor (IStreamAdapterUIDescriptor.sol): how its values read. Must not revert; some adapters lack it. */
export const adapterUiAbi = abi('function valueDisplay(address target, bytes config) view returns (uint8 decimals, string unit, string label)');

export const hubAbi = abi(
  'function delegatePredictionPower(address delegate)',
  'function setAllowedDelegator(address allowed)',
  'function allowedDelegator(address) view returns (address)',
  'function claim() returns (uint256)',
  // anyone may claim the owner's rewards to the owner (D8, contract ce2ce664); elsewhere, only its named claimer.
  // The app's alias claims the wallet's this way.
  'function claimFor(address owner, address recipient) returns (uint256)',
);

export const rewardsAbi = abi(
  'function setPredictorFee(uint16 bps)',
  'function effectivePredictorFee(address predictor) view returns (uint16)',
  'function predictionDelegateInfo(address) view returns (address delegate, uint96 power)',
  'function referral(address) view returns (address)',
  'function setReferral(address ref)',
);

export const lensAbi = abi('function getTotalClaimableRewards(address user) view returns (uint256 total, bool complete)');

export const tokenAbi = abi(
  'function balanceOf(address account) view returns (uint256)',
  'function transfer(address to, uint256 value) returns (bool)',
  'function transferLockedUntil(address user) view returns (uint24)',
  'function getCurrentRound() view returns (uint256)',
  'function PLATFORM_FEE_RECIPIENT() view returns (address)', // the dev fee's splitter tree, its top (docs/design/devfee.md)
);

/**
 * SatoriSplitterImmutable: the dev fee's splitters (docs/design/devfee.md). Not upgradeable, so its own snapshot
 * (test/fixtures/abi-splitter.json, from the contract's build) rather than the deploy's. ETH is the token address(0).
 */
export const splitterAbi = parseAbi([
  'function slotCount() view returns (uint256)',
  'function getSlot(uint256 slotId) view returns (address payee, uint256 shares)',
  'function releasable(address token, uint256 slotId) view returns (uint256)',
  'function withdrawCaller(uint256 slotId) view returns (address)',
  'function totalShares() view returns (uint256)',
  'function authority() view returns (address)',
  'function pendingAuthority() view returns (address)',
  'function rotationThresholdBps() view returns (uint256)',
  'function proposalId(address parent, address newPayee) view returns (bytes32)',
  'function approvedShares(bytes32 proposal) view returns (uint256)',
  'function approved(bytes32 proposal, uint256 slotId) view returns (bool)',
  'function rotationApproved(address parent, address newPayee) view returns (bool)',
  'function withdraw(address token, uint256 slotId) returns (uint256)',
  'function setWithdrawCaller(address caller)',
  'function rotateRecipient(address newPayee)',
  'function approveRotation(address parent, address newPayee)',
  'function revokeRotation(address parent, address newPayee)',
  'function rotateAt(address parent, address newPayee)',
  'function transferAuthority(address newAuthority)',
  'function acceptAuthority()',
  'function renounceAuthority()',
  'error ZeroAddress()', 'error PayeeIsSelf()', 'error AlreadyRecipient()', 'error NotARecipient()', 'error UnknownSlot()',
  'error NothingToWithdraw()', 'error NotAuthority()', 'error NotPendingAuthority()', 'error NotWithdrawCaller()',
  'error AlreadyApproved()', 'error NotApproved()', 'error InsufficientConsent()',
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)', 'error HookFailedWithoutReason()',
]);

export const merkleAbi = abi(
  'function claimMerkle(uint256 lifetimeEntitlement, bytes32[] proof)',
  // by anyone, for `account`: the proof binds the amount to it, and it is paid (D8's upgrade, contract fd7edee3)
  'function claimMerkle(address account, uint256 lifetimeEntitlement, bytes32[] proof)',
  'function alreadyMintedTo(address) view returns (uint256)',
);

/** The engine pays a game only while its voting weight is > 0 (SatoriEngine.sol:828). */
export const votingAbi = abi('function weightOf(uint32 gameId) view returns (uint256)');

export const airdropAbi = abi(
  'function claimAirdrop()',
  // by anyone, for `user`: minted to `user` only (SatoriAirdrop.sol:118-124)
  'function claimAirdropFor(address user)',
  'function claimableAirdrop(address user) view returns (uint256)',
);

// Multicall3 (the same address on every chain): ETH balances and chain time join the status multicall.
export const multicall3Abi = parseAbi([
  'function getEthBalance(address addr) view returns (uint256 balance)',
  'function getCurrentBlockTimestamp() view returns (uint256 timestamp)',
]);

/**
 * PaymentChannels (contract/satori/contracts/channels/PaymentChannels.sol, deployed at config.js PAYMENT_CHANNELS;
 * docs/design/market.md). abi.test.js checks its own items against test/fixtures/abi-channels.json, a snapshot of its
 * build. The token's errors a call can bubble up (SATORI's lock and hook, OpenZeppelin's ERC-20 errors) come after.
 */
export const CHANNEL_ERRORS = [
  'error BadInput()', 'error ChannelExists()', 'error UnknownChannel()', 'error ChannelClosed()', 'error NotPayee()',
  'error NotPayer()', 'error NotPayerOrSigner()', 'error NotPayerOrPayee()', 'error BadSignature()', 'error NothingToSettle()', 'error CloseNotRequested()',
  'error CloseNotReady()', 'error UnsupportedToken()', 'error SafeERC20FailedOperation(address token)',
];
export const channelsAbi = parseAbi([
  'struct Channel { address payer; uint96 deposit; address payee; uint96 settled; address token; uint64 closeRequestedAt; bool closed; address signer; }',
  'function open(address payer, address payee, address token, address signer, uint96 deposit, bytes32 salt) returns (bytes32)',
  'function openWithPermit(address payer, address payee, address token, address signer, uint96 deposit, bytes32 salt, uint256 deadline, uint8 v, bytes32 r, bytes32 s) returns (bytes32)',
  'function topUp(bytes32 channelId, uint96 amount)',
  'function settle(bytes32 channelId, uint96 cumulativeAmount, bytes signature)',
  'function settleMany(bytes32[] channelIds, uint96[] cumulativeAmounts, bytes[] signatures) returns (uint256 settledCount)',
  'function close(bytes32 channelId, uint96 cumulativeAmount, bytes signature)',
  'function requestClose(bytes32 channelId)',
  'function cancelClose(bytes32 channelId)',
  'function withdraw(bytes32 channelId)',
  'function withdrawTo(bytes32 channelId, uint96 amount, address to)',
  'function setGrace(bytes32 channelId, uint32 grace)',
  'function setPayout(bytes32 channelId, address payout)',
  'function getTerms(bytes32 channelId) view returns (uint64 grace, address payout)',
  'function getChannel(bytes32 channelId) view returns (Channel)',
  'function computeChannelId(address payer, address payee, address token, address signer, bytes32 salt) pure returns (bytes32)',
  'function voucherDigest(bytes32 channelId, uint96 cumulativeAmount) view returns (bytes32)',
  'function CLOSE_GRACE_PERIOD() view returns (uint64)',
  'event Opened(bytes32 indexed channelId, address indexed payer, address indexed payee, address token, address signer, address funder, bytes32 salt, uint96 deposit)',
  'event ToppedUp(bytes32 indexed channelId, address indexed payer, address indexed payee, address funder, uint96 amount, uint96 deposit)',
  'event Settled(bytes32 indexed channelId, address indexed payer, address indexed payee, uint96 cumulativeAmount, uint96 paid, uint96 settled)',
  'event CloseRequested(bytes32 indexed channelId, address indexed payer, address indexed payee, address by, uint64 graceEnds)',
  'event CloseCancelled(bytes32 indexed channelId, address indexed payer, address indexed payee)',
  'event Closed(bytes32 indexed channelId, address indexed payer, address indexed payee, address by, uint96 settled, uint96 refunded)',
  'event Withdrawn(bytes32 indexed channelId, address indexed payer, address indexed payee, address to, uint96 amount, uint96 settled)',
  'event GraceProposed(bytes32 indexed channelId, address indexed payer, address indexed payee, address by, uint32 grace)',
  'event GraceChanged(bytes32 indexed channelId, address indexed payer, address indexed payee, address by, uint32 grace)',
  'event PayoutSet(bytes32 indexed channelId, address indexed payer, address indexed payee, address payout)',
  ...CHANNEL_ERRORS,
  'error Locked()', 'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)', 'error HookFailedWithoutReason()',
]);

/**
 * Any ERC-20 a channel holds: the allowance, and ERC-2612's permit with its EIP-712 domain (ERC-5267's eip712Domain,
 * else name() and version "1", either checked against DOMAIN_SEPARATOR()). Standard signatures; SATORI has them all.
 */
export const erc20PermitAbi = parseAbi([
  'function approve(address spender, uint256 value) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function nonces(address owner) view returns (uint256)',
  'function name() view returns (string)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)',
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)', 'error Locked()', 'error HookFailedWithoutReason()',
]);
