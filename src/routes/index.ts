import { Router, type IRouter } from "express";
import healthRouter from "./health";
import statusRouter from "./status";
import statsRouter from "./stats";
import rpcRouter from "./rpc";
import portfolioRouter from "./portfolio";
import transactionsRouter from "./transactions";
import relayRouter from "./relay";
import vaultRouter from "./vault";
import vaultBalancesRouter from "./vault_balances";
import stealthRouter from "./stealth";
import airsignRouter from "./airsign";
import relayInfoRouter from "./relay-info";
import developerRouter from "./developer";
import mixRouter from "./mix";
import baseVaultRouter from "./base-vault";
import ethereumVaultRouter from "./ethereum-vault";

const router: IRouter = Router();

router.use(healthRouter);
router.use(statusRouter);
router.use(statsRouter);
router.use(rpcRouter);
router.use(portfolioRouter);
router.use(transactionsRouter);
router.use(relayRouter);
router.use(vaultRouter);
router.use(vaultBalancesRouter);
router.use(stealthRouter);
router.use(airsignRouter);
router.use(relayInfoRouter);
router.use(developerRouter);
router.use(mixRouter);
router.use(baseVaultRouter);
router.use(ethereumVaultRouter);

export default router;
