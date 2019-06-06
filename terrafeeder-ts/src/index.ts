import * as Bluebird from 'bluebird';
import axios from 'axios';
import * as util from 'util';
import * as promptly from 'promptly';
import { ArgumentParser } from 'argparse';
import delay from 'delay';

import * as wallet from './wallet';
import * as keystore from './keystore';
import msg from './msg';

const ENDPOINT_TX_PREVOTE = `/oracle/denoms/%s/prevotes`;
const ENDPOINT_TX_VOTE = `/oracle/denoms/%s/votes`;
const ENDPOINT_TX_BROADCAST = `/txs`;
const ENDPOINT_QUERY_LATEST_BLOCK = `/blocks/latest`;
const ENDPOINT_QUERY_ACCOUNT = `/auth/accounts/%s`;
const ENDPOINT_QUERY_PREVOTE = `/oracle/denoms/%s/prevotes/%s`;
const VOTE_PERIOD = 10;

function registerCommands(parser: ArgumentParser): void {
  const subparsers = parser.addSubparsers({
    title: `commands`,
    dest: `subparser_name`,
    description: `Aavailable commands`
  });

  // Voting command
  const voteCommand = subparsers.addParser(`vote`, {
    addHelp: true,
    description: `Get price data from sources, vote for all denoms in data`
  });

  voteCommand.addArgument([`--ledger`], {
    action: `storeTrue`,
    help: `using ledger`,
    dest: 'ledgerMode',
    defaultValue: false
  });

  voteCommand.addArgument(['-l', '--lcd'], {
    action: 'store',
    help: 'lcd address',
    dest: 'lcdAddress',
    required: true
  });

  voteCommand.addArgument([`-c`, `--chain-id`], {
    action: `store`,
    help: `chain ID`,
    dest: `chainID`,
    required: true
  });

  voteCommand.addArgument([`--validator`], {
    action: `store`,
    help: `validator address (e.g. terravaloper1...)`,
    required: false
  });

  voteCommand.addArgument([`--salt`], {
    action: `store`,
    help: `salt for hashing`,
    required: true
  });

  voteCommand.addArgument([`-s`, `--source`], {
    action: `append`,
    help: `Append price data source(It can handle multiple sources)`,
    required: true
  });

  voteCommand.addArgument([`-p`, `--password`], {
    action: `store`,
    help: `voter password`
  });

  voteCommand.addArgument([`-d`, `--denoms`], {
    action: `store`,
    help: `denom list to vote (ex: "all" or "krw,eur,usd")`,
    defaultValue: `all`
  });

  voteCommand.addArgument([`-k`, `--keystore`], {
    action: `store`,
    help: `key store path to save encrypted key`,
    defaultValue: `voter.json`
  });

  // Updating Key command
  const keyCommand = subparsers.addParser(`update-key`, { addHelp: true });

  keyCommand.addArgument([`-k`, `--keystore`], {
    action: `store`,
    help: `key store path to save encrypted key`,
    defaultValue: `voter.json`
  });
}

async function updateKey(args): Promise<void> {
  const password = await promptly.password(`Enter a passphrase to encrypt your key to disk:`, { replace: `*` });
  const confirm = await promptly.password(`Repeat the passphrase:`, { replace: `*` });

  if (password.length < 8) {
    console.error(`ERROR: password must be at least 8 characters`);
    return;
  }

  if (password !== confirm) {
    console.error(`ERROR: passphrases don't matchPassword confirm failed`);
    return;
  }

  const mnemonic = await promptly.prompt(`Enter your bip39 mnemonic: `);

  if (mnemonic.trim().split(` `).length !== 24) {
    console.error(`Error: Mnemonic is not valid.`);
    return;
  }

  await keystore.importKey(args.keystore, password, mnemonic);
  console.log(`saved!`);
}

async function queryAccount({ lcdAddress, voter }) {
  const url = util.format(lcdAddress + ENDPOINT_QUERY_ACCOUNT, voter.terraAddress);
  console.info(`querying: ${url}`);

  const res = await axios.get(url).catch(e => {
    console.error(`Failed to bringing account number and sequence: ${e.toString()}`);
    return;
  });

  if (!res || res.status !== 200) {
    if (res) console.error(`Failed to bringing account number and sequence: ${res.statusText}`);
    return;
  }

  return res.data.value;
}

async function queryLatestBlock({ lcdAddress }) {
  const res = await axios.get(lcdAddress + ENDPOINT_QUERY_LATEST_BLOCK);
  if (res) return res.data;
}

async function queryPrevote({ lcdAddress, currency, validator }) {
  const denom = `u${currency.toLowerCase()}`;
  const url = util.format(lcdAddress + ENDPOINT_QUERY_PREVOTE, denom, validator);

  const res = await axios.get(url);

  if (res.status === 200) {
    return res.data[0];
  }
}

// async function txVote({
//   lcdAddress,
//   chainID,
//   validator,
//   ledgerApp,
//   voter,
//   currency,
//   price,
//   salt,
//   account,
//   isPrevote = false,
//   broadcastMode = 'sync'
// }): Promise<number> {
//   /* eslint-disable @typescript-eslint/camelcase */
//   const txArgs = {
//     base_req: {
//       from: voter.terraAddress,
//       memo: `Voting from terra feeder`,
//       chain_id: chainID,
//       account_number: account.account_number,
//       sequence: account.sequence,
//       fees: [{ amount: `450`, denom: `uluna` }],
//       gas: `30000`,
//       gas_adjustment: `0`,
//       simulate: false
//     },
//     price,
//     salt,
//     validator
//   };

//   const denom = `u${currency.toLowerCase()}`;
//   const url = util.format(lcdAddress + (isPrevote ? ENDPOINT_TX_PREVOTE : ENDPOINT_TX_VOTE), denom);

//   // Create unsinged tx for voting
//   const {
//     data: { value: tx }
//   } = await axios.post(url, txArgs).catch(e => {
//     console.error(e.response.data.error);
//     throw e;
//   });

//   // Sign
//   const signature = await wallet.sign(ledgerApp, voter, tx, txArgs.base_req);
//   const signedTx = wallet.createSignedTx(tx, signature);
//   const broadcastReq = wallet.createBroadcastBody(signedTx, broadcastMode);

//   // Send broadcast
//   const { data } = await axios.post(lcdAddress + ENDPOINT_TX_BROADCAST, broadcastReq).catch(e => {
//     console.error(e.response.data.error);
//     throw e;
//   });

//   if (data.code !== undefined) {
//     console.error('voting failed:', data.logs);
//     return 0;
//   }

//   if (data.logs && !data.logs[0].success) {
//     console.error('voting tx sent, but failed:', data.logs);
//   } else {
//     console.log(`${denom} = ${price}, txhash: ${data.txhash}`);
//   }

//   account.sequence = (parseInt(account.sequence, 10) + 1).toString();
//   return +data.height;
// }

async function broadcast({ lcdAddress, account, broadcastReq }): Promise<number> {
  // Send broadcast
  const { data } = await axios.post(lcdAddress + ENDPOINT_TX_BROADCAST, broadcastReq).catch(e => {
    console.error(e.response.data.error);
    throw e;
  });

  if (data.code !== undefined) {
    console.error('voting failed:', data.logs);
    return 0;
  }

  if (data.logs && !data.logs[0].success) {
    console.error('voting tx sent, but failed:', data.logs);
  } else {
    console.log(`txhash: ${data.txhash}`);
  }

  account.sequence = (parseInt(account.sequence, 10) + 1).toString();
  return +data.height;
}

async function getPrice(sources: [string]): Promise<{}> {
  console.info(`getting price data from`, sources);

  const total = {};
  const results = await Bluebird.some(sources.map(s => axios.get(s)), 1);

  if (results.length > 0) {
    const res = results[0];
    const prices = res.data.prices;

    prices.forEach(
      (price): void => {
        if (typeof total[price.currency] !== 'undefined') {
          total[price.currency].push(price.price);
        } else {
          total[price.currency] = [price.price];
        }
      }
    );
  }

  return total;
}

async function vote(args): Promise<void> {
  const { lcdAddress, denoms } = args;
  const source = args.source instanceof Array ? args.source : [args.source];

  let voter;
  let ledgerNode = null;
  let ledgerApp = null;

  if (args.ledgerMode) {
    console.info(`initializing ledger`);
    const ledger = require('./ledger');

    ledgerNode = await ledger.getLedgerNode();
    ledgerApp = await ledger.getLedgerApp(ledgerNode);
    voter = await ledger.getAccountFromLedger(ledgerApp);

    if (voter === null) {
      console.error(`Ledger is not connected or locked`);
      return null;
    }
  } else {
    console.info(`getting key from keystore`);
    const password = args.password || (await promptly.password(`Enter a passphrase:`, { replace: `*` }));
    voter = keystore.getKey(args.keystore, password);
  }

  const denomArray = denoms.split(',').map(s => s.toLowerCase());
  const prevotePrices = {};
  let prevotePeriod;
  const prevotePeriods = {};

  while (1) {
    const startTime = Date.now();

    try {
      const voteMsgs = [];
      const prevoteMsgs = [];
      const prices = await getPrice(source);
      const latestBlock = await queryLatestBlock({ ...args });
      const currentBlockHeight = parseInt(latestBlock.block.header.height, 10);
      const votePeriod = Math.floor(currentBlockHeight / VOTE_PERIOD);

      const account = await queryAccount({ lcdAddress, voter });

      // Vote
      if (prevotePeriod && prevotePeriod !== votePeriod) {
        await Bluebird.mapSeries(Object.keys(prices), async currency => {
          if (denomArray.indexOf(currency.toLowerCase()) === -1) {
            return;
          }

          console.log(`vote! ${currency} ${prevotePrices[currency]}`);

          voteMsgs.push(
            msg.buildVoteMsg(
              prevotePrices[currency].toString(),
              args.salt,
              `u${currency.toLowerCase()}`,
              voter.terraAddress,
              voter.terraValAddress
            )
          );
        });
      }

      const priceUpdateMap = {};
      if (currentBlockHeight % VOTE_PERIOD <= VOTE_PERIOD - 2) {
        // Prevote
        await Bluebird.mapSeries(Object.keys(prices), async currency => {
          if (denomArray.indexOf(currency.toLowerCase()) === -1) {
            return;
          }

          console.log(`prevote! ${currency} ${prices[currency]}`);

          const denom = `u${currency.toLowerCase()}`;
          const hash = msg.voteHash(args.salt, prices[currency].toString(), denom, voter.terraValAddress);

          prevoteMsgs.push(msg.buildPrevoteMsg(hash, denom, voter.terraAddress, voter.terraValAddress));

          priceUpdateMap[currency] = prices[currency];
        });
      }

      if (voteMsgs.length > 0) {
        const fees = { amount: [{ amount: `1500`, denom: `uluna` }], gas: `100000` };
        const { value: tx } = msg.buildStdTx(voteMsgs, fees, `Voting from terra feeder`);
        const signature = await wallet.sign(ledgerApp, voter, tx, {
          chain_id: args.chainID,
          account_number: account.account_number,
          sequence: account.sequence
        });

        const signedTx = wallet.createSignedTx(tx, signature);
        const broadcastReq = wallet.createBroadcastBody(signedTx, `block`);
        await broadcast({
          lcdAddress,
          account,
          broadcastReq
        }).catch(err => {
          console.error(err.response.data);
        });
      }

      if (prevoteMsgs.length > 0) {
        const fees = { amount: [{ amount: `1500`, denom: `uluna` }], gas: `100000` };
        const { value: tx } = msg.buildStdTx(prevoteMsgs, fees, `Voting from terra feeder`);
        const signature = await wallet.sign(ledgerApp, voter, tx, {
          chain_id: args.chainID,
          account_number: account.account_number,
          sequence: account.sequence
        });

        const signedTx = wallet.createSignedTx(tx, signature);
        const broadcastReq = wallet.createBroadcastBody(signedTx, `block`);
        const height = await broadcast({
          lcdAddress,
          account,
          broadcastReq
        }).catch(err => {
          console.error(err.response.data);
        });

        if (height) {
          Object.assign(prevotePrices, priceUpdateMap);
          prevotePeriod = Math.floor(height / VOTE_PERIOD);
        }
      }
    } catch (e) {
      console.error('Error in loop:', e.toString());
    }

    // Sleep 2s at least
    await delay(Math.max(10000, 15000 - (Date.now() - startTime)));
  }

  if (ledgerNode !== null) {
    ledgerNode.close_async();
  }
}

async function main(): Promise<void> {
  const parser = new ArgumentParser({
    version: `0.2.0`,
    addHelp: true,
    description: `Terra oracle voter`
  });

  registerCommands(parser);
  const args = parser.parseArgs();

  if (args.subparser_name === `vote`) {
    await vote(args);
  } else if (args.subparser_name === `update-key`) {
    await updateKey(args);
  }
}

main().catch(e => {
  console.error(e);
});
