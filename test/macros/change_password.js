const {join} = require('path');
const {readFileSync} = require('fs');
const {spawn} = require('child_process');

const asyncAuto = require('async/auto');
const asyncMapSeries = require('async/mapSeries');
const asyncRetry = require('async/retry');
const {ECPair} = require('bitcoinjs-lib');
const {networks} = require('bitcoinjs-lib');
const openPortFinder = require('portfinder');

const {changePassword} = require('./../../');
const {createSeed} = require('./../../');
const {createWallet} = require('./../../');
const generateBlocks = require('./generate_blocks');
const {lightningDaemon} = require('./../../');
const spawnChainDaemon = require('./spawn_chain_daemon');
const {stopDaemon} = require('./../../');

const adminMacaroonFileName = 'admin.macaroon';
const chainPass = 'pass';
const chainRpcCertName = 'rpc.cert';
const chainUser = 'user';
const invoiceMacaroonFileName = 'invoice.macaroon';
const lightningDaemonExecFileName = 'lnd';
const lightningDaemonLogPath = 'logs/';
const lightningSeedPassphrase = 'passphrase';
const lightningTlsCertFileName = 'tls.cert';
const lightningTlsKeyFileName = 'tls.key';
const lightningWalletPassword = 'password';
const lndWalletUnlockerService = 'WalletUnlocker';
const localhost = '127.0.0.1';
const maxSpawnChainDaemonAttempts = 3;
const readMacaroonFileName = 'readonly.macaroon';
const retryCreateSeedCount = 5;
const startPortRange = 7593;
const startWalletTimeoutMs = 4500;

/** Spawn an lnd instance

  {}

  @returns via cbk
  {
    autopilot_lnd: <Autopilot LND GRPC API Object>
    chain_listen_port: <Chain Listen Port Number>
    chain_notifier_lnd: <Chain Notifier LND GRPC API Object>
    chain_rpc_cert: <RPC Cert Path String>
    chain_rpc_pass: <Chain RPC Password String>
    chain_rpc_port: <RPC Port Number>
    chain_rpc_user: <Chain RPC Username String>
    kill: <Stop Function> ({}, err => {})
    listen_ip: <Listen Ip String>
    listen_port: <Listen Port Number>
    lnd: <LND GRPC API Object>
    lnd_cert: <LND Base64 Encoded TLS Certificate String>
    lnd_macaroon: <LND Base64 Encoded Authentication Macaroon String>
    lnd_socket: <LND RPC Socket String>
    mining_key: <Mining Rewards Private Key WIF Encoded String>
    wallet_lnd: <Wallet LND GRPC API Object>
  }
*/
module.exports = ({network}, cbk) => {
  return asyncAuto({
    // Find open ports for the listen, REST and RPC ports
    getPorts: cbk => {
      return asyncMapSeries(['listen', 'rest', 'rpc'], (_, cbk) => {
        const port = startPortRange + Math.round(Math.random() * 2000);

        const stopPort = port + 20000;

        return setTimeout(() => {
          return openPortFinder.getPort({port, stopPort}, cbk);
        },
        50);
      },
      (err, ports) => {
        if (!!err || !Array.isArray(ports) || !ports.length) {
          return cbk([500, 'FailedToFindOpenPorts', err]);
        }

        const [listen, rest, rpc] = ports;

        return cbk(null, {listen, rest, rpc});
      });
    },

    // Make a private key for mining rewards
    miningKey: cbk => {
      const keyPair = ECPair.makeRandom({network: networks.testnet});

      return cbk(null, {
        private_key: keyPair.toWIF(),
        public_key: keyPair.publicKey.toString('hex'),
      });
    },

    // Spawn a backing chain daemon for lnd
    spawnChainDaemon: ['miningKey', ({miningKey}, cbk) => {
      return asyncRetry(maxSpawnChainDaemonAttempts, cbk => {
        return spawnChainDaemon({
          daemon: 'btcd',
          is_tls: true,
          mining_public_key: miningKey.public_key,
        },
        cbk);
      },
      cbk);
    }],

    // Generate a block
    generateBlock: ['spawnChainDaemon', ({spawnChainDaemon}, cbk) => {
      return generateBlocks({
        cert: readFileSync(spawnChainDaemon.rpc_cert),
        count: 1,
        host: localhost,
        pass: chainPass,
        port: spawnChainDaemon.rpc_port,
        user: chainUser,
      },
      cbk);
    }],

    // Spawn LND
    spawnLightningDaemon: [
      'generateBlock',
      'getPorts',
      'spawnChainDaemon',
      ({getPorts, spawnChainDaemon}, cbk) =>
    {
      const {dir} = spawnChainDaemon;

      const daemon = spawn(lightningDaemonExecFileName, [
        '--adminmacaroonpath', join(dir, adminMacaroonFileName),
        '--bitcoin.active',
        '--bitcoin.chaindir', dir,
        '--bitcoin.node', 'btcd',
        '--bitcoin.regtest',
        '--btcd.dir', dir,
        '--btcd.rpccert', join(dir, chainRpcCertName),
        '--btcd.rpchost', `${localhost}:${spawnChainDaemon.rpc_port}`,
        '--btcd.rpcpass', chainPass,
        '--btcd.rpcuser', chainUser,
        '--datadir', dir,
        '--debuglevel', 'trace',
        '--externalip', `${localhost}:${getPorts.listen}`,
        '--invoicemacaroonpath', join(dir, invoiceMacaroonFileName),
        '--listen', `${localhost}:${getPorts.listen}`,
        '--logdir', join(dir, lightningDaemonLogPath),
        '--nobootstrap',
        '--readonlymacaroonpath', join(dir, readMacaroonFileName),
        '--restlisten', `${localhost}:${getPorts.rest}`,
        '--rpclisten', `${localhost}:${getPorts.rpc}`,
        '--tlscertpath', join(dir, lightningTlsCertFileName),
        '--tlskeypath', join(dir, lightningTlsKeyFileName),
      ]);

      daemon.stderr.on('data', data => {});

      let isReady = false;

      daemon.stdout.on('data', data => {
        if (!isReady && /gRPC.proxy.started/.test(data+'')) {
          isReady = true;

          return setTimeout(() => cbk(null, {daemon}), 2000);
        };

        return;
      });

      return;
    }],

    // Get connection to the no-wallet lnd
    nonAuthenticatedLnd: [
      'getPorts',
      'spawnChainDaemon',
      'spawnLightningDaemon',
      ({getPorts, spawnChainDaemon}, cbk) =>
    {
      const {dir} = spawnChainDaemon;

      const cert = readFileSync(join(dir, lightningTlsCertFileName));

      try {
        return cbk(null, lightningDaemon({
          cert: cert.toString('base64'),
          service: lndWalletUnlockerService,
          socket: `${localhost}:${getPorts.rpc}`,
        }));
      } catch (err) {
        return cbk([503, 'FailedToLaunchLightningDaemon', err]);
      }
    }],

    // Create seed
    createSeed: [
      'getPorts',
      'nonAuthenticatedLnd',
      'spawnChainDaemon',
      ({getPorts, nonAuthenticatedLnd, spawnChainDaemon}, cbk) =>
    {
      return asyncRetry(retryCreateSeedCount, cbk => {
        const {dir} = spawnChainDaemon;

        const cert = readFileSync(join(dir, lightningTlsCertFileName));

        const lnd = lightningDaemon({
          cert: cert.toString('base64'),
          service: lndWalletUnlockerService,
          socket: `${localhost}:${getPorts.rpc}`,
        });

        return createSeed({lnd, passphrase: lightningSeedPassphrase}, cbk);
      },
      cbk);
    }],

    // Create wallet
    createWallet: [
      'createSeed',
      'nonAuthenticatedLnd',
      ({createSeed, nonAuthenticatedLnd}, cbk) =>
    {
      return createWallet({
        lnd: nonAuthenticatedLnd,
        passphrase: lightningSeedPassphrase,
        password: lightningWalletPassword,
        seed: createSeed.seed,
      },
      err => {
        if (!!err) {
          return cbk(err);
        }

        return setTimeout(() => cbk(), startWalletTimeoutMs);
      });
    }],

    // Wallet details
    wallet: [
      'createWallet',
      'spawnChainDaemon',
      'getPorts',
      ({getPorts, spawnChainDaemon}, cbk) =>
    {
      const {dir} = spawnChainDaemon;
      const certPath = join(dir, lightningTlsCertFileName);
      const macaroonPath = join(dir, adminMacaroonFileName);

      return cbk(null, {
        cert: readFileSync(certPath).toString('base64'),
        host: `${localhost}:${getPorts.rpc}`,
        macaroon: readFileSync(macaroonPath).toString('base64'),
      });
    }],

    // Wallet LND GRPC API
    lnd: ['wallet', ({wallet}, cbk) => {
      try {
        return cbk(null, lightningDaemon({
          cert: wallet.cert,
          macaroon: wallet.macaroon,
          socket: wallet.host,
        }));
      } catch (err) {
        return cbk([503, 'FailedToInstantiateWalletLnd', err]);
      }
    }],

    // Stop LND
    stopLnd: ['lnd', ({lnd}, cbk) => {
      return stopDaemon({lnd}, cbk);
    }],

    // Restart LND (locked)
    restartLnd: [
      'getPorts',
      'spawnChainDaemon',
      'stopLnd',
      ({getPorts, spawnChainDaemon}, cbk) =>
    {
      const {dir} = spawnChainDaemon;

      const daemon = spawn(lightningDaemonExecFileName, [
        '--adminmacaroonpath', join(dir, adminMacaroonFileName),
        '--bitcoin.active',
        '--bitcoin.chaindir', dir,
        '--bitcoin.node', 'btcd',
        '--bitcoin.regtest',
        '--btcd.dir', dir,
        '--btcd.rpccert', join(dir, chainRpcCertName),
        '--btcd.rpchost', `${localhost}:${spawnChainDaemon.rpc_port}`,
        '--btcd.rpcpass', chainPass,
        '--btcd.rpcuser', chainUser,
        '--datadir', dir,
        '--debuglevel', 'trace',
        '--externalip', `${localhost}:${getPorts.listen}`,
        '--invoicemacaroonpath', join(dir, invoiceMacaroonFileName),
        '--listen', `${localhost}:${getPorts.listen}`,
        '--logdir', join(dir, lightningDaemonLogPath),
        '--nobootstrap',
        '--readonlymacaroonpath', join(dir, readMacaroonFileName),
        '--restlisten', `${localhost}:${getPorts.rest}`,
        '--rpclisten', `${localhost}:${getPorts.rpc}`,
        '--tlscertpath', join(dir, lightningTlsCertFileName),
        '--tlskeypath', join(dir, lightningTlsKeyFileName),
      ]);

      daemon.stderr.on('data', data => {});

      let isReady = false;

      daemon.stdout.on('data', data => {
        if (!isReady && /gRPC.proxy.started/.test(data+'')) {
          isReady = true;

          return setTimeout(() => cbk(null, {daemon}), 2000);
        };

        return;
      });

      return;
    }],

    // Get locked restarted lnd
    restartedLnd: [
      'getPorts',
      'restartLnd',
      'spawnChainDaemon',
      ({getPorts, spawnChainDaemon}, cbk) =>
    {
      const {dir} = spawnChainDaemon;

      const cert = readFileSync(join(dir, lightningTlsCertFileName));

      try {
        return cbk(null, lightningDaemon({
          cert: cert.toString('base64'),
          service: lndWalletUnlockerService,
          socket: `${localhost}:${getPorts.rpc}`,
        }));
      } catch (err) {
        return cbk([503, 'FailedToLaunchLightningDaemon', err]);
      }
    }],

    // Change password
    changePassword: ['restartedLnd', ({restartedLnd}, cbk) => {
      return changePassword({
        current_password: lightningWalletPassword,
        lnd: restartedLnd,
        new_password: 'changed_passphrase',
      },
      cbk);
    }],
  },
  (err, res) => {
    if (!!err) {
      return cbk(err);
    }

    const {lnd} = res;

    const kill = () => {
      res.spawnChainDaemon.daemon.kill();
      res.restartLnd.daemon.kill();

      return;
    };

    process.on('uncaughtException', err => {
      kill();

      setTimeout(() => process.exit(1), 5000);
    });

    return cbk(null, {kill});
  });
};
