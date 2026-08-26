import { BankModel } from "../bank/bank.model";
import { bankDisplayName as formatBankDisplayName } from "../bank/bank.constants";
import { LiabilityPersonModel } from "../liability/liability-person.model";
import { PlayerModel } from "../player/player.model";

export type BankImportRecord = { id: string; displayName: string; status: string };

export type BankImportMaps = {
  bankByAccountMap: Map<string, BankImportRecord>;
  bankByHolderMap: Map<string, BankImportRecord | "ambiguous">;
};

export type BankImportResolution =
  | { status: "ok"; id: string; displayName: string }
  | { status: "not_found" }
  | { status: "ambiguous" }
  | { status: "inactive"; displayName: string };

export type PersonImportRecord = { id: string; name: string; isActive: boolean };

export type PersonImportResolution =
  | { status: "ok"; id: string; name: string }
  | { status: "not_found" }
  | { status: "inactive"; name: string };

export type ExchangePlayerImportRecord = { id: string; playerIdLabel: string };

export type ExchangePlayerImportMap = Map<string, ExchangePlayerImportRecord | "ambiguous">;

export type ExchangePlayerImportResolution =
  | { status: "ok"; id: string; playerIdLabel: string }
  | { status: "not_found" }
  | { status: "ambiguous" };

function bankDisplayName(b: { holderName: string; bankName: string; accountNumber: string }): string {
  return formatBankDisplayName(b);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function loadBanksForImportIdentifiers(uniqueKeys: string[]): Promise<BankImportMaps> {
  const bankByAccountMap = new Map<string, BankImportRecord>();
  const bankByHolderMap = new Map<string, BankImportRecord | "ambiguous">();

  if (uniqueKeys.length === 0) {
    return { bankByAccountMap, bankByHolderMap };
  }

  const regexPatterns = uniqueKeys.map((n) => new RegExp(`^${escapeRegex(n)}$`, "i"));
  const banks = await BankModel.find({
    $or: [{ accountNumber: { $in: regexPatterns } }, { holderName: { $in: regexPatterns } }],
  }).lean();

  for (const b of banks) {
    const record: BankImportRecord = {
      id: b._id.toString(),
      displayName: bankDisplayName(b),
      status: b.status,
    };
    bankByAccountMap.set(b.accountNumber.trim().toLowerCase(), record);
    const holderKey = b.holderName.trim().toLowerCase();
    if (bankByHolderMap.has(holderKey)) {
      bankByHolderMap.set(holderKey, "ambiguous");
    } else {
      bankByHolderMap.set(holderKey, record);
    }
  }

  return { bankByAccountMap, bankByHolderMap };
}

export async function loadLiabilityPersonsForImportNames(
  uniqueKeys: string[],
): Promise<Map<string, PersonImportRecord>> {
  const personMap = new Map<string, PersonImportRecord>();
  if (uniqueKeys.length === 0) return personMap;

  const regexPatterns = uniqueKeys.map((n) => new RegExp(`^${escapeRegex(n)}$`, "i"));
  const persons = await LiabilityPersonModel.find({ name: { $in: regexPatterns } }).lean();
  for (const p of persons) {
    personMap.set(p.name.trim().toLowerCase(), {
      id: p._id.toString(),
      name: p.name.trim(),
      isActive: p.isActive,
    });
  }
  return personMap;
}

export function resolveBankImportKey(
  key: string,
  bankByAccountMap: Map<string, BankImportRecord>,
  bankByHolderMap: Map<string, BankImportRecord | "ambiguous">,
): BankImportResolution {
  const bankByAcc = bankByAccountMap.get(key);
  const bankByHolder = bankByHolderMap.get(key);

  if (bankByHolder === "ambiguous" && !bankByAcc) {
    return { status: "ambiguous" };
  }

  const bankInfo =
    bankByAcc || (bankByHolder !== "ambiguous" && bankByHolder ? bankByHolder : undefined);

  if (!bankInfo) {
    return { status: "not_found" };
  }
  if (bankInfo.status !== "active") {
    return { status: "inactive", displayName: bankInfo.displayName };
  }
  return { status: "ok", id: bankInfo.id, displayName: bankInfo.displayName };
}

export function resolvePersonImportKey(
  key: string,
  personMap: Map<string, PersonImportRecord>,
): PersonImportResolution {
  const personInfo = personMap.get(key);
  if (!personInfo) {
    return { status: "not_found" };
  }
  if (!personInfo.isActive) {
    return { status: "inactive", name: personInfo.name };
  }
  return { status: "ok", id: personInfo.id, name: personInfo.name };
}

export function buildBankResolutionCache(
  uniqueKeys: string[],
  maps: BankImportMaps,
): Map<string, BankImportResolution> {
  const cache = new Map<string, BankImportResolution>();
  for (const key of uniqueKeys) {
    cache.set(key, resolveBankImportKey(key, maps.bankByAccountMap, maps.bankByHolderMap));
  }
  return cache;
}

export function buildPersonResolutionCache(
  uniqueKeys: string[],
  personMap: Map<string, PersonImportRecord>,
): Map<string, PersonImportResolution> {
  const cache = new Map<string, PersonImportResolution>();
  for (const key of uniqueKeys) {
    cache.set(key, resolvePersonImportKey(key, personMap));
  }
  return cache;
}

export async function loadPlayersForImportPlayerIds(uniqueKeys: string[]): Promise<ExchangePlayerImportMap> {
  const playerMap: ExchangePlayerImportMap = new Map();
  if (uniqueKeys.length === 0) return playerMap;

  const regexPatterns = uniqueKeys.map((n) => new RegExp(`^${escapeRegex(n)}$`, "i"));
  const players = await PlayerModel.find({ playerId: { $in: regexPatterns } })
    .select({ playerId: 1 })
    .lean();

  for (const p of players) {
    const key = p.playerId.trim().toLowerCase();
    const record: ExchangePlayerImportRecord = {
      id: p._id.toString(),
      playerIdLabel: p.playerId.trim(),
    };
    if (playerMap.has(key)) {
      playerMap.set(key, "ambiguous");
    } else {
      playerMap.set(key, record);
    }
  }
  return playerMap;
}

export function resolveExchangePlayerImportKey(
  key: string,
  playerMap: ExchangePlayerImportMap,
): ExchangePlayerImportResolution {
  const entry = playerMap.get(key);
  if (entry === "ambiguous") {
    return { status: "ambiguous" };
  }
  if (!entry) {
    return { status: "not_found" };
  }
  return { status: "ok", id: entry.id, playerIdLabel: entry.playerIdLabel };
}

export function buildExchangePlayerResolutionCache(
  uniqueKeys: string[],
  playerMap: ExchangePlayerImportMap,
): Map<string, ExchangePlayerImportResolution> {
  const cache = new Map<string, ExchangePlayerImportResolution>();
  for (const key of uniqueKeys) {
    cache.set(key, resolveExchangePlayerImportKey(key, playerMap));
  }
  return cache;
}
