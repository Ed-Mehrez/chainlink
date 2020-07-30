import { assert } from 'chai'
import { ethers } from 'ethers'
import { FluxAggregatorFactory } from '@chainlink/contracts/ethers/v0.6/FluxAggregatorFactory'
import { contract, helpers as h, matchers } from '@chainlink/test-helpers'
import ChainlinkClient from '../test-helpers/chainlinkClient'
import fluxMonitorJobTemplate from '../fixtures/flux-monitor-job'
import * as t from '../test-helpers/common'

jest.unmock('execa').unmock('dockerode')

const {
  NODE_1_CONTAINER,
  NODE_2_CONTAINER,
  CLIENT_NODE_URL,
  CLIENT_NODE_2_URL,
  EXTERNAL_ADAPTER_URL,
  EXTERNAL_ADAPTER_2_URL,
  MINIMUM_CONTRACT_PAYMENT,
} = t.getEnvVars([
  'NODE_1_CONTAINER',
  'NODE_2_CONTAINER',
  'CLIENT_NODE_URL',
  'CLIENT_NODE_2_URL',
  'EXTERNAL_ADAPTER_URL',
  'EXTERNAL_ADAPTER_2_URL',
  'MINIMUM_CONTRACT_PAYMENT',
])

const provider = t.createProvider()
const carol = ethers.Wallet.createRandom().connect(provider)
const linkTokenFactory = new contract.LinkTokenFactory(carol)
const fluxAggregatorFactory = new FluxAggregatorFactory(carol)
const deposit = h.toWei('1000')
const emptyAddress = '0x0000000000000000000000000000000000000000'

const answerUpdated = fluxAggregatorFactory.interface.events.AnswerUpdated.name
const oracleAdded =
  fluxAggregatorFactory.interface.events.OraclePermissionsUpdated.name
const submissionReceived =
  fluxAggregatorFactory.interface.events.SubmissionReceived.name
const roundDetailsUpdated =
  fluxAggregatorFactory.interface.events.RoundDetailsUpdated.name
const faEventsToListenTo = [
  answerUpdated,
  oracleAdded,
  submissionReceived,
  roundDetailsUpdated,
]

const clClient1 = new ChainlinkClient(
  'node 1',
  CLIENT_NODE_URL,
  NODE_1_CONTAINER,
)
const clClient2 = new ChainlinkClient(
  'node 2',
  CLIENT_NODE_2_URL,
  NODE_2_CONTAINER,
)

// TODO import JobSpecRequest from operator_ui/@types/core/store/models.d.ts
// https://www.pivotaltracker.com/story/show/171715396
let fluxMonitorJob: any
let linkToken: contract.Instance<contract.LinkTokenFactory>
let fluxAggregator: contract.Instance<FluxAggregatorFactory>

let node1Address: string
let node2Address: string

async function assertAggregatorValues(
  latestAnswer: number,
  latestRound: number,
  reportingRound: number,
  roundState1: number,
  roundState2: number,
  msg: string,
): Promise<void> {
  console.log('ASSERT AGGREGATOR VALUES')
  // const [la, lr, rr, ls1, ls2] = await Promise.all([
  //   fluxAggregator.latestRoundData().then(res => res.answer),
  //   fluxAggregator.latestRoundData().then(res => res.roundId),
  //   // get earliest eligible round ID by checking a non-existent address
  //   fluxAggregator.oracleRoundState(emptyAddress, 0).then(res => res._roundId),
  //   fluxAggregator.oracleRoundState(node1Address, 0).then(res => res._roundId),
  //   fluxAggregator.oracleRoundState(node2Address, 0).then(res => res._roundId),
  // ])
  fluxAggregator.latestRoundData().then(roundData => console.log('ROUND DATA ~>', roundData)).catch(err => console.log('ERROR ~>', err))
  try {
  const roundData = await fluxAggregator.latestRoundData()
  console.log('ASSERT AGGREGATOR VALUES roundData ~>', roundData)
  const la = await fluxAggregator.latestRoundData().then(res => res.answer)
  console.log('ASSERT AGGREGATOR VALUES la =', la.toString())
  const lr = await fluxAggregator.latestRoundData().then(res => res.roundId)
  console.log('ASSERT AGGREGATOR VALUES lr =', lr.toString())
  // get earliest eligible round ID by checking a non-existent addres
  const rr = await fluxAggregator.oracleRoundState(emptyAddress, 0).then(res => res._roundId)
  console.log('ASSERT AGGREGATOR VALUES rr =', rr.toString())
  const ls1 = await fluxAggregator.oracleRoundState(node1Address, 0).then(res => res._roundId)
  console.log('ASSERT AGGREGATOR VALUES ls1 =', ls1.toString())
  const ls2 = await fluxAggregator.oracleRoundState(node2Address, 0).then(res => res._roundId)
  console.log('ASSERT AGGREGATOR VALUES ls2 =', ls2.toString())
  console.log('ASSERT AGGREGATOR VALUES ~>', {
      latestAnswer: la.toString(),
      latestRound: lr.toString(),
      reportingRound: rr.toString(),
      roundState1: ls1.toString(),
      roundState2: ls2.toString(),
  })
  matchers.bigNum(latestAnswer, la, `${msg} : latest answer`)
  matchers.bigNum(latestRound, lr, `${msg} : latest round`)
  matchers.bigNum(reportingRound, rr, `${msg} : reporting round`)
  matchers.bigNum(roundState1, ls1, `${msg} : node 1 round state round ID`)
  matchers.bigNum(roundState2, ls2, `${msg} : node 2 round state round ID`)
} catch (err) {
    console.log('ERRRRORRRRR ~>', err)
    throw err
}
}

async function assertLatestAnswerEq(n: number) {
  await t.assertAsync(async () => {
    const round = await fluxAggregator.latestRoundData()
    return round.answer.eq(n)
  }, `latestAnswer should eventually equal ${n}`)
}

beforeAll(async () => {
  t.printHeading('Flux Monitor Test')

  clClient1.login()
  clClient2.login()
  node1Address = clClient1.getAdminInfo()[0].address
  node2Address = clClient2.getAdminInfo()[0].address

  await t.fundAddress(carol.address)
  await t.fundAddress(node1Address)
  await t.fundAddress(node2Address)
  linkToken = await linkTokenFactory.deploy()
  await linkToken.deployed()

  console.log(`Chainlink Node 1 address: ${node1Address}`)
  console.log(`Chainlink Node 2 address: ${node2Address}`)
  console.log(`Contract creator's address: ${carol.address}`)
  console.log(`Deployed LinkToken contract: ${linkToken.address}`)
})

beforeEach(async () => {
  t.printHeading('Running Test')
  fluxMonitorJob = JSON.parse(JSON.stringify(fluxMonitorJobTemplate)) // perform a deep clone
  const minSubmissionValue = 1
  const maxSubmissionValue = 1000000000
  const deployingContract = await fluxAggregatorFactory.deploy(
    linkToken.address,
    MINIMUM_CONTRACT_PAYMENT,
    10,
    emptyAddress,
    minSubmissionValue,
    maxSubmissionValue,
    1,
    ethers.utils.formatBytes32String('ETH/USD'),
  )
  await deployingContract.deployed()
  fluxAggregator = deployingContract
  t.logEvents(fluxAggregator as any, 'FluxAggregator', faEventsToListenTo)
  console.log(`Deployed FluxAggregator contract: ${fluxAggregator.address}`)
})

afterEach(async () => {
  clClient1.getJobs().forEach(job => clClient1.archiveJob(job.id))
  clClient2.getJobs().forEach(job => clClient2.archiveJob(job.id))
  await Promise.all([
    t.changePriceFeed(EXTERNAL_ADAPTER_URL, 100), // original price
    t.changePriceFeed(EXTERNAL_ADAPTER_2_URL, 100),
  ])
  fluxAggregator.removeAllListeners('*')
})

describe('FluxMonitor / FluxAggregator integration with one node', () => {
  it('updates the price', async () => {
    await linkToken.transfer(fluxAggregator.address, deposit).then(t.txWait)
    await fluxAggregator.updateAvailableFunds().then(t.txWait)

    await fluxAggregator
      .changeOracles([], [node1Address], [node1Address], 1, 1, 0)
      .then(t.txWait)

    expect(await fluxAggregator.getOracles()).toEqual([node1Address])
    matchers.bigNum(
      await linkToken.balanceOf(fluxAggregator.address),
      deposit,
      'Unable to fund FluxAggregator',
    )

    const initialJobCount = clClient1.getJobs().length
    const initialRunCount = clClient1.getJobRuns().length

    // create FM job
    fluxMonitorJob.initiators[0].params.address = fluxAggregator.address
    fluxMonitorJob.initiators[0].params.feeds = [EXTERNAL_ADAPTER_URL]
    clClient1.createJob(JSON.stringify(fluxMonitorJob))
    assert.equal(clClient1.getJobs().length, initialJobCount + 1)

    // Job should trigger initial FM run
    await t.assertJobRun(clClient1, initialRunCount + 1, 'initial update')
    await assertLatestAnswerEq(10000)

    // Nominally change price feed
    await t.changePriceFeed(EXTERNAL_ADAPTER_URL, 101)
    await t.wait(10000)
    assert.equal(
      clClient1.getJobRuns().length,
      initialRunCount + 1,
      'Flux Monitor should not run job after nominal price deviation',
    )

    // Significantly change price feed
    await t.changePriceFeed(EXTERNAL_ADAPTER_URL, 110)
    await t.assertJobRun(clClient1, initialRunCount + 2, 'second update')
    await assertLatestAnswerEq(11000)
  })
})

describe('FluxMonitor / FluxAggregator integration with two nodes', () => {
  beforeEach(async () => {
    await linkToken.transfer(fluxAggregator.address, deposit).then(t.txWait)
    await fluxAggregator.updateAvailableFunds().then(t.txWait)

    await fluxAggregator
      .changeOracles(
        [],
        [node1Address, node2Address],
        [node1Address, node2Address],
        2,
        2,
        0,
      )
      .then(t.txWait)

    expect(await fluxAggregator.getOracles()).toEqual([
      node1Address,
      node2Address,
    ])
    matchers.bigNum(
      await linkToken.balanceOf(fluxAggregator.address),
      deposit,
      'Unable to fund FluxAggregator',
    )
  })

  it.only('updates the price', async () => {
    const node1InitialRunCount = clClient1.getJobRuns().length
    const node2InitialRunCount = clClient2.getJobRuns().length
    if (node1InitialRunCount !== 0) {
        throw new Error('node 1 has runs')
    }
    if (node2InitialRunCount !== 0) {
        throw new Error('node 2 has runs')
    }

    fluxMonitorJob.initiators[0].params.address = fluxAggregator.address
    fluxMonitorJob.initiators[0].params.feeds = [EXTERNAL_ADAPTER_URL]
    const fmJob1 = JSON.stringify(fluxMonitorJob)
    clClient1.createJob(fmJob1)

    fluxMonitorJob.initiators[0].params.feeds = [EXTERNAL_ADAPTER_2_URL]
    const fmJob2 = JSON.stringify(fluxMonitorJob)
    clClient2.createJob(fmJob2)

    // Note: dockerode#pause() seems to cause other containers in the environment to
    // freeze, so instead, we simply archive jobs to simulate Chainlink nodes going
    // offline.  This has the side effect of deleting the job runs from the DB.
    // Therefore, our assertions about run counts have to assume we're starting
    // from 0 after each pause.
    function pause(clClient: ChainlinkClient) {
      // clClient.getJobs().forEach(job => clClient.archiveJob(job.id))
      // console.log('PAUSE: job runs:', clClient.name, clClient.getJobRuns().length)
      // t.assertAsync(() => clClient.getJobRuns().length === 0, 'job runs were not deleted')
      clClient.pause()
    }

    function unpause(clClient: ChainlinkClient, job: string) {
      // clClient.createJob(job)
      console.log(job)
      clClient.unpause()
    }

    const rd = await fluxAggregator.latestRoundData()
    console.log('RD ~>', rd)

    // initial job run
    await t.assertJobRun(clClient1, node1InitialRunCount + 1, 'initial update, node 1')
    await t.assertJobRun(clClient2, node2InitialRunCount + 1, 'initial update, node 2')
    fluxAggregator.latestRoundData().then(roundData => console.log('ROUND DATA ~>', roundData)).catch(err => console.log('ERROR ~>', err))
    await assertAggregatorValues(10000, 1, 2, 2, 2, 'initial round')
    pause(clClient1)
    pause(clClient2)

    console.log('==== 1 ====')

    // node 1 should still begin round even with unresponsive node 2
    await t.changePriceFeed(EXTERNAL_ADAPTER_URL, 110)
    console.log('==== 2 ====')
    await t.changePriceFeed(EXTERNAL_ADAPTER_2_URL, 120)
    console.log('==== 3 ====')
    unpause(clClient1, fmJob1)
    console.log('==== 4 ====')
    await t.assertJobRun(clClient1, node1InitialRunCount + 1, 'second update, node 1')
    console.log('==== 5 ====')
    await assertAggregatorValues(10000, 1, 2, 2, 2, 'node 1 only')
    console.log('==== 6 ====')
    pause(clClient1)
    console.log('==== 7 ====')

    // node 2 should finish round
    unpause(clClient2, fmJob2)
    console.log('==== 8 ====')
    await t.assertJobRun(clClient2, node2InitialRunCount + 1, 'second update, node 2')
    console.log('==== 9 ====')
    await assertAggregatorValues(11500, 2, 3, 3, 3, 'second round')
    console.log('==== 10 ====')
    pause(clClient2)
    console.log('==== 11 ====')

    // reduce minAnswers to 1
    await (
      await fluxAggregator.updateFutureRounds(
        MINIMUM_CONTRACT_PAYMENT,
        1,
        2,
        0,
        5,
      )
    ).wait()
    console.log('==== 12 ====')
    await t.changePriceFeed(EXTERNAL_ADAPTER_URL, 130)
    console.log('==== 13 ====')
    unpause(clClient1, fmJob1)
    console.log('==== 14 ====')
    await t.assertJobRun(clClient1, node1InitialRunCount + 1, 'third update')
    console.log('==== 15 ====')
    await assertAggregatorValues(13000, 3, 3, 4, 3, 'third round')
    console.log('==== 16 ====')
    pause(clClient1)
    console.log('==== 17 ====')

    // node should continue to start new rounds alone
    await t.changePriceFeed(EXTERNAL_ADAPTER_URL, 140)
    console.log('==== 18 ====')
    unpause(clClient1, fmJob1)
    console.log('==== 19 ====')
    await t.assertJobRun(clClient1, node1InitialRunCount + 1, 'fourth update')
    console.log('==== 20 ====')
    await assertAggregatorValues(14000, 4, 4, 5, 4, 'fourth round')
    console.log('==== 21 ====')

    pause(clClient1)
    pause(clClient2)
  })

  it('respects the idle timer duration', async () => {
    await (
      await fluxAggregator.updateFutureRounds(
        MINIMUM_CONTRACT_PAYMENT,
        2,
        2,
        0,
        10,
      )
    ).wait()

    const node1InitialRunCount = clClient1.getJobRuns().length
    const node2InitialRunCount = clClient2.getJobRuns().length

    fluxMonitorJob.initiators[0].params.idleTimer.disabled = false
    fluxMonitorJob.initiators[0].params.idleTimer.duration = '15s'
    fluxMonitorJob.initiators[0].params.pollTimer.disabled = true
    fluxMonitorJob.initiators[0].params.pollTimer.period = '0'
    fluxMonitorJob.initiators[0].params.address = fluxAggregator.address
    fluxMonitorJob.initiators[0].params.feeds = [EXTERNAL_ADAPTER_URL]
    clClient1.createJob(JSON.stringify(fluxMonitorJob))
    fluxMonitorJob.initiators[0].params.feeds = [EXTERNAL_ADAPTER_2_URL]
    clClient2.createJob(JSON.stringify(fluxMonitorJob))

    function pause(clClient: ChainlinkClient) {
      clClient.getJobs().forEach(job => clClient.archiveJob(job.id))
    }

    // initial job run
    await t.assertJobRun(clClient1, node1InitialRunCount + 1, 'initial update')
    await t.assertJobRun(clClient2, node2InitialRunCount + 1, 'initial update')
    await assertAggregatorValues(10000, 1, 2, 2, 2, 'initial round')

    // second job run
    await t.assertJobRun(clClient1, node1InitialRunCount + 2, 'second update')
    await t.assertJobRun(clClient2, node2InitialRunCount + 2, 'second update')
    await assertAggregatorValues(10000, 2, 3, 3, 3, 'second round')

    // third job run without node 2
    pause(clClient2)
    await t.assertJobRun(clClient1, node1InitialRunCount + 3, 'third update')
    await assertAggregatorValues(10000, 2, 3, 3, 3, 'third round')
  })
})
