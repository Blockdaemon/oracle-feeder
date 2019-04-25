'use strict';

import axios from 'axios';
import { AxiosPromise } from 'axios';
import * as util from 'util';
import * as math from 'mathjs';
import * as promptly from 'promptly';

import { ArgumentParser } from 'argparse';

import * as wallet from './wallet';
import * as keystore from './keystore';
import { getKey } from './keystore';

const endpointVote = `/oracle/denoms/%s/votes`;
const endpointAccount = `/auth/accounts/%s`;
const endpointBroadcast = `/txs`;

function registCommands(parser: ArgumentParser): void {
    let subparsers = parser.addSubparsers({
        title: `commands`,
        dest: `subparser_name`,
        description: `Aavailable commands`,
    });

    // Voting command
    let voteCommand = subparsers.addParser(`vote`, {
        addHelp: true,
        description: `Get price data from sources, vote for all denoms in data`,
    });

    voteCommand.addArgument([`--ledger`], {
        action: `storeTrue`,
        help: `using ledger`,
        defaultValue: false,
    });

    voteCommand.addArgument([`-l`, `--lcd`], {
        action: `store`,
        help: `lcd address`,
        required: true,
    });

    voteCommand.addArgument([`-c`, `--chain-id`], {
        action: `store`,
        help: `chain ID`,
        dest: `chainID`,
        required: true,
    });

    voteCommand.addArgument([`-s`, `--source`], {
        action: `append`,
        help: `Append price data source(It can handle multiple sources)`,
        required: true,
    });

    voteCommand.addArgument([`-p`, `--password`], {
        action: `store`,
        help: `voter password`,
    });

    voteCommand.addArgument([`-d`, `--denoms`], {
        action: `store`,
        help: `denom list to vote (ex: "all" or "krw,eur,usd")`,
        defaultValue: `all`,
    });

    // Updating Key command
    subparsers.addParser(`update-key`, { addHelp: true });
}

async function updateKey(): Promise<void> {
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

    const seeds = await promptly.prompt(`Enter your bip39 mnemonic : `);

    if (seeds.trim().split(` `).length !== 24) {
        console.error(`Error: Mnemonic is not valid.`);
        return;
    }

    await keystore.importKey(password, seeds);
    console.log(`saved!`);
}

async function votePrice(
    { lcd: lcdAddress, chainID, ledger: ledgerMode },
    ledger,
    currency: string,
    price: string,
    voter,
    account: { account_number: string; sequence: string },
): Promise<void> {
    /* eslint-disable @typescript-eslint/camelcase */
    const txArgs = {
        base_req: {
            from: voter.terraAddress,
            memo: `Voting from terra feeder`,
            chain_id: chainID,
            account_number: account.account_number,
            sequence: account.sequence,
            fees: [{ amount: `0`, denom: `uluna` }],
            gas: `200000`,
            gas_adjustment: `0`,
            simulate: false,
        },
        price,
    };
    /* eslint-enable @typescript-eslint/camelcase */
    const denom = `u` + currency.toLowerCase();
    const url = util.format(lcdAddress + endpointVote, denom);

    let res = await axios.post(url, txArgs);
    let tx = res.data.value;

    let signature = await keystore.signTx(ledger, voter, ledgerMode, tx, txArgs.base_req);
    let signedTx = wallet.createSignedTx(tx, signature);
    let boradcastReq = wallet.createBroadcastBody(signedTx, `sync`);

    try {
        res = await axios.post(lcdAddress + endpointBroadcast, boradcastReq);

        if (res.data.code !== undefined) {
            console.error(`voting failed : ` + JSON.stringify(res.statusText));
        } else {
            console.log(`Voted : ${denom} = ${price},  txhash : ${res.data.txhash}`);
        }
    } catch (e) {
        console.error(e.toString());
    }
}

async function getPrice(sources: [string]): Promise<{}> {
    let total = {};
    let res = await axios.all(
        sources.map(
            (source): AxiosPromise => {
                return axios.get(source);
            },
        ),
    );
    res.forEach(
        (result): void => {
            try {
                if (result[`status`] == 200) {
                    const prices = result[`data`][`prices`];
                    prices.forEach(
                        (price): void => {
                            if (total[price.currency] != undefined) {
                                total[price.currency].push(price.price);
                            } else {
                                total[price.currency] = [price.price];
                            }
                        },
                    );
                }
            } catch (e) {
                console.error(e);
            }
        },
    );

    Object.keys(total).forEach(
        (key): void => {
            total[key] = math.median(total[key]);
        },
    );

    return total;
}

async function updateAndVoting(args): Promise<void> {
    let { source, lcd: lcdAddress, denoms } = args;
    if (!(source instanceof Array)) {
        source = [source];
    }

    console.info(`getting price data`);
    const prices = await getPrice(source);
    let voter;

    console.info(`check account information`);
    let ledgerNode = null;
    let ledgerApp = null;

    if (args.ledger) {
        ledgerNode = await keystore.getLedgerNode();
        ledgerApp = await keystore.getLedgerApp(ledgerNode);

        voter = await keystore.getAccountFromLedger(ledgerApp);
        if (voter === null) {
            console.error(`Ledger is not connected or locked`);
            return null;
        }
    } else {
        const password = args.password || (await promptly.password(`Enter a passphrase:`, { replace: `*` }));
        voter = getKey(password);
    }

    const query = util.format(lcdAddress + endpointAccount, voter.terraAddress);
    console.info(`bring account number and sequence: ${query}`);
    let res;
    try {
        res = await axios.get(query);
        if (res.status != 200) {
            console.error(`Failed to bringing account number and sequence : ${res.statusText}`);
            return;
        }
    } catch (e) {
        console.error(`Failed to bringing account number and sequence : ${e.toString()}`);
        return;
    }

    const account = res.data.value;
    const lowerDenoms = denoms.toLowerCase();

    console.info(`votting denoms`);
    for (let currency in prices) {
        if (lowerDenoms !== `all` && lowerDenoms.indexOf(currency.toLowerCase()) === -1) continue;

        try {
            // await votePrice(args, ledger, currency, prices[currency].toString(), voter, account);
            await votePrice(args, ledgerApp, currency, `123456`, voter, account);
            account.sequence = (parseInt(account.sequence) + 1).toString();
        } catch (e) {
            console.error(e.toString());
        }
    }

    if (ledgerNode !== null) {
        ledgerNode.close_async();
    }
}

async function main(): Promise<void> {
    let parser = new ArgumentParser({
        version: `0.1.0`,
        addHelp: true,
        description: `Terra oracle voter`,
    });

    registCommands(parser);
    let args = parser.parseArgs();

    if (args.subparser_name == `vote`) {
        updateAndVoting(args);
    } else if (args.subparser_name == `update-key`) {
        await updateKey();
    }
}

main().catch(
    (reason): void => {
        console.error(reason);
    },
);
