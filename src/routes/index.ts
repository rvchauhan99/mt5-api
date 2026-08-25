import { Router } from "express";
import { authRouter } from "../modules/auth/auth.route";
import { bankRouter } from "../modules/bank/bank.route";
import { depositRouter } from "../modules/deposit/deposit.route";
import { exchangeRouter } from "../modules/exchange/exchange.route";
import { exchangeTopupRouter } from "../modules/exchange-topup/exchange-topup.route";
import { historyRouter } from "../modules/history/history.route";
import { reportsRouter } from "../modules/reports/reports.route";
import { userRouter } from "../modules/users/user.route";
import { withdrawalRouter } from "../modules/withdrawal/withdrawal.route";
import { playerRouter } from "../modules/player/player.route";
import { mastersRouter } from "../modules/masters/masters.route";
import { expenseRouter } from "../modules/expense/expense.route";
import { reasonRouter } from "../modules/reason/reason.route";
import { liabilityRouter } from "../modules/liability/liability.route";
import { lookupRouter } from "../modules/lookup/lookup.route";
import { referralRouter } from "../modules/referral/referral.route";
import { settingsRouter } from "../modules/settings/settings.route";
import { collectRouteMetrics } from "../shared/observability/performance-metrics";
import { evaluatePerformanceGates } from "../shared/observability/performance-gates";

const apiRouter = Router();

apiRouter.get("/health", (_req, res) => {
  res.status(200).json({ success: true, data: { status: "ok" } });
});
apiRouter.get("/metrics", (_req, res) => {
  res.status(200).json({
    success: true,
    data: {
      routes: collectRouteMetrics(),
      gates: evaluatePerformanceGates(),
      generatedAt: new Date().toISOString(),
    },
  });
});
apiRouter.use("/auth", authRouter);
apiRouter.use("/exchange", exchangeRouter);
apiRouter.use("/exchange-topup", exchangeTopupRouter);
apiRouter.use("/players", playerRouter);
apiRouter.use("/bank", bankRouter);
apiRouter.use("/deposit", depositRouter);
apiRouter.use("/withdrawal", withdrawalRouter);
apiRouter.use("/users", userRouter);
apiRouter.use("/reports", reportsRouter);
apiRouter.use("/history", historyRouter);
apiRouter.use("/masters", mastersRouter);
apiRouter.use("/expense", expenseRouter);
apiRouter.use("/reasons", reasonRouter);
apiRouter.use("/liability", liabilityRouter);
apiRouter.use("/lookup", lookupRouter);
apiRouter.use("/referral", referralRouter);
apiRouter.use("/settings", settingsRouter);

export { apiRouter };
