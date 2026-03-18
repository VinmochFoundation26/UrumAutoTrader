import { Router, type Request, type Response } from "express";
import { getVaultReadContract } from "../onchain/contractInstance.js";

const router = Router();

/**
 * GET /vault/eth-balance/:user
 * Returns user's ETH balance from the vault contract view.
 */
router.get("/eth-balance/:user", async (req: Request, res: Response) => {
  try {
    const vault = getVaultReadContract();

    const userAddress = String(req.params.user || "").trim();
    if (!userAddress) {
      return res.status(400).json({ ok: false, error: "Missing user address" });
    }

    // If your contract method differs, change only this line:
    const bal = await vault.ethBalance(userAddress);

    return res.json({ ok: true, user: userAddress, balance: bal?.toString?.() ?? String(bal) });
  } catch (err: any) {
    return res.status(500).json({
      ok: false,
      error: err?.message ?? String(err),
    });
  }
});

/**
 * Example placeholder route (optional)
 * Remove if unused.
 */
// router.get("/health", (_req: Request, res: Response) => res.json({ ok: true }));

export default router;

