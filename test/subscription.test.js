'use strict'

const _ = require('lodash')
const nock = require('nock')
nock.enableNetConnect(['localhost'])
const ratesResponse = require('./data/fxRates.json')
const appHelper = require('./helpers/app')
const logger = require('../src/common/log')
const logHelper = require('./helpers/log')
const wsHelper = require('./helpers/ws')
const sinon = require('sinon')
const IlpPacket = require('ilp-packet')
const { assert } = require('chai')

const mockPlugin = require('./mocks/mockPlugin')
const mock = require('mock-require')
mock('ilp-plugin-mock', mockPlugin)

const START_DATE = 1434412800000 // June 16, 2015 00:00:00 GMT

const env = _.cloneDeep(process.env)

describe('Subscriptions', function () {
  logHelper(logger)

  beforeEach(async function () {
    appHelper.create(this)
    await this.backend.connect(ratesResponse)
    await this.accounts.connect()
    await this.routeBroadcaster.reloadLocalRoutes()

    const testAccounts = ['cad-ledger', 'usd-ledger', 'eur-ledger', 'cny-ledger']
    for (let accountId of testAccounts) {
      this.accounts.getPlugin(accountId)._dataHandler(Buffer.from(JSON.stringify({
        method: 'broadcast_routes',
        data: {
          hold_down_time: 45000,
          unreachable_through_me: [],
          request_full_table: false,
          new_routes: [{
            prefix: accountId,
            min_message_window: 1,
            path: []
          }]
        }
      })))
    }

    nock('http://usd-ledger.example').get('/')
      .reply(200, {
        currency_code: 'doesn\'t matter, the connector will ignore this',
        currency_scale: 4
      })

    nock('http://eur-ledger.example').get('/')
      .reply(200, {
        currency_code: 'doesn\'t matter, the connector will ignore this',
        currency_scale: 4
      })

    nock('http://usd-ledger.example').get('/accounts/mark')
      .reply(200, {
        ledger: 'http://usd-ledger.example',
        name: 'mark',
        connector: 'http://localhost'
      })

    nock('http://eur-ledger.example').get('/accounts/mark')
      .reply(200, {
        ledger: 'http://eur-ledger.example',
        name: 'mark',
        connector: 'http://localhost'
      })

    nock('http://cad-ledger.example:1000').get('/accounts/mark')
      .reply(200, {
        ledger: 'http://cad-ledger.example:1000',
        name: 'mark',
        connector: 'http://localhost'
      })

    nock('http://cny-ledger.example').get('/accounts/mark')
      .reply(200, {
        ledger: 'http://cny-ledger.example',
        name: 'mark',
        connector: 'http://localhost'
      })

    this.setTimeout = setTimeout
    this.clock = sinon.useFakeTimers(START_DATE)

    this.wsCadLedger = new wsHelper.Server('ws://cad-ledger.example:1000/accounts/mark/transfers')
    this.wsUsdLedger = new wsHelper.Server('ws://usd-ledger.example/accounts/mark/transfers')
    this.wsEurLedger = new wsHelper.Server('ws://eur-ledger.example/accounts/mark/transfers')
    this.wsEurLedger.on('connection', () => null)
    this.wsCnyLedger = new wsHelper.Server('ws://cny-ledger.example/accounts/mark/transfers')

    this.transferUsdPrepared = _.cloneDeep(require('./data/transferUsdPrepared.json'))
    this.transferEurProposed = _.cloneDeep(require('./data/transferEurProposed.json'))
  })

  afterEach(async function () {
    nock.cleanAll()
    this.clock.restore()
    process.env = _.cloneDeep(env)
    this.wsCadLedger.close()
    this.wsUsdLedger.close()
    this.wsEurLedger.close()
    this.wsCnyLedger.close()
  })

  it('should initiate and complete a universal mode payment', async function () {
    const sourceAccount = 'usd-ledger'
    const destinationAccount = 'eur-ledger'
    const destination = 'eur-ledger.bob'
    const executionCondition = Buffer.from('uzoYx3K6u+Nt6kZjbN6KmH0yARfhkj9e17eQfpSeB7U=', 'base64')
    const expiresAt = new Date('2015-06-16T00:00:11.000Z')
    const data = Buffer.from('BABA', 'base64')
    const sourceAmount = '10700'
    const destinationAmount = '10081'
    const ilpFulfill = {
      fulfillment: Buffer.from('HS8e5Ew02XKAglyus2dh2Ohabuqmy3HDM8EXMLz22ok', 'base64'),
      data: Buffer.from('ABAB', 'base64')
    }
    const sendStub = sinon.stub(this.accounts.getPlugin(destinationAccount), 'sendData')
      .resolves(IlpPacket.serializeIlpFulfill(ilpFulfill))
    const sendMoneyStub = sinon.stub(this.accounts.getPlugin(destinationAccount), 'sendMoney')
      .resolves()

    const result = await this.accounts.getPlugin(sourceAccount)
      ._dataHandler(IlpPacket.serializeIlpPrepare({
        amount: sourceAmount,
        executionCondition,
        expiresAt,
        destination,
        data
      }))

    sinon.assert.calledOnce(sendStub)
    sinon.assert.calledWith(sendStub, sinon.match(packet => assert.deepEqual(IlpPacket.deserializeIlpPrepare(packet), {
      amount: destinationAmount,
      executionCondition,
      expiresAt: new Date(expiresAt - 1000),
      destination,
      data
    }) || true))
    sinon.assert.calledOnce(sendMoneyStub)
    sinon.assert.calledWith(sendMoneyStub, destinationAmount)
    assert.deepEqual(IlpPacket.deserializeIlpFulfill(result), ilpFulfill)
  })

  it('should notify the backend of a successful payment', async function () {
    const sourceAccount = 'usd-ledger'
    const destinationAccount = 'eur-ledger'
    const destination = 'eur-ledger.bob'
    const executionCondition = Buffer.from('uzoYx3K6u+Nt6kZjbN6KmH0yARfhkj9e17eQfpSeB7U=', 'base64')
    const expiresAt = new Date('2015-06-16T00:00:11.000Z')
    const data = Buffer.from('BABA', 'base64')
    const sourceAmount = '10700'
    const destinationAmount = '10081'
    const ilpFulfill = {
      fulfillment: Buffer.from('HS8e5Ew02XKAglyus2dh2Ohabuqmy3HDM8EXMLz22ok', 'base64'),
      data: Buffer.from('ABAB', 'base64')
    }
    sinon.stub(this.accounts.getPlugin(destinationAccount), 'sendData')
      .resolves(IlpPacket.serializeIlpFulfill(ilpFulfill))
    sinon.stub(this.accounts.getPlugin(destinationAccount), 'sendMoney')
      .resolves()
    const backendSpy = sinon.spy(this.backend, 'submitPayment')

    await this.accounts.getPlugin(sourceAccount)
      ._dataHandler(IlpPacket.serializeIlpPrepare({
        amount: sourceAmount,
        executionCondition,
        expiresAt,
        destination,
        data
      }))

    sinon.assert.calledOnce(backendSpy)
    sinon.assert.calledWith(backendSpy, {
      sourceAccount,
      sourceAmount,
      destinationAccount,
      destinationAmount
    })
  })
})