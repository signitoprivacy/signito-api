import app from "./app";
import { logger } from "./lib/logger";
import { overrideProgramId } from "@workspace/program";
import { startDepositWatcher } from "./routes/vault";
import { startMixPoolWorker } from "./lib/mix-pool-worker";
import {
  getActiveSolanaProgramId,
  getSolanaCluster,
  SOLANA_DEVNET_PROGRAM_ID,
} from "./lib/solana-program";

// Switch program ID based on cluster so devnet (old program) and mainnet (new program)
// both work from the same codebase without rebuilding.
const PROGRAM_ID_MAINNET = getActiveSolanaProgramId();
const activeCluster = getSolanaCluster();
if (activeCluster === "devnet") {
  overrideProgramId(SOLANA_DEVNET_PROGRAM_ID);
  logger.info({ programId: SOLANA_DEVNET_PROGRAM_ID }, "Using devnet program ID");
} else {
  overrideProgramId(PROGRAM_ID_MAINNET);
  logger.info({ programId: PROGRAM_ID_MAINNET }, "Using mainnet program ID");
}

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  startDepositWatcher();
  startMixPoolWorker();
});
