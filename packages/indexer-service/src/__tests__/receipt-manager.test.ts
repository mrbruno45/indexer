// TODO: (Liam) Provide instructions for setting up test to use local PostgreSQL
//              This must run _before_ any server-wallet code gets imported
// ❯ cd node_modules/@statechannels/server-wallet
// ❯ SERVER_DB_NAME=indexer-sw NODE_ENV=development yarn db:migrate
//
process.env.SERVER_DB_NAME = 'indexer-sw'

import { constants } from 'ethers'

import { createLogger } from '@graphprotocol/common-ts'
import {
  SignedState,
  makeDestination,
  SimpleAllocation,
  BN,
} from '@statechannels/wallet-core'

import { Message as WireMessage } from '@statechannels/client-api-schema'

// This is a bit awkward, but is convenient to create reproducible tests
import serverWalletKnex from '@statechannels/server-wallet/lib/src/db/connection'
import { seedAlicesSigningWallet } from '@statechannels/server-wallet/lib/src/db/seeds/1_signing_wallet_seeds'

import { ReceiptManager, PayerMessage } from '../receipt-manager'
import {
  mockCreatedChannelMessage,
  mockCreatedZeroChannelMessage,
  mockQueryRequestMessage,
  mockChannelId,
  mockSCAttestation,
  mockAppData,
  mockPostFundMessage,
  mockCloseChannelMessage,
} from '../__mocks__/receipt-manager.mocks'
import { toJS, StateType } from '@statechannels/graph'

const logger = createLogger({ name: 'receipt-manager.test.ts' })

let receiptManager: ReceiptManager

function stateFromMessage(messages: WireMessage[] | undefined, index = 0): SignedState {
  expect(messages).toBeDefined()
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return (messages![index] as PayerMessage).data.signedStates![0]
}

beforeEach(async () => {
  logger.info(`Truncating ${process.env.SERVER_DB_NAME}; Seeding new SigningWallet`)
  await seedAlicesSigningWallet(serverWalletKnex)
  receiptManager = new ReceiptManager(logger, '')
})

afterAll(async () => {
  await serverWalletKnex.destroy()
})

describe('ReceiptManager', () => {
  it('can call joinChannel and auto-sign funding state with non-zero allocations channel', async () => {
    const outbound = await receiptManager.inputStateChannelMessage(
      mockCreatedChannelMessage(),
    )

    const state1 = stateFromMessage(outbound)
    const state2 = stateFromMessage(outbound, 1)
    expect(state1).toMatchObject({ turnNum: 0 })
    expect(state2).toMatchObject({ turnNum: 3 })
  })

  it('can call joinChannel and auto-sign funding state with zero allocations channel', async () => {
    const outbound = await receiptManager.inputStateChannelMessage(
      mockCreatedZeroChannelMessage(),
    )

    const state1 = stateFromMessage(outbound)
    const state2 = stateFromMessage(outbound, 1)
    expect(state1).toMatchObject({ turnNum: 0 })
    expect(state2).toMatchObject({ turnNum: 3 })
  })

  it('can validate a payment', async () => {
    await receiptManager.inputStateChannelMessage(mockCreatedZeroChannelMessage())
    await expect(
      receiptManager.inputStateChannelMessage(mockQueryRequestMessage()),
    ).resolves.not.toThrow()
  })

  it('can provide attestation response', async () => {
    await receiptManager.inputStateChannelMessage(mockCreatedChannelMessage())
    await receiptManager.inputStateChannelMessage(mockQueryRequestMessage())

    const attestationMessage = await receiptManager.provideAttestation(
      mockChannelId,
      mockSCAttestation(),
    )

    const nextState = stateFromMessage(attestationMessage)
    const appData = toJS(nextState.appData)
    expect(appData.constants).toEqual(mockAppData().constants)
    expect(appData.variable.responseCID).toEqual(mockSCAttestation().responseCID)
    expect(appData.variable.stateType).toEqual(StateType.AttestationProvided)
    expect((nextState.outcome as SimpleAllocation).allocationItems).toEqual([
      { amount: BN.from(99), destination: makeDestination(constants.AddressZero) },
      { amount: BN.from(1), destination: makeDestination(constants.AddressZero) },
    ])
  })

  it('can deny a query', async () => {
    await receiptManager.inputStateChannelMessage(mockCreatedChannelMessage())
    await receiptManager.inputStateChannelMessage(mockQueryRequestMessage())
    const outbound = await receiptManager.declineQuery(mockChannelId)

    const nextState = stateFromMessage(outbound)
    const appData = toJS(nextState.appData)
    expect(appData.constants).toEqual(mockAppData().constants)
    expect(appData.variable.stateType).toEqual(StateType.QueryDeclined)
    expect(nextState).toMatchObject({ turnNum: 5 })
  })

  it('can accept a channel closure', async () => {
    await receiptManager.inputStateChannelMessage(mockCreatedChannelMessage())
    await receiptManager.inputStateChannelMessage(mockPostFundMessage())
    const outbound = await receiptManager.inputStateChannelMessage(
      mockCloseChannelMessage(),
    )

    const nextState = stateFromMessage(outbound)
    expect(nextState).toMatchObject({ turnNum: 4, isFinal: true })
  })
})