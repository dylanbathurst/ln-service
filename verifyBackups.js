const {promisify} = require('util');

const {verifyBackups} = require('./');

/** Verify a set of aggregated channel backups

  {
    backup: <Multi-Backup Hex String>
    channels: [{
      transaction_id: <Transaction Id String>
      transaction_vout: <Transaction Output Index Number>
    }]
    lnd: <LND GRPC API Object>
  }

  @returns via Promise
  {
    is_valid: <Backup is Valid Bool>
  }
*/
module.exports = promisify(verifyBackups);
