import app from "./app";
import { logger } from "./lib/logger";
import { overrideProgramId } from "@workspace/program";
import { startDepositWatcher } from "./routes/vault";
import { startMixPoolWorker } from "./lib/mix-pool-worker";

// Switch program ID based on cluster so devnet (old program) and mainnet (new program)
// both work from the same codebase without rebuilding.
const PROGRAM_ID_DEVNET = "5gbaenRHg2YK6X8WMMQZevD55bJ7fvr4V8E8e1feDt5D";
const PROGRAM_ID_MAINNET = "HyciDEYB9hXdmmLMexTHv2QYDaJmuZr1AF7sipBbVLLH";
const activeCluster = process.env.SOLANA_CLUSTER ?? "mainnet";
if (activeCluster === "devnet") {
  overrideProgramId(PROGRAM_ID_DEVNET);
  logger.info({ programId: PROGRAM_ID_DEVNET }, "Using devnet program ID");
} else {
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
