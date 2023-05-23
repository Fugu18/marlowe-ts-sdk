import { DecodingError } from '../common/codec';
import { ContractDetails } from '../contract/details';
import { ContractId } from '../contract/id';
import { AxiosRestClient, RestAPI } from '../endpoints';
import { ApplyInputsPayload, InitialisePayload, WithdrawPayload } from '../write/command';
import * as Command from '../write/command';
import * as Transaction from '../contract/transaction/details';
import * as Withdrawal from '../contract/withdrawal/details';
import * as T from 'fp-ts/Task'
import * as TE from 'fp-ts/TaskEither'
import { pipe } from 'fp-ts/lib/function';
import { MarloweTxCBORHex, HexTransactionWitnessSet } from '../common/textEnvelope';
import { AddressesAndCollaterals, WalletAPI } from '.';
import { AddressBech32, deserializeAddress } from '../common/address';
import * as A from 'fp-ts/Array'

import * as O from 'fp-ts/Option'
import { TxOutRef } from '../common/tx/outRef';
import { deserializeCollateral } from '../common/tx/collateral';



export const getExtensionInstance : (extensionName : string) => T.Task<WalletAPI> = (extensionName) =>  
    pipe(() => window.cardano[extensionName.toLowerCase()].enable()
        ,T.map (extensionCIP30Instance => 
            ({ waitConfirmation: waitConfirmation
             , signTxTheCIP30Way : signMarloweTx(extensionCIP30Instance)
             , getChangeAddress : fetchChangeAddress(extensionCIP30Instance)
             , getUsedAddresses : fetchUsedAddresses(extensionCIP30Instance)
             , getCollaterals : fetchCollaterals(extensionCIP30Instance) 
            })) )


const waitConfirmation : (txHash : string ) => TE.TaskEither<Error,boolean> = (txHash) => TE.of (true) 

const signMarloweTx : (extensionCIP30Instance : BroswerExtensionCIP30Api) => (cborHex :MarloweTxCBORHex) => TE.TaskEither<Error,HexTransactionWitnessSet> =
  (extensionCIP30Instance) => (cborHex) => pipe( () => extensionCIP30Instance.signTx (cborHex,false), TE.fromTask)


const fetchChangeAddress : (extensionCIP30Instance : BroswerExtensionCIP30Api)  => T.Task<AddressBech32> =
  (extensionCIP30Instance) => 
    pipe( T.Do
        , T.bind('changeAddress',() => pipe(() => extensionCIP30Instance.getChangeAddress ()))
        , T.map (({changeAddress}) => deserializeAddress(changeAddress))
        )

const fetchUsedAddresses : (extensionCIP30Instance : BroswerExtensionCIP30Api)  => T.Task<AddressBech32[]> =
        (extensionCIP30Instance) => 
          pipe( T.Do
              , T.bind('usedAddresses',() => pipe(() => extensionCIP30Instance.getUsedAddresses ()))
              , T.map (({usedAddresses}) => pipe( usedAddresses, A.map(deserializeAddress)))
              )

const fetchCollaterals : (extensionCIP30Instance : BroswerExtensionCIP30Api)  => T.Task<TxOutRef[]> =
              (extensionCIP30Instance) => 
                pipe( T.Do
                    , T.bind('collaterals'  ,() => pipe(() => extensionCIP30Instance.experimental.getCollateral()))
                    , T.map (({collaterals}) =>  collaterals == undefined ? [] : pipe( collaterals, A.map(deserializeCollateral)))
                    )     

type DataSignature = {
    signature: string;
    key: string;
};

type BroswerExtensionCIP30Api = {
    experimental: ExperimentalFeatures;
    getBalance(): Promise<string>;
    getChangeAddress(): Promise<string>;
    getNetworkId(): Promise<number>;
    getRewardAddresses(): Promise<string[]>;
    getUnusedAddresses(): Promise<string[]>;
    getUsedAddresses(): Promise<string[]>;
    getUtxos(): Promise<string[] | undefined>;
    signData(address: string, payload: string): Promise<DataSignature>;
    signTx(tx: string, partialSign: boolean): Promise<string>;
    submitTx(tx: string): Promise<string>;
  };
  
type ExperimentalFeatures = {
    getCollateral(): Promise<string[] | undefined>;
  };