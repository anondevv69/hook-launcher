// trade-entry.mjs — the in-browser Hook Trader. Exposes createHookTrade():
// a faithful port of hook.mjs's trade path (the site's hooks/hook.mjs is the
// reference implementation) for the human trade page:
//
//   ctxFromRecord(rec)   — hook.mjs ctx(): PDAs + ATAs derived from a launch
//                          record (configPda / holderPda / regPda / ata /
//                          claimPda), programs from the record.
//   buildRegisterTx      — hook.mjs registerIx: Registry data [0, kind],
//                          kind byte 0 = Human, 1 = Agent.
//   buildSyncTx          — hook.mjs syncIx: engine SyncRegistered, data
//                          [4, 0], registration PDA appended at key 6.
//   buildCreateAtaTx     — the destination ATA creation. hook.mjs doSwap
//                          sends this as its OWN transaction BEFORE the
//                          swap build whenever the ATA is missing: under
//                          the v2 engine, build-time meta resolution read
//                          the destination token account. The v3 engine
//                          (AccountKey lists) no longer needs it for
//                          resolution, but the page keeps the order —
//                          the account must exist to receive, and
//                          creating it first is what generic routers do.
//   buildSwapTx          — hook.mjs doSwap: client.pool.swap2WithTransferHook
//                          (SwapMode.ExactIn, swapBaseForQuote = !isBuy,
//                          minimumAmountOut 0), with settlesFor prepended:
//                          for distributor tokens BOTH sides settle in the
//                          same transaction, BEFORE the transfer, on
//                          pre-transfer balances (settleIx data [3], hook
//                          extras for the payout transfer appended at [9..],
//                          resolved exactly like hook.mjs hookExtras).
//
// No signing here: the page's connected wallet signs, mirroring the launch
// page's sender (processed blockhash, skipPreflight, status polling).
import './shim.mjs';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction,
  createTransferCheckedWithTransferHookInstruction, TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import BN from 'bn.js';
import { DynamicBondingCurveClient, SwapMode } from '@meteora-ag/dynamic-bonding-curve-sdk';

const T22 = TOKEN_2022_PROGRAM_ID;
const K = (pubkey, w, s) => ({ pubkey, isSigner: !!s, isWritable: !!w });

export function createHookTrade() {
  function ctxFromRecord(rec) {
    const P = (s) => new PublicKey(s);
    const programs = {
      engine: P(rec.programs.engine), registry: P(rec.programs.registry),
      distributor: P(rec.programs.distributor), dbc: P(rec.programs.dbc),
    };
    const mint = P(rec.addresses.mint);
    const pdaE = (seeds) => PublicKey.findProgramAddressSync(seeds, programs.engine)[0];
    return {
      rec, programs, mint, decimals: rec.decimals ?? 6,
      pool: P(rec.addresses.pool), poolAuthority: P(rec.addresses.poolAuthority),
      baseVault: P(rec.addresses.baseVault), quoteVault: P(rec.addresses.quoteVault),
      dbcConfig: P(rec.addresses.dbcConfig),
      configPda: pdaE([Buffer.from('config'), mint.toBuffer()]),
      pricePda: rec.addresses.priceFeed ? P(rec.addresses.priceFeed) : pdaE([Buffer.from('price'), mint.toBuffer()]),
      // ENGINE v3 (deployed 2026-10-16, window 2): holder records are
      // keyed by the TOKEN ACCOUNT, not the owner — the record for a
      // wallet lives at ["holder", mint, ata(owner)]. (Pre-v3 this
      // derived from the owner directly; the v3 upgrade flipped the
      // derivation and migrated every live record — see
      // deploy/DEPLOY-RECORD-V3.md.)
      holderPda: (owner) => pdaE([Buffer.from('holder'), mint.toBuffer(), getAssociatedTokenAddressSync(mint, owner, true, T22).toBuffer()]),
      distState: rec.addresses.distributor ? P(rec.addresses.distributor.state) : null,
      distVault: rec.addresses.distributor ? P(rec.addresses.distributor.vault) : null,
      claimPda: (holder) => PublicKey.findProgramAddressSync([Buffer.from('claim'), mint.toBuffer(), holder.toBuffer()], programs.distributor)[0],
      regPda: (wallet) => PublicKey.findProgramAddressSync([Buffer.from('registration'), wallet.toBuffer()], programs.registry)[0],
      ata: (owner) => getAssociatedTokenAddressSync(mint, owner, true, T22),
      rules: rec.rules ?? [],
    };
  }

  // ---------- instruction builders (byte-for-byte hook.mjs) ----------
  const registerIx = (c, walletPk, kind) => new TransactionInstruction({
    programId: c.programs.registry, data: Buffer.from([0, kind]),
    keys: [K(walletPk, true, true), K(c.regPda(walletPk), true), K(SystemProgram.programId)],
  });
  const syncIx = (c, walletPk) => new TransactionInstruction({
    programId: c.programs.engine, data: Buffer.from([4, 0]),
    keys: [K(walletPk, true, true), K(c.mint), K(c.configPda), K(walletPk), K(c.holderPda(walletPk), true), K(SystemProgram.programId), K(c.regPda(walletPk))],
  });

  const tokenAcctRaw = async (conn, acct) => {
    const info = await conn.getAccountInfo(acct);
    return info ? info.data.readBigUInt64LE(64) : 0n;
  };
  async function hookExtras(c, conn, source, dest, authority, amount) {
    const ix = await createTransferCheckedWithTransferHookInstruction(conn, source, c.mint, dest, authority, amount, c.decimals, [], 'confirmed', T22);
    return ix.keys.slice(4).map(k => K(k.pubkey, k.isWritable, false));
  }
  const settleIx = async (c, conn, payerPk, holder, holderAta) => new TransactionInstruction({
    programId: c.programs.distributor, data: Buffer.from([3]),
    keys: [K(payerPk, true, true), K(holder), K(holderAta, true), K(c.mint), K(c.distState, true), K(c.distVault, true), K(c.claimPda(holder), true), K(T22), K(SystemProgram.programId),
      ...(await hookExtras(c, conn, c.distVault, holderAta, c.distState, await tokenAcctRaw(conn, holderAta)))],
  });
  async function settlesFor(c, conn, payerPk, counterparty) {
    if (!c.distState) return [];
    return [
      await settleIx(c, conn, payerPk, payerPk, c.ata(payerPk)),
      await settleIx(c, conn, payerPk, counterparty, counterparty.equals(c.poolAuthority) ? c.baseVault : c.ata(counterparty)),
    ];
  }

  // ---------- transaction builders (hook.mjs doSwap order preserved) ----------
  function buildRegisterTx(c, walletPk, kind) {
    return new Transaction().add(registerIx(c, walletPk, kind));
  }
  function buildSyncTx(c, walletPk) {
    return new Transaction().add(syncIx(c, walletPk));
  }
  async function ataExists(c, conn, walletPk) {
    return !!(await conn.getAccountInfo(c.ata(walletPk)));
  }
  function buildCreateAtaTx(c, walletPk) {
    return new Transaction().add(createAssociatedTokenAccountInstruction(walletPk, c.ata(walletPk), walletPk, c.mint, T22));
  }
  async function buildSwapTx(c, conn, walletPk, isBuy, rawIn) {
    // Caller guarantees the ATA exists (hook.mjs creates it in its own tx
    // first — build-time meta resolution reads the destination account).
    const client = new DynamicBondingCurveClient(conn, 'confirmed');
    const tx = await client.pool.swap2WithTransferHook({
      swapMode: SwapMode.ExactIn, swapBaseForQuote: !isBuy,
      amountIn: new BN(rawIn.toString()), minimumAmountOut: new BN(0),
      owner: walletPk, pool: c.pool, referralTokenAccount: null, payer: walletPk,
    });
    const pre = await settlesFor(c, conn, walletPk, c.poolAuthority);
    if (pre.length) tx.instructions = [...pre, ...tx.instructions];
    return tx;
  }

  return {
    web3: { Connection, PublicKey, Keypair, Transaction, TransactionInstruction, SystemProgram, LAMPORTS_PER_SOL },
    ctxFromRecord, buildRegisterTx, buildSyncTx, ataExists, buildCreateAtaTx, buildSwapTx,
    registerIx, syncIx, settlesFor,
  };
}
