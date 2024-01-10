/**
 * This is an interactive Node.js script that uses the inquirer.js to create and interact
 * with a Delayed Payment contract.
 *
 * This example features:
 * - The use of inquirer.js to create an interactive command line tool
 * - The use of the marlowe-object package to create a contract bundle
 * - How to stake the assets of a contract to a given stake address
 * - How to validate that a Merkleized contract is an instance of a given contract
 * - How to share contract sources between different runtimes
 */
import { mkLucidWallet, WalletAPI } from "@marlowe.io/wallet";
import { mkRuntimeLifecycle } from "@marlowe.io/runtime-lifecycle";
import { Lucid, Blockfrost, C } from "lucid-cardano";
import { readConfig } from "./config.js";
import { datetoTimeout } from "@marlowe.io/language-core-v1";
import {
  contractId,
  ContractId,
  contractIdToTxId,
  stakeAddressBech32,
  StakeAddressBech32,
  Tags,
  transactionWitnessSetTextEnvelope,
  TxId,
} from "@marlowe.io/runtime-core";
import { Address } from "@marlowe.io/language-core-v1";
import { ContractBundle, lovelace } from "@marlowe.io/marlowe-object";
import { input, select } from "@inquirer/prompts";
import { RuntimeLifecycle } from "@marlowe.io/runtime-lifecycle/api";
import {
  AppliedActionResult,
  getApplicableActions,
  mkApplicableActionsFilter,
} from "./experimental-features/applicable-inputs.js";
import arg from "arg";
import { splitAddress } from "./experimental-features/metadata.js";
import { SingleInputTx } from "../../../packages/language/core/v1/dist/esm/transaction.js";
import * as t from "io-ts/lib/index.js";
import { deepEqual } from "@marlowe.io/adapter/deep-equal";

// When this script is called, start with main.
main();

// #region Command line arguments
function parseCli() {
  const args = arg({
    "--help": Boolean,
    "--config": String,
    "-c": "--config",
  });

  if (args["--help"]) {
    printHelp(0);
  }
  function printHelp(exitStatus: number): never {
    console.log("Usage: npm run marlowe-object-flow -- --config <config-file>");
    console.log("");
    console.log("Example:");
    console.log("  npm run marlowe-object-flow -- --config alice.config");
    console.log("Options:");
    console.log("  --help: Print this message");
    console.log(
      "  --config | -c: The path to the config file [default .config.json]"
    );
    process.exit(exitStatus);
  }
  return args;
}

// #endregion

// #region Interactive menu

/**
 * Small command line utility that prints a confirmation message and writes dots until the transaction is confirmed
 * NOTE: If we make more node.js cli tools, we should move this to a common place
 */
async function waitIndicator(wallet: WalletAPI, txId: TxId) {
  process.stdout.write("Waiting for the transaction to be confirmed...");
  const intervalId = setInterval(() => {
    process.stdout.write(".");
  }, 1000);
  await wallet.waitConfirmation(txId);
  clearInterval(intervalId);
  process.stdout.write("\n");
}

/**
 * This is an Inquirer.js validator for bech32 addresses
 * @returns true if the address is valid, or a string with the error message otherwise
 */
function bech32Validator(value: string) {
  try {
    C.Address.from_bech32(value);
    return true;
  } catch (e) {
    return "Invalid address";
  }
}

/**
 * This is an Inquirer.js validator for positive bigints
 * @returns true if the value is a positive bigint, or a string with the error message otherwise
 */
function positiveBigIntValidator(value: string) {
  try {
    if (BigInt(value) > 0) {
      return true;
    } else {
      return "The amount must be greater than 0";
    }
  } catch (e) {
    return "The amount must be a number";
  }
}

/**
 * This is an Inquirer.js validator for dates in the future
 * @returns true if the value is a date in the future, or a string with the error message otherwise
 */
function dateInFutureValidator(value: string) {
  const d = new Date(value);
  if (isNaN(d.getTime())) {
    return "Invalid date";
  }
  if (d <= new Date()) {
    return "The date must be in the future";
  }
  return true;
}

/**
 * This is an Inquirer.js flow to create a contract
 * @param lifecycle An instance of the RuntimeLifecycle
 * @param rewardAddress An optional reward address to stake the contract rewards
 */
async function createContractMenu(
  lifecycle: RuntimeLifecycle,
  rewardAddress?: StakeAddressBech32
) {
  const payee = await input({
    message: "Enter the payee address",
    validate: bech32Validator,
  });
  const amountStr = await input({
    message: "Enter the payment amount in lovelaces",
    validate: positiveBigIntValidator,
  });

  const amount = BigInt(amountStr);

  const depositDeadlineStr = await input({
    message: "Enter the deposit deadline",
    validate: dateInFutureValidator,
  });
  const depositDeadline = new Date(depositDeadlineStr);

  const releaseDeadlineStr = await input({
    message: "Enter the release deadline",
    validate: dateInFutureValidator,
  });
  const releaseDeadline = new Date(releaseDeadlineStr);

  const walletAddress = await lifecycle.wallet.getChangeAddress();
  console.log(
    `Making a delayed payment:\n * from  ${walletAddress}\n * to ${payee}\n * for ${amount} lovelaces\n`
  );
  console.log(
    `The payment must be deposited before ${depositDeadline} and can be released to the payee after ${releaseDeadline}`
  );
  if (rewardAddress) {
    console.log(
      `In the meantime, the contract will stake rewards to ${rewardAddress}`
    );
  }

  const scheme = {
    payFrom: { address: walletAddress },
    payTo: { address: payee },
    amount,
    depositDeadline,
    releaseDeadline,
  };
  const [contractId, txId] = await createContract(
    lifecycle,
    scheme,
    rewardAddress
  );

  console.log(`Contract created with id ${contractId}`);

  await waitIndicator(lifecycle.wallet, txId);

  return contractMenu(lifecycle, scheme, contractId);
}

/**
 * This is an Inquirer.js flow to load an existing contract
 * @param lifecycle
 * @returns
 */
async function loadContractMenu(lifecycle: RuntimeLifecycle) {
  // First we ask the user for a contract id
  const cidStr = await input({
    message: "Enter the contractId",
  });
  const cid = contractId(cidStr);

  // Then we make sure that contract id is an instance of our delayed payment contract
  const scheme = await validateExistingContract(lifecycle, cid);
  if (scheme === "InvalidTags") {
    console.log("Invalid contract, it does not have the expected tags");
    return;
  }
  if (scheme === "InvalidContract") {
    console.log(
      "Invalid contract, it does not have the expected contract source"
    );
    return;
  }

  // If it is, we print the contract details and go to the contract menu
  console.log("Contract details:");
  console.log(`  * Pay from: ${scheme.payFrom.address}`);
  console.log(`  * Pay to: ${scheme.payTo.address}`);
  console.log(`  * Amount: ${scheme.amount} lovelaces`);
  console.log(`  * Deposit deadline: ${scheme.depositDeadline}`);
  console.log(`  * Release deadline: ${scheme.releaseDeadline}`);

  return contractMenu(lifecycle, scheme, cid);
}

/**
 * This is an Inquirer.js flow to interact with a contract
 */
async function contractMenu(
  lifecycle: RuntimeLifecycle,
  scheme: DelayPaymentScheme,
  contractId: ContractId
): Promise<void> {
  // Get and print the contract logical state.
  const inputHistory = await lifecycle.contracts.getInputHistory(contractId);
  const contractState = getState(scheme, new Date(), inputHistory);
  printState(contractState, scheme);

  if (contractState.type === "Closed") return;

  // See what actions are applicable to the current contract state
  const applicableActions = await getApplicableActions(
    lifecycle.restClient,
    contractId
  );
  const myActionsFilter = await mkApplicableActionsFilter(lifecycle.wallet);
  const myActions = applicableActions.filter(myActionsFilter);

  const choices: Array<{
    name: string;
    value: { actionType: string; results?: AppliedActionResult };
  }> = [
    {
      name: "Re-check contract state",
      value: { actionType: "check-state", results: undefined },
    },
    ...myActions.map((action) => {
      switch (action.type) {
        case "Advance":
          return {
            name: "Close contract",
            description:
              contractState.type == "PaymentMissed"
                ? "The payer will receive minUTXO"
                : "The payer will receive minUTXO and the payee will receive the payment",
            value: { actionType: "advance", results: action.applyAction() },
          };

        case "Deposit":
          return {
            name: `Deposit ${action.deposit.deposits} lovelaces`,
            value: { actionType: "deposit", results: action.applyAction() },
          };
        default:
          throw new Error("Unexpected action type");
      }
    }),
    {
      name: "Return to main menu",
      value: { actionType: "return", results: undefined },
    },
  ];

  const action = await select({
    message: "Contract menu",
    choices,
  });
  switch (action.actionType) {
    case "check-state":
      return contractMenu(lifecycle, scheme, contractId);
    case "advance":
    case "deposit":
      if (!action.results) throw new Error("This should not happen");
      console.log("Applying input");
      const txId = await lifecycle.contracts.applyInputs(contractId, {
        inputs: action.results.inputs,
      });
      console.log(`Input applied with txId ${txId}`);
      await waitIndicator(lifecycle.wallet, txId);
      return contractMenu(lifecycle, scheme, contractId);
    case "return":
      return;
  }
}

async function mainLoop(
  lifecycle: RuntimeLifecycle,
  rewardAddress?: StakeAddressBech32
) {
  try {
    while (true) {
      const address = await lifecycle.wallet.getChangeAddress();
      console.log("Wallet address:", address);
      const action = await select({
        message: "Main menu",
        choices: [
          { name: "Create a contract", value: "create" },
          { name: "Load contract", value: "load" },
          { name: "Exit", value: "exit" },
        ],
      });
      switch (action) {
        case "create":
          await createContractMenu(lifecycle, rewardAddress);
          break;
        case "load":
          await loadContractMenu(lifecycle);
          break;
        case "exit":
          process.exit(0);
      }
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes("closed the prompt")) {
      process.exit(0);
    } else {
      throw e;
    }
  }
}
// #endregion

// #region Delay Payment Contract
/**
 * These are the parameters of the contract
 */
interface DelayPaymentScheme {
  /**
   * Who is making the delayed payment
   */
  payFrom: Address;
  /**
   * Who is receiving the payment
   */
  payTo: Address;
  /**
   * The amount of lovelaces to be paid
   */
  amount: bigint;
  /**
   * The deadline for the payment to be made. If the payment is not made by this date, the contract can be closed
   */
  depositDeadline: Date;
  /**
   * A date after the payment can be released to the receiver.
   * NOTE: An empty transaction must be done to close the contract
   */
  releaseDeadline: Date;
}

function mkDelayPayment(scheme: DelayPaymentScheme): ContractBundle {
  return {
    main: "initial-deposit",
    bundle: [
      {
        label: "release-funds",
        type: "contract",
        value: {
          when: [],
          timeout: datetoTimeout(scheme.releaseDeadline),
          timeout_continuation: "close",
        },
      },
      {
        label: "initial-deposit",
        type: "contract",
        value: {
          when: [
            {
              case: {
                party: scheme.payFrom,
                deposits: scheme.amount,
                of_token: lovelace,
                into_account: scheme.payTo,
              },
              then: {
                ref: "release-funds",
              },
            },
          ],
          timeout: datetoTimeout(scheme.depositDeadline),
          timeout_continuation: "close",
        },
      },
    ],
  };
}
// #endregion

// #region Delay Payment State
/**
 * The delay payment contract can be in one of the following logical states:
 */
type DelayPaymentState =
  | InitialState
  | PaymentDeposited
  | PaymentMissed
  | PaymentReady
  | Closed;
/**
 * In the initial state the contract is waiting for the payment to be deposited
 */
type InitialState = {
  type: "InitialState";
};

/**
 * After the payment is deposited, the contract is waiting for the payment to be released
 */
type PaymentDeposited = {
  type: "PaymentDeposited";
};

/**
 * If the payment is not deposited by the deadline, the contract can be closed.
 * NOTE: It is not necesary to close the contract, as it will consume transaction fee (but it will release
 *       the minUTXO)
 */
type PaymentMissed = {
  type: "PaymentMissed";
};

/**
 * After the release deadline, the payment is still in the contract, and it is ready to be released.
 */
type PaymentReady = {
  type: "PaymentReady";
};

type Closed = {
  type: "Closed";
  result: "Missed deposit" | "Payment released";
};

function printState(state: DelayPaymentState, scheme: DelayPaymentScheme) {
  switch (state.type) {
    case "InitialState":
      console.log(
        `Waiting ${scheme.payFrom.address} to deposit ${scheme.amount}`
      );
      break;
    case "PaymentDeposited":
      console.log(
        `Payment deposited, waiting until ${scheme.releaseDeadline} to be able to release the payment`
      );
      break;
    case "PaymentMissed":
      console.log(
        `Payment missed on ${scheme.depositDeadline}, contract can be closed to retrieve minUTXO`
      );
      break;
    case "PaymentReady":
      console.log(`Payment ready to be released`);
      break;
    case "Closed":
      console.log(`Contract closed: ${state.result}`);
      break;
  }
}

function getState(
  scheme: DelayPaymentScheme,
  currentTime: Date,
  history: SingleInputTx[]
): DelayPaymentState {
  if (history.length === 0) {
    if (currentTime < scheme.depositDeadline) {
      return { type: "InitialState" };
    } else {
      return { type: "PaymentMissed" };
    }
  } else if (history.length === 1) {
    // If the first transaction doesn't have an input, it means it was used to advace a timeouted contract
    if (!history[0].input) {
      return { type: "Closed", result: "Missed deposit" };
    }
    if (currentTime < scheme.releaseDeadline) {
      return { type: "PaymentDeposited" };
    } else {
      return { type: "PaymentReady" };
    }
  } else if (history.length === 2) {
    return { type: "Closed", result: "Payment released" };
  } else {
    throw new Error("Wrong state/contract, too many transactions");
  }
}

// #endregion

const mkDelayPaymentTags = (schema: DelayPaymentScheme) => {
  const tag = "DELAY_PYMNT-1";
  const tags = {} as Tags;

  tags[`${tag}-from-0`] = splitAddress(schema.payFrom)[0];
  tags[`${tag}-from-1`] = splitAddress(schema.payFrom)[1];
  tags[`${tag}-to-0`] = splitAddress(schema.payTo)[0];
  tags[`${tag}-to-1`] = splitAddress(schema.payTo)[1];
  tags[`${tag}-amount`] = schema.amount;
  tags[`${tag}-deposit`] = schema.depositDeadline;
  tags[`${tag}-release`] = schema.releaseDeadline;
  return tags;
};

const extractSchemeFromTags = (
  tags: unknown
): DelayPaymentScheme | undefined => {
  const tagsGuard = t.type({
    "DELAY_PYMNT-1-from-0": t.string,
    "DELAY_PYMNT-1-from-1": t.string,
    "DELAY_PYMNT-1-to-0": t.string,
    "DELAY_PYMNT-1-to-1": t.string,
    "DELAY_PYMNT-1-amount": t.bigint,
    "DELAY_PYMNT-1-deposit": t.string,
    "DELAY_PYMNT-1-release": t.string,
  });

  if (!tagsGuard.is(tags)) {
    return;
  }

  return {
    payFrom: {
      address: `${tags["DELAY_PYMNT-1-from-0"]}${tags["DELAY_PYMNT-1-from-1"]}`,
    },
    payTo: {
      address: `${tags["DELAY_PYMNT-1-to-0"]}${tags["DELAY_PYMNT-1-to-1"]}`,
    },
    amount: tags["DELAY_PYMNT-1-amount"],
    depositDeadline: new Date(tags["DELAY_PYMNT-1-deposit"]),
    releaseDeadline: new Date(tags["DELAY_PYMNT-1-release"]),
  };
};

async function createContract(
  lifecycle: RuntimeLifecycle,
  schema: DelayPaymentScheme,
  rewardAddress?: StakeAddressBech32
): Promise<[ContractId, TxId]> {
  const contractBundle = mkDelayPayment(schema);
  const tags = mkDelayPaymentTags(schema);
  // TODO: PLT-9089: Modify runtimeLifecycle.contracts.createContract to support bundle (calling createContractSources)
  const contractSources =
    await lifecycle.restClient.createContractSources(contractBundle);
  const walletAddress = await lifecycle.wallet.getChangeAddress();
  const unsignedTx = await lifecycle.restClient.buildCreateContractTx({
    sourceId: contractSources.contractSourceId,
    tags,
    changeAddress: walletAddress,
    stakeAddress: rewardAddress,
    minimumLovelaceUTxODeposit: 3_000_000,
    version: "v1",
  });
  const signedCborHex = await lifecycle.wallet.signTx(unsignedTx.tx.cborHex);
  await lifecycle.restClient.submitContract(
    unsignedTx.contractId,
    transactionWitnessSetTextEnvelope(signedCborHex)
  );
  const txId = contractIdToTxId(unsignedTx.contractId);
  return [unsignedTx.contractId, txId];
  //----------------
}

type ValidationResults = "InvalidTags" | "InvalidContract" | DelayPaymentScheme;

/**
 * This function checks if the contract with the given id is an instance of the delay payment contract
 * @param lifecycle
 * @param contractId
 * @returns
 */
async function validateExistingContract(
  lifecycle: RuntimeLifecycle,
  contractId: ContractId
): Promise<ValidationResults> {
  // First we try to fetch the contract details and the required tags
  const contractDetails =
    await lifecycle.restClient.getContractById(contractId);

  const scheme = extractSchemeFromTags(contractDetails.tags);

  if (!scheme) {
    return "InvalidTags";
  }

  // If the contract seems to be an instance of the contract we want (meanin, we were able
  // to retrieve the contract scheme) we check that the actual initial contract has the same
  // sources.
  // This has 2 purposes:
  //   1. Make sure we are interacting with the expected contract
  //   2. Share the same sources between different Runtimes.
  //      When a contract source is uploaded to the runtime, it merkleizes the source code,
  //      but it doesn't share those sources with other runtime instances. One option would be
  //      to download the sources from the initial runtime and share those with another runtime.
  //      Or this option which doesn't require runtime to runtime communication, and just requires
  //      the dapp to be able to recreate the same sources.
  const contractBundle = mkDelayPayment(scheme);
  const { contractSourceId } =
    await lifecycle.restClient.createContractSources(contractBundle);
  const initialContract = await lifecycle.restClient.getContractSourceById({
    contractSourceId,
  });

  if (!deepEqual(initialContract, contractDetails.initialContract)) {
    return "InvalidContract";
  }
  return scheme;
}

async function main() {
  const args = parseCli();
  const config = await readConfig(args["--config"]);
  const lucid = await Lucid.new(
    new Blockfrost(config.blockfrostUrl, config.blockfrostProjectId),
    config.network
  );
  lucid.selectWalletFromSeed(config.seedPhrase);
  const rewardAddressStr = await lucid.wallet.rewardAddress();
  const rewardAddress = rewardAddressStr
    ? stakeAddressBech32(rewardAddressStr)
    : undefined;
  const runtimeURL = config.runtimeURL;

  const wallet = mkLucidWallet(lucid);

  const lifecycle = mkRuntimeLifecycle({
    runtimeURL,
    wallet,
  });
  try {
    await mainLoop(lifecycle, rewardAddress);
  } catch (e) {
    console.log(`Error : ${JSON.stringify(e, null, 4)}`);
  }
}